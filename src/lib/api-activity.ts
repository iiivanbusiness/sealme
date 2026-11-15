import { prisma } from "@/lib/db";
import { CALL_OUTCOMES, UNREACHED_OUTCOMES } from "@/lib/call-outcomes";
import { stageAfterOutcome } from "@/lib/cold-call";
import { normalizePhone } from "@/lib/phone";
import { isValidDay, isValidTime, isValidTimeZone, TASK_PRIORITIES } from "@/lib/tasks";
import { notifyTasksAssigned } from "@/lib/task-notify";
import { dispatchCallCompleted, dispatchLeadsUpdated, dispatchMeetingsBooked, dispatchTasksCompleted, leadChanges } from "@/lib/webhook-events";
import { INACTIVE_STAGES, refreshLeadPipeline } from "@/lib/lead-pipeline";
import type { Lead } from "@/generated/prisma/client";

// Calls and meetings another system sends in through the API (an agency's
// dialer, its CRM), and the shapes calls and tasks come back out in.

const appLink = (path: string) => `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.sealme.net"}${path}`;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const has = (body: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(body, k);

function text(body: Record<string, unknown>, k: string, max: number): string | null {
  const v = body[k];
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v.trim().slice(0, max) || null : null;
}

type Failure = { status: number; error: string };

// The lead a request is about, by SealMe's id or by their own.
export async function findApiLead(workspaceId: string, body: Record<string, unknown>): Promise<{ lead: Lead } | Failure> {
  const leadId = text(body, "leadId", 100);
  const leadExternalId = text(body, "leadExternalId", 200);
  if (!leadId && !leadExternalId) return { status: 400, error: "Send leadId, or leadExternalId (your id for the lead)" };
  const lead = await prisma.lead.findFirst({ where: { workspaceId, ...(leadId ? { id: leadId } : { externalId: leadExternalId }) } });
  return lead ? { lead } : { status: 404, error: "Lead not found" };
}

type Rep = { id: string; name: string; timezone: string | null };

// Who made the call or takes the meeting: repEmail when sent, otherwise
// whoever owns the lead. Null when neither: the call or meeting is saved
// without a rep (a sandbox has no users at all).
export async function findApiRep(workspaceId: string, body: Record<string, unknown>, ownerId: string | null): Promise<{ rep: Rep | null } | Failure> {
  const email = text(body, "repEmail", 254);
  const select = { id: true, name: true, timezone: true } as const;
  if (email) {
    const rep = await prisma.user.findFirst({ where: { workspaceId, email: { equals: email, mode: "insensitive" }, deactivatedAt: null }, select });
    return rep ? { rep } : { status: 400, error: "\"repEmail\" doesn't match anyone active in this workspace" };
  }
  const owner = ownerId ? await prisma.user.findFirst({ where: { id: ownerId, workspaceId, deactivatedAt: null }, select }) : null;
  return { rep: owner };
}

export const MAX_API_TRANSCRIPT_CHARS = 400_000;
const MAX_CALL_SECONDS = 4 * 60 * 60;

export type CallInput = {
  externalId: string | null;
  outcome: string | null;
  summary: string | null;
  transcript: string | null;
  recordingUrl: string | null;
  startedAt: Date;
  durationSec: number | null;
  kind: "cold" | "sales" | null;
  toNumber: string | null;
};

export function parseCallInput(body: Record<string, unknown>): { data: CallInput } | { error: string } {
  const outcome = text(body, "outcome", 40);
  if (outcome && !(CALL_OUTCOMES as readonly string[]).includes(outcome)) return { error: `"outcome" must be one of ${CALL_OUTCOMES.join(", ")}` };

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() || null : null;
  if (transcript && transcript.length > MAX_API_TRANSCRIPT_CHARS) return { error: `"transcript" can be up to ${MAX_API_TRANSCRIPT_CHARS.toLocaleString("en-US")} characters` };

  const recordingUrl = text(body, "recordingUrl", 2000);
  if (recordingUrl) {
    let url: URL | null = null;
    try {
      url = new URL(recordingUrl);
    } catch {}
    if (!url || url.protocol !== "https:") return { error: "\"recordingUrl\" must be an https link SealMe can download the recording from" };
  }
  if (!outcome && !transcript && !recordingUrl) return { error: "Send an outcome, or a transcript or recordingUrl for SealMe to write the call up from" };

  let startedAt = new Date();
  if (has(body, "startedAt") && body.startedAt !== null) {
    startedAt = new Date(String(body.startedAt));
    if (typeof body.startedAt !== "string" || Number.isNaN(startedAt.getTime())) return { error: "\"startedAt\" must be an ISO 8601 date and time" };
    if (startedAt.getTime() > Date.now() + 5 * 60_000) return { error: "\"startedAt\" is in the future" };
  }

  let durationSec: number | null = null;
  if (has(body, "durationSec") && body.durationSec !== null) {
    const n = Number(body.durationSec);
    if (!Number.isFinite(n) || n < 0 || n > MAX_CALL_SECONDS) return { error: "\"durationSec\" must be a number of seconds, up to 4 hours" };
    durationSec = Math.round(n);
  }

  const kind = text(body, "kind", 10);
  if (kind && kind !== "cold" && kind !== "sales") return { error: "\"kind\" must be cold or sales" };

  const toNumber = text(body, "toNumber", 50);
  return {
    data: {
      externalId: text(body, "externalId", 200),
      outcome,
      summary: text(body, "summary", 4000),
      transcript,
      recordingUrl,
      startedAt,
      durationSec,
      kind: (kind as "cold" | "sales" | null) ?? null,
      toNumber: toNumber ? (normalizePhone(toNumber) ?? toNumber) : null,
    },
  };
}

// A call or meeting logged here is activity, the same as a SealMe call: the
// lead isn't idle, and one set aside (lost, not now, unsigned) is active
// again. Only when it's the lead's newest activity: an older call sent in
// late is history, and a lead marked lost since then stays lost. "new" is
// just a starting point: the caller works the real stage out after
// (refreshLeadPipeline), since a proposal or contract may still be out.
export function revived(lead: Pick<Lead, "lastActivityAt" | "pipelineStage">, at: Date): { lastActivityAt?: Date; pipelineStage?: string } {
  const newest = !lead.lastActivityAt || lead.lastActivityAt < at;
  return {
    ...(newest ? { lastActivityAt: at } : {}),
    ...(newest && INACTIVE_STAGES.includes(lead.pipelineStage) ? { pipelineStage: "new" } : {}),
  };
}

// A call another dialer made, with just its outcome: saved to the lead's
// history, the lead moves on as it would after a SealMe call, and the
// rep's open call task on the lead is done.
export async function logCallOutcome(o: { workspaceId: string; lead: Lead; repId: string | null; input: CallInput & { outcome: string } }): Promise<string> {
  const { workspaceId, lead, repId, input } = o;
  const now = new Date();
  const reached = !UNREACHED_OUTCOMES.has(input.outcome);
  const stage = stageAfterOutcome(lead.stage, input.outcome);
  // Not interested takes the lead off Active, the same as stage lost through
  // PATCH (and the call doesn't bring it back). A client stays a client, and
  // an older call sent in late doesn't outweigh what happened since.
  const lost = input.outcome === "not_interested" && (stage ?? lead.stage) === "lost" && !lead.isClient && (!lead.lastActivityAt || lead.lastActivityAt <= input.startedAt);
  const wake = revived(lead, input.startedAt);
  const leadData = {
    ...(stage ? { stage } : {}),
    ...(reached && (!lead.lastContactedAt || lead.lastContactedAt < input.startedAt) ? { lastContactedAt: input.startedAt } : {}),
    ...(input.summary ? { summary: input.summary } : {}),
    ...wake,
    // A lost lead the call brings back is contacted for the API, as after
    // Reactivate, unless the outcome moved it further.
    ...(lost ? { pipelineStage: "lost" } : !stage && wake.pipelineStage && lead.stage === "lost" ? { stage: "contacted" } : {}),
  };
  const closable = repId
    ? await prisma.task.findFirst({
        where: { leadId: lead.id, assigneeId: repId, status: "open", type: { in: ["cold_call", "follow_up"] } },
        orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
        select: { id: true },
      })
    : null;

  const [call] = await prisma.$transaction([
    prisma.phoneCall.create({
      data: {
        workspaceId,
        userId: repId,
        leadId: lead.id,
        source: "api",
        mode: input.kind ?? "cold",
        status: "processed",
        outcome: input.outcome,
        connected: reached,
        summary: input.summary,
        toNumber: input.toNumber ?? lead.phone,
        durationSec: input.durationSec,
        startedAt: input.startedAt,
        endedAt: input.durationSec !== null ? new Date(input.startedAt.getTime() + input.durationSec * 1000) : null,
        processedAt: now,
        externalId: input.externalId,
      },
      select: { id: true },
    }),
    prisma.lead.update({ where: { id: lead.id }, data: leadData }),
    ...(closable ? [prisma.task.update({ where: { id: closable.id }, data: { status: "done", completedAt: now } })] : []),
  ]);

  // Active again: the stage its documents put it at (a proposal still out
  // shows Proposal sent, not New), as after a SealMe call. Lost stays lost,
  // unless a contract was signed meanwhile: then it's back on Clients.
  if (leadData.pipelineStage) await refreshLeadPipeline(lead.id);
  await dispatchLeadsUpdated(workspaceId, [leadChanges(lead.id, lead, leadData)]);
  await dispatchCallCompleted(workspaceId, call.id);
  if (closable) await dispatchTasksCompleted(workspaceId, [closable.id], { callId: call.id });
  return call.id;
}

export type MeetingInput = { date: string; time: string | null; timeZone: string | null; note: string | null; externalId: string | null };

export function parseMeetingInput(body: Record<string, unknown>): { data: MeetingInput } | { error: string } {
  const date = text(body, "date", 10);
  if (!date || !isValidDay(date)) return { error: "\"date\" is required, like 2026-10-20" };
  const time = text(body, "time", 5);
  if (time && !isValidTime(time)) return { error: "\"time\" must be like 14:30" };
  const timeZone = text(body, "timeZone", 64);
  if (timeZone && !isValidTimeZone(timeZone)) return { error: "\"timeZone\" must be an IANA time zone, like America/New_York" };
  return { data: { date, time, timeZone, note: text(body, "note", 1000), externalId: text(body, "externalId", 200) } };
}

// A meeting someone booked outside SealMe: a sales call on the rep's day,
// the lead moved to Meeting, and the rep told about it.
export async function bookMeeting(o: {
  workspaceId: string;
  lead: Lead;
  rep: Rep | null;
  input: MeetingInput;
  actorName: string;
}): Promise<string> {
  const { workspaceId, lead, rep, input } = o;
  const timeZone = input.timeZone ?? (rep?.timezone && isValidTimeZone(rep.timezone) ? rep.timezone : "America/New_York");
  const dueDate = new Date(`${input.date}T00:00:00Z`);
  const stage = stageAfterOutcome(lead.stage, "meeting_booked");
  const leadData = {
    ...(stage ? { stage } : {}),
    // Nobody had it yet: the rep taking the meeting does now.
    ...(lead.ownerId || !rep ? {} : { ownerId: rep.id }),
    nextStep: input.note ?? "Meeting",
    nextStepAt: dueDate,
    ...revived(lead, new Date()),
  };

  const [task] = await prisma.$transaction([
    prisma.task.create({
      data: { workspaceId, leadId: lead.id, assigneeId: rep?.id ?? null, type: "sales_call", dueDate, dueTime: input.time, timezone: timeZone, note: input.note, externalId: input.externalId },
      select: { id: true },
    }),
    prisma.lead.update({ where: { id: lead.id }, data: leadData }),
  ]);
  if (leadData.pipelineStage) await refreshLeadPipeline(lead.id);

  if (rep) await notifyTasksAssigned({ workspaceId, assigneeId: rep.id, actorName: o.actorName, count: 1, type: "sales_call", dueDate, dueTime: input.time, lead: { id: lead.id, name: lead.name } });
  await dispatchLeadsUpdated(workspaceId, [leadChanges(lead.id, lead, leadData)]);
  await dispatchMeetingsBooked(workspaceId, [{ leadId: lead.id, repId: rep?.id ?? null, date: input.date, time: input.time, timeZone, source: "api", taskId: task.id }]);
  return task.id;
}

export type TaskPatch = { dueDate?: Date; dueTime?: string | null; timezone?: string; note?: string | null; status?: "open" | "done" | "skipped"; priority?: string };

// PATCH /tasks/{id}: only the keys sent; null clears time and note.
export function parseTaskPatch(body: Record<string, unknown>): { data: TaskPatch } | { error: string } {
  const data: TaskPatch = {};
  if (has(body, "date")) {
    const date = text(body, "date", 10);
    if (!date || !isValidDay(date)) return { error: "\"date\" must be like 2026-10-20" };
    data.dueDate = new Date(`${date}T00:00:00Z`);
  }
  if (has(body, "time")) {
    const time = text(body, "time", 5);
    if (time && !isValidTime(time)) return { error: "\"time\" must be like 14:30" };
    data.dueTime = time;
  }
  if (has(body, "timeZone")) {
    const tz = text(body, "timeZone", 64);
    if (!tz || !isValidTimeZone(tz)) return { error: "\"timeZone\" must be an IANA time zone, like America/New_York" };
    data.timezone = tz;
  }
  if (has(body, "note")) data.note = text(body, "note", 1000);
  if (has(body, "status")) {
    const status = text(body, "status", 10);
    if (status !== "open" && status !== "done" && status !== "skipped") return { error: "\"status\" must be open, done or skipped" };
    data.status = status;
  }
  if (has(body, "priority")) {
    const priority = text(body, "priority", 10);
    if (!priority || !(TASK_PRIORITIES as readonly string[]).includes(priority)) return { error: `"priority" must be one of ${TASK_PRIORITIES.join(", ")}` };
    data.priority = priority;
  }
  return { data };
}

export const CALL_API_SELECT = {
  id: true,
  externalId: true,
  leadId: true,
  dealId: true,
  status: true,
  mode: true,
  source: true,
  outcome: true,
  connected: true,
  summary: true,
  notes: true,
  toNumber: true,
  recorded: true,
  durationSec: true,
  extracted: true,
  startedAt: true,
  endedAt: true,
  processedAt: true,
  updatedAt: true,
  lead: { select: { externalId: true, campaign: true, name: true } },
  user: { select: { name: true, email: true } },
} as const;

type CallRow = {
  id: string;
  externalId: string | null;
  leadId: string | null;
  dealId: string | null;
  status: string;
  mode: string;
  source: string;
  outcome: string | null;
  connected: boolean;
  summary: string | null;
  notes: string | null;
  toNumber: string | null;
  recorded: boolean;
  durationSec: number | null;
  extracted: unknown;
  startedAt: Date;
  endedAt: Date | null;
  processedAt: Date | null;
  updatedAt: Date;
  lead: { externalId: string | null; campaign: string | null; name: string } | null;
  user: { name: string; email: string } | null;
  transcript?: string | null;
};

export function serializeCall(c: CallRow) {
  const skipped = c.status === "skipped" && c.extracted && typeof c.extracted === "object" ? (c.extracted as { skipped?: unknown }).skipped : null;
  return {
    id: c.id,
    externalId: c.externalId,
    leadId: c.leadId,
    leadExternalId: c.lead?.externalId ?? null,
    leadName: c.lead?.name ?? null,
    campaign: c.lead?.campaign ?? null,
    dealId: c.dealId,
    status: c.status,
    kind: c.mode === "cold" || c.mode === "sales" ? c.mode : null,
    outcome: c.outcome,
    connected: c.connected,
    skipReason: typeof skipped === "string" ? skipped : null,
    summary: c.summary,
    notes: c.notes,
    source: c.source,
    toNumber: c.toNumber,
    recorded: c.recorded,
    durationSec: c.durationSec,
    rep: c.user ? { name: c.user.name, email: c.user.email } : null,
    ...(c.transcript !== undefined ? { transcript: c.transcript } : {}),
    url: c.leadId ? appLink(`/leads/${c.leadId}`) : null,
    startedAt: c.startedAt.toISOString(),
    endedAt: iso(c.endedAt),
    processedAt: iso(c.processedAt),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export const TASK_API_SELECT = {
  id: true,
  externalId: true,
  type: true,
  status: true,
  leadId: true,
  dealId: true,
  dueDate: true,
  dueTime: true,
  timezone: true,
  priority: true,
  note: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  lead: { select: { externalId: true, campaign: true, name: true } },
  assignee: { select: { name: true, email: true } },
} as const;

type TaskRow = {
  id: string;
  externalId: string | null;
  type: string;
  status: string;
  leadId: string | null;
  dealId: string | null;
  dueDate: Date;
  dueTime: string | null;
  timezone: string;
  priority: string;
  note: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lead: { externalId: string | null; campaign: string | null; name: string } | null;
  assignee: { name: string; email: string } | null;
};

export function serializeTask(t: TaskRow) {
  return {
    id: t.id,
    externalId: t.externalId,
    type: t.type,
    status: t.status,
    leadId: t.leadId,
    leadExternalId: t.lead?.externalId ?? null,
    leadName: t.lead?.name ?? null,
    campaign: t.lead?.campaign ?? null,
    dealId: t.dealId,
    assignee: t.assignee ? { name: t.assignee.name, email: t.assignee.email } : null,
    date: day(t.dueDate),
    time: t.dueTime,
    timeZone: t.timezone,
    priority: t.priority,
    note: t.note,
    completedAt: iso(t.completedAt),
    url: t.leadId ? appLink(`/leads/${t.leadId}`) : t.dealId ? appLink(`/deals/${t.dealId}`) : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
