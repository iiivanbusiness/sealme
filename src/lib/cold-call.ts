import { prisma } from "@/lib/db";
import { extractColdCall } from "@/lib/extract-cold-call";
import { UNREACHED_OUTCOMES } from "@/lib/call-outcomes";
import { normalizePhone } from "@/lib/phone";
import { isValidDay } from "@/lib/tasks";
import { dayInZone } from "@/lib/viewer-time";
import { dispatchCallCompleted, dispatchLeadsUpdated, dispatchMeetingsBooked, dispatchTasksCompleted, leadChanges } from "@/lib/webhook-events";
import { findLeadForCall, mergeList } from "@/lib/lead-match";
import { refreshLeadOverview } from "@/lib/lead-overview";
import { INACTIVE_STAGES, refreshLeadPipeline, wentOutWhere } from "@/lib/lead-pipeline";
import type { Lead } from "@/generated/prisma/client";

const STAGE_ORDER: Record<string, number> = { new: 0, contacted: 1, interested: 2, meeting: 3 };
const TARGET_STAGE: Record<string, string> = {
  meeting_booked: "meeting",
  interested: "interested",
  follow_up: "contacted",
  wrong_person: "contacted",
  not_interested: "lost",
};

// A lead made from a call before anyone knows who it was with ("New lead
// from this call" in the Calls inbox); the call fills in the real name.
export const NEW_LEAD_NAME = "New lead from a call";

// The client a document made during a call goes to while that lead has no
// name yet (see live-call.ts); the call renames it once it hears one.
export const PLACEHOLDER_CLIENT = "New client";

// The stage a call's outcome moves a lead to, if any. Stage only moves
// forward (or to lost), and a converted lead stays put.
export function stageAfterOutcome(current: string, outcome: string): string | null {
  const target = TARGET_STAGE[outcome];
  if (!target || current === "converted" || target === current) return null;
  if (target === "lost" || current === "lost" || (STAGE_ORDER[target] ?? 0) > (STAGE_ORDER[current] ?? 0)) return target;
  return null;
}

// Where a call leaves the lead it's on, when it's the lead's newest activity.
// "Not interested" takes the lead off Active, the way Mark as lost does (a
// client stays a client). Any other call makes a lead someone set aside
// (lost, not now) or whose contract went unsigned active again, and a lost
// one is "contacted" for the API then, as after Reactivate, unless the
// outcome moved it further.
export function leadAfterCall(lead: Pick<Lead, "stage" | "pipelineStage" | "isClient">, outcome: string | null): { stage?: string; pipelineStage?: string } {
  const stage = outcome ? stageAfterOutcome(lead.stage, outcome) : null;
  const moved = stage ? { stage } : {};
  if (outcome === "not_interested" && !lead.isClient && lead.stage !== "converted") return { ...moved, pipelineStage: "lost" };
  if (INACTIVE_STAGES.includes(lead.pipelineStage)) return { ...(stage || lead.stage !== "lost" ? moved : { stage: "contacted" }), pipelineStage: "new" };
  return moved;
}

export type ColdCallSummary = {
  outcome: string;
  stage: string | null; // the stage it moved to, if it moved
  closedTask: string | null; // the kind of task it marked done
  followUp: { type: string; date: string; time: string | null } | null;
  costUsd: number;
  callId: string; // the saved call, for logging it to the lead's CRM
  // The lead the call ended up on: the one given, or the lead already on
  // file it turned out to be with (matched true).
  leadId: string;
  leadName: string;
  matched: boolean;
};

type ApplyColdCall = {
  workspaceId: string;
  // Whose call it was: their open task closes, follow-ups go to them. Null
  // for a call logged through the API without a rep (follow-ups are then
  // unassigned, for a manager to hand out).
  userId: string | null;
  lead: Lead;
  transcript: string;
  timeZone: string;
  // An inbox call that already exists gets filled in; without one (a pasted
  // transcript) a new call is saved.
  phoneCallId?: string;
  source?: string;
  // call.completed is sent by the caller, once the proposal or contract the
  // call asked for is made, so the event carries it.
  deferCompleted?: boolean;
  // What the call is recorded as: "sales" when it was meant to end in a
  // contract (the API and webhooks report it so), otherwise "cold".
  mode?: "cold" | "sales";
  // The call was the meeting itself (a proposal or contract came out of it),
  // so the rep's open sales-call task on the lead is done too.
  closesMeeting?: boolean;
};

// Haiku reads a cold-call transcript, the call is saved to the lead's
// history, the lead's fields and stage are updated, the rep's open call
// task on this lead is marked done, and an agreed next step becomes a task
// on its day. Used by "Add transcript" on a lead and by the Calls inbox.
export async function applyColdCall({ workspaceId, userId, lead: given, transcript, timeZone, phoneCallId, source = "paste", mode = "cold", closesMeeting = false, deferCompleted = false }: ApplyColdCall): Promise<ColdCallSummary> {
  const today = dayInZone(new Date(), timeZone);
  const result = await extractColdCall(transcript, given, today);
  const now = new Date();
  const reached = !UNREACHED_OUTCOMES.has(result.outcome);

  const heardEmail = result.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email) ? result.email.toLowerCase() : null;
  // What the rep typed for who's on the call counts as much as what was heard.
  const email = heardEmail ?? given.email ?? null;
  const phone = normalizePhone(result.phone) ?? given.phone ?? null;

  // A call that made its own placeholder lead may turn out to be with
  // someone already on file (a second call with the same client). Then it
  // goes on that lead, and the placeholder goes away: one lead per client.
  const match =
    given.name === NEW_LEAD_NAME && reached
      ? await findLeadForCall({
          workspaceId,
          userId,
          excludeId: given.id,
          placeholderName: NEW_LEAD_NAME,
          probe: { name: result.contactName, company: result.company, email, phone },
          call: [result.contactName && `Prospect: ${result.contactName}${result.title ? `, ${result.title}` : ""}${result.company ? ` at ${result.company}` : ""}`, result.summary, result.notes]
            .filter(Boolean)
            .join("\n"),
        })
      : null;
  const lead = match ?? given;
  // The model only saw the empty placeholder, so its lists hold just this
  // call; the lead's own lists are kept alongside.
  if (match) {
    result.painPoints = mergeList(result.painPoints, match.painPoints);
    result.objections = mergeList(result.objections, match.objections);
  }

  const moves = leadAfterCall(lead, result.outcome);
  const stage = moves.stage ?? null;
  const nextStepAt = result.nextStepDate && isValidDay(result.nextStepDate) ? new Date(`${result.nextStepDate}T00:00:00Z`) : null;

  const closable = await prisma.task.findFirst({
    where: { leadId: lead.id, assigneeId: userId, status: "open", type: { in: ["cold_call", "follow_up"] } },
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, type: true },
  });
  // A call that makes a proposal or contract is the meeting: the rep's
  // meetings with this lead are done.
  const meetings = closesMeeting
    ? await prisma.task.findMany({ where: { leadId: lead.id, assigneeId: userId, status: "open", type: "sales_call" }, select: { id: true } })
    : [];

  // A meeting becomes a sales call on its day; anything else agreed for a
  // later day becomes a follow-up. Not when it's already on the list.
  let followUp: ColdCallSummary["followUp"] = null;
  if (nextStepAt && result.nextStepDate! > today && ["meeting_booked", "interested", "follow_up"].includes(result.outcome)) {
    const type = result.outcome === "meeting_booked" ? "sales_call" : "follow_up";
    // The task this call closes doesn't count: a call that confirms the same
    // next step leaves it on the list.
    const exists = await prisma.task.findFirst({
      where: { leadId: lead.id, assigneeId: userId, status: "open", type, dueDate: nextStepAt, ...(closable ? { id: { not: closable.id } } : {}) },
      select: { id: true },
    });
    if (!exists) followUp = { type, date: result.nextStepDate!, time: result.nextStepTime };
  }

  const callData = {
    leadId: lead.id,
    mode,
    status: "processed",
    outcome: result.outcome,
    connected: result.connected,
    toNumber: lead.phone,
    transcript,
    summary: result.summary || null,
    notes: result.notes,
    extracted: result.raw as object,
    processedAt: now,
  };
  // A call saved here for the first time starts with this model call. One
  // that exists already has its model use added up by the caller instead
  // (see runCallProcessing), on top of what it took before: setting it here
  // would wipe a live call's readings while it recorded.
  const usage = { aiInputTokens: result.usage.inputTokens, aiOutputTokens: result.usage.outputTokens };

  // The client of the lead on file, when it's still there (a lead keeps
  // pointing at a client that was deleted).
  const matchClientId = match?.convertedClientId ? ((await prisma.client.findFirst({ where: { id: match.convertedClientId, workspaceId }, select: { id: true } }))?.id ?? null) : null;
  // The client the placeholder's documents went to (a "New client" made on
  // the call) is a duplicate once the call turns out to be with a lead that
  // already has one: its documents move over, and it goes once nothing else
  // has it (no deal, no lead, no portal link, no CRM record).
  const strayClientId = matchClientId && given.convertedClientId && given.convertedClientId !== matchClientId ? given.convertedClientId : null;

  const leadData = {
    ...(lead.name === NEW_LEAD_NAME && result.contactName ? { name: result.contactName.slice(0, 200) } : {}),
    // The client a document made during the call went to comes along.
    ...(match && !matchClientId && given.convertedClientId ? { convertedClientId: given.convertedClientId } : {}),
    summary: result.summary || lead.summary,
    // Stage, and on or off Active.
    ...moves,
    // Any call counts as activity, picked up or not: the lead isn't idle.
    lastActivityAt: now,
    ...(reached
      ? {
          lastContactedAt: now,
          ...(result.interest ? { interest: result.interest } : {}),
          ...(result.isDecisionMaker !== null ? { isDecisionMaker: result.isDecisionMaker } : {}),
          ...(result.painPoints ? { painPoints: result.painPoints } : {}),
          ...(result.objections ? { objections: result.objections } : {}),
          ...(result.nextStep ? { nextStep: result.nextStep, nextStepAt } : {}),
          // Details someone typed in by hand are never overwritten.
          ...(!lead.title && result.title ? { title: result.title } : {}),
          ...(!lead.company && result.company ? { company: result.company } : {}),
          ...(!lead.email && email ? { email } : {}),
          ...(!lead.phone && phone ? { phone } : {}),
        }
      : {}),
  };

  const saved = await prisma.$transaction([
    phoneCallId
      ? prisma.phoneCall.update({ where: { id: phoneCallId }, data: callData })
      : prisma.phoneCall.create({ data: { ...callData, ...usage, workspaceId, userId, source, startedAt: now } }),
    prisma.lead.update({ where: { id: lead.id }, data: leadData }),
    ...(closable ? [prisma.task.update({ where: { id: closable.id }, data: { status: "done", completedAt: now } })] : []),
    ...(meetings.length ? [prisma.task.updateMany({ where: { id: { in: meetings.map((t) => t.id) }, status: "open" }, data: { status: "done", completedAt: now } })] : []),
    // A proposal or contract made during the call (the desktop app) goes
    // with it, to the lead's own client when it has one, so the placeholder
    // can go too. One that already went out keeps its client: the portal
    // link in the email the client got lists that client's documents (and
    // the placeholder then stays, since it still has a deal).
    ...(match && phoneCallId
      ? [
          ...(matchClientId
            ? [prisma.deal.updateMany({ where: { phoneCallId, leadId: given.id, OR: [{ contract: null }, { contract: { NOT: wentOutWhere } }] }, data: { clientId: matchClientId } })]
            : []),
          prisma.deal.updateMany({ where: { phoneCallId, leadId: given.id }, data: { leadId: lead.id } }),
        ]
      : []),
    ...(match ? [prisma.lead.deleteMany({ where: { id: given.id, name: NEW_LEAD_NAME, phoneCalls: { none: {} }, tasks: { none: {} }, callIntents: { none: {} }, deals: { none: {} } } })] : []),
    // After the deals moved and the placeholder lead went (a placeholder
    // that stays still points at it, so it stays too).
    ...(strayClientId
      ? [
          prisma.$executeRaw`DELETE FROM "Client" c WHERE c.id = ${strayClientId} AND c."workspaceId" = ${workspaceId} AND c."portalToken" IS NULL AND c."hubspotContactId" IS NULL AND c."salesforceContactId" IS NULL AND NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."clientId" = c.id) AND NOT EXISTS (SELECT 1 FROM "Lead" l WHERE l."convertedClientId" = c.id)`,
        ]
      : []),
    ...(followUp
      ? [
          prisma.task.create({
            data: {
              workspaceId,
              leadId: lead.id,
              assigneeId: userId,
              createdById: userId,
              type: followUp.type,
              dueDate: nextStepAt!,
              dueTime: followUp.time,
              timezone: timeZone,
              note: result.nextStep,
            },
          }),
        ]
      : []),
  ]);

  const callId = saved[0].id;
  const followUpTaskId = followUp ? (saved[saved.length - 1] as { id: string }).id : null;

  await dispatchLeadsUpdated(workspaceId, [leadChanges(lead.id, lead, leadData)]);
  if (!deferCompleted) await dispatchCallCompleted(workspaceId, callId);
  const closedIds = [...(closable ? [closable.id] : []), ...meetings.map((t) => t.id)];
  if (closedIds.length) await dispatchTasksCompleted(workspaceId, closedIds, { callId });
  if (result.outcome === "meeting_booked") {
    await dispatchMeetingsBooked(workspaceId, [
      {
        leadId: lead.id,
        repId: userId,
        date: nextStepAt ? result.nextStepDate : null,
        time: nextStepAt ? result.nextStepTime : null,
        timeZone,
        source: "call",
        callId,
        taskId: followUp?.type === "sales_call" ? followUpTaskId : null,
      },
    ]);
  }

  // Where things stand across the lead's calls, now that there's one more,
  // and the stage, when the call made the lead active again (a proposal or
  // contract may still be out).
  await refreshLeadOverview(lead.id);
  if (leadData.pipelineStage) await refreshLeadPipeline(lead.id);

  return {
    outcome: result.outcome,
    stage,
    closedTask: closable?.type ?? (meetings.length ? "sales_call" : null),
    followUp,
    costUsd: result.usage.costUsd,
    callId,
    leadId: lead.id,
    leadName: (leadData.name as string | undefined) ?? lead.name,
    matched: Boolean(match),
  };
}
