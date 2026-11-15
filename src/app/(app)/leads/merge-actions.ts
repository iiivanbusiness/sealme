"use server";

import { after } from "next/server";
import { INACTIVE_STAGES, refreshLeadPipeline, syncLeadClient, wentOut } from "@/lib/lead-pipeline";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { mergeLeads } from "@/lib/lead-merge";
import { refreshLeadOverview } from "@/lib/lead-overview";
import { normalizePhone } from "@/lib/phone";
import { isValidDay } from "@/lib/tasks";
import { NEW_LEAD_NAME, leadAfterCall } from "@/lib/cold-call";
import { dispatchLeadsUpdated, leadChanges, type LeadChange } from "@/lib/webhook-events";
import { logAudit } from "@/lib/audit";
import { currentUserWithRole } from "@/lib/permissions";
import { dropRecording } from "@/lib/call-inbox";
import { sharingPointerWhere } from "@/lib/call-docs";

export type LeadPick = { id: string; name: string; company: string | null; calls: number };

// Any lead the viewer can see, for "Move to another lead" and "Merge with":
// converted and lost ones too, since a client's earlier calls can be there.
export async function searchLeadsToJoin(excludeId: string, q: string): Promise<LeadPick[]> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const term = typeof q === "string" ? q.trim().slice(0, 100) : "";
  if (term.length < 2) return [];
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId: workspace.id,
      id: { not: excludeId },
      AND: [access.where, { OR: [{ name: { contains: term, mode: "insensitive" } }, { company: { contains: term, mode: "insensitive" } }, { email: { contains: term, mode: "insensitive" } }] }],
    },
    select: { id: true, name: true, company: true, _count: { select: { phoneCalls: { where: { status: "processed" } } } } },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  return leads.map((l) => ({ id: l.id, name: l.name, company: l.company, calls: l._count.phoneCalls }));
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function heardOn(extracted: unknown): Record<string, unknown> {
  return (extracted && typeof extracted === "object" && !Array.isArray(extracted) ? extracted : {}) as Record<string, unknown>;
}

// After a call moves off or onto a lead, what the lead shows from its calls
// (last call, interest, next step) comes from its newest call again.
async function syncFromCalls(leadId: string) {
  const [latest, reached] = await Promise.all([
    prisma.phoneCall.findFirst({ where: { leadId, status: "processed" }, select: { summary: true }, orderBy: { startedAt: "desc" } }),
    prisma.phoneCall.findFirst({ where: { leadId, status: "processed", connected: true }, select: { startedAt: true, extracted: true }, orderBy: { startedAt: "desc" } }),
  ]);
  const heard = heardOn(reached?.extracted);
  const nextStep = text(heard.nextStep);
  const nextDay = text(heard.nextStepDate);
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      summary: latest?.summary ?? null,
      lastContactedAt: reached?.startedAt ?? null,
      ...(reached
        ? {
            ...(["cold", "warm", "hot"].includes(String(heard.interest)) ? { interest: String(heard.interest) } : {}),
            ...(heard.isDecisionMaker === "yes" || heard.isDecisionMaker === "no" ? { isDecisionMaker: heard.isDecisionMaker === "yes" } : {}),
            nextStep,
            nextStepAt: nextStep && nextDay && isValidDay(nextDay) ? new Date(`${nextDay}T00:00:00Z`) : null,
          }
        : {}),
    },
  });
}

// "Move to another lead" on a call that landed on the wrong lead. To a lead
// on file, or "new" for a lead of its own filled in from the call. A lead
// made by a call that has no calls left is folded into where its call went.
export async function moveCallToLead(callId: string, targetLeadId: string): Promise<{ leadId: string }> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const call = await prisma.phoneCall.findFirst({
    where: { id: callId, workspaceId: workspace.id, status: "processed", lead: access.where },
    select: { id: true, leadId: true, outcome: true, startedAt: true, processedAt: true, summary: true, extracted: true },
  });
  if (!call?.leadId) throw new Error("That call isn't available");
  const sourceId = call.leadId;

  let targetId: string;
  // Whether the call is newer than anything on the lead it goes to, judged
  // before a merge below brings in the activity of the lead it left. A lead
  // made from the call starts where the call leaves it.
  let newest = false;
  // Where the lead it goes to stood before the move (null for a new lead).
  let targetBefore: { stage: string; pipelineStage: string } | null = null;
  if (targetLeadId === "new") {
    const heard = heardOn(call.extracted);
    const email = text(heard.email)?.toLowerCase() ?? null;
    const created = await prisma.lead.create({
      data: {
        workspaceId: workspace.id,
        ownerId: access.userId,
        // No name heard: the placeholder every unnamed call lead gets, so the
        // Dashboard asks for a name like it does for the rest.
        name: (text(heard.contactName) ?? NEW_LEAD_NAME).slice(0, 200),
        title: text(heard.title),
        company: text(heard.company),
        email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
        phone: normalizePhone(text(heard.phone)),
        painPoints: text(heard.painPoints),
        objections: text(heard.objections),
        stage: "new",
        // Where the call leaves it: not interested is off Active from the start.
        ...leadAfterCall({ stage: "new", pipelineStage: "new", isClient: false }, call.outcome),
        source: "call",
      },
      select: { id: true },
    });
    targetId = created.id;
  } else {
    const target = await prisma.lead.findFirst({ where: { id: targetLeadId, workspaceId: workspace.id, AND: [access.where] }, select: { id: true, lastActivityAt: true, stage: true, pipelineStage: true } });
    if (!target) throw new Error("That lead isn't available");
    if (target.id === sourceId) throw new Error("The call is already on that lead");
    targetId = target.id;
    newest = !target.lastActivityAt || target.lastActivityAt < call.startedAt;
    targetBefore = { stage: target.stage, pipelineStage: target.pipelineStage };
  }

  // Its "where things stand" was about the lead it's leaving.
  const heard = { ...heardOn(call.extracted) };
  delete heard.overview;
  delete heard.overviewCalls;
  await prisma.phoneCall.update({ where: { id: call.id }, data: { leadId: targetId, ...(call.extracted ? { extracted: heard as object } : {}) } });
  // So do the proposal and contract made from it.
  const moved = await prisma.deal.updateMany({ where: { phoneCallId: call.id, workspaceId: workspace.id }, data: { leadId: targetId } });
  // The follow-up the call set up moves with it. Tasks carry no call id, but
  // the call's are saved in the same write as the call itself.
  if (call.processedAt) {
    const at = call.processedAt.getTime();
    await prisma.task.updateMany({
      where: { leadId: sourceId, status: "open", type: { in: ["follow_up", "sales_call"] }, createdAt: { gte: new Date(at - 2_000), lte: new Date(at + 30_000) } },
      data: { leadId: targetId },
    });
  }

  const source = await prisma.lead.findUnique({
    where: { id: sourceId },
    select: { source: true, stage: true, pipelineStage: true, isClient: true, _count: { select: { phoneCalls: { where: { status: "processed" } } } } },
  });
  const sourceGone = source?.source === "call" && source._count.phoneCalls === 0;
  if (sourceGone) {
    await mergeLeads(workspace.id, sourceId, targetId);
    // The merge keeps whichever stage ranks higher, so the emptied lead's
    // "new" would put a lead set aside since this older call back on
    // Active. An older call is just history: it stays where the rep put it.
    if (!newest && targetBefore && INACTIVE_STAGES.includes(targetBefore.pipelineStage)) {
      await prisma.lead.updateMany({
        where: { id: targetId, isClient: false },
        data: { pipelineStage: targetBefore.pipelineStage, ...(targetBefore.stage === "lost" ? { stage: "lost" } : {}) },
      });
    }
  } else await syncFromCalls(sourceId);
  await syncFromCalls(targetId);
  const changes: LeadChange[] = [];

  // A lead this call's "not interested" took off Active is back on it when
  // its own newest call says otherwise, or it has none left. Not when a
  // newer call is on it: then it was marked lost by hand since. Not now and
  // clients are never touched.
  let sourceBack = false;
  if (source && !sourceGone && !source.isClient && source.pipelineStage === "lost" && call.outcome === "not_interested") {
    const latest = await prisma.phoneCall.findFirst({ where: { leadId: sourceId, status: "processed" }, select: { outcome: true, startedAt: true }, orderBy: { startedAt: "desc" } });
    if (!latest || (latest.outcome !== "not_interested" && latest.startedAt <= call.startedAt)) {
      // Contacted for the API, as after Reactivate.
      const data = { pipelineStage: "new", ...(source.stage === "lost" ? { stage: "contacted" } : {}) };
      const { count } = await prisma.lead.updateMany({ where: { id: sourceId, isClient: false, pipelineStage: "lost" }, data });
      sourceBack = count > 0;
      if (sourceBack) changes.push(leadChanges(sourceId, source, data));
    }
  }

  // The call is the lead's newest activity, if it is: it leaves the lead it
  // lands on where any new call would (not interested: off Active; anything
  // else: a set-aside lead is active again). An older call is just history:
  // a lead marked lost or not now since then stays that way.
  const target = await prisma.lead.findUnique({ where: { id: targetId }, select: { lastActivityAt: true, stage: true, pipelineStage: true, isClient: true } });
  if (target) {
    const data = {
      ...(!target.lastActivityAt || target.lastActivityAt < call.startedAt ? { lastActivityAt: call.startedAt } : {}),
      ...(newest ? leadAfterCall(target, call.outcome) : {}),
    };
    await prisma.lead.update({ where: { id: targetId }, data });
    changes.push(leadChanges(targetId, target, data));
  }
  if (moved.count > 0) {
    if (!sourceGone) await syncLeadClient(sourceId);
    await syncLeadClient(targetId);
  }
  if (!sourceGone && (moved.count > 0 || sourceBack)) await refreshLeadPipeline(sourceId);
  await refreshLeadPipeline(targetId);
  await dispatchLeadsUpdated(workspace.id, changes);

  after(async () => {
    await refreshLeadOverview(targetId);
    if (!sourceGone) await refreshLeadOverview(sourceId);
  });
  revalidatePath(`/leads/${targetId}`);
  revalidatePath(`/leads/${sourceId}`);
  revalidatePath("/leads");
  return { leadId: targetId };
}

// "Merge with…" on a lead: this lead (and all its calls) goes into the one
// picked, which is where the viewer lands.
export async function mergeLeadInto(sourceId: string, targetId: string): Promise<{ leadId: string }> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const both = await prisma.lead.findMany({ where: { id: { in: [sourceId, targetId] }, workspaceId: workspace.id, AND: [access.where] }, select: { id: true } });
  if (both.length !== 2) throw new Error("That lead isn't available");
  await mergeLeads(workspace.id, sourceId, targetId);
  after(() => refreshLeadOverview(targetId));
  revalidatePath(`/leads/${targetId}`);
  revalidatePath("/leads");
  return { leadId: targetId };
}

// "Delete call" on a call. Its drafts go to the trash with it (they can be
// put back from there). A proposal or contract that went out to the client
// is a record of what they got, so then the call stays.
export async function deleteCall(callId: string): Promise<{ error?: string }> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const call = await prisma.phoneCall.findFirst({
    where: { id: callId, workspaceId: workspace.id, lead: access.where },
    select: { id: true, leadId: true, dealId: true, status: true, telnyxRecordingId: true },
  });
  if (!call?.leadId) return { error: "That call isn't available" };
  if (["dialing", "recording", "processing"].includes(call.status)) return { error: "This call is still going or being written up. Try again once it's done" };
  const leadId = call.leadId;
  // The call's own documents. The old pointer (call.dealId, from before
  // documents knew their call) counts only when no other call shares it,
  // by the same rule the lead page shows documents under calls with.
  const sharesPointer = call.dealId ? await prisma.phoneCall.count({ where: sharingPointerWhere({ id: call.id, leadId, dealId: call.dealId }) }) : 0;
  const deals = await prisma.deal.findMany({
    where: { workspaceId: workspace.id, trashedAt: null, OR: [{ phoneCallId: call.id }, ...(call.dealId && !sharesPointer ? [{ id: call.dealId, leadId, phoneCallId: null }] : [])] },
    select: { id: true, kind: true, contract: { select: { id: true, sentAt: true, status: true } } },
  });
  // Went to the client at some point, whatever it says now (changes asked
  // for, a new version waiting on approval): a record of what they got.
  const out = deals.find((d) => d.contract && wentOut(d.contract));
  if (out) return { error: `The ${out.kind === "proposal" ? "proposal" : "contract"} from this call went out to the client, so the call stays.` };

  const contractIds = deals.flatMap((d) => (d.contract ? [d.contract.id] : []));
  await prisma.$transaction([
    prisma.deal.updateMany({ where: { id: { in: deals.map((d) => d.id) } }, data: { trashedAt: new Date() } }),
    // A draft waiting on a reviewer stops waiting: nothing is approved and
    // sent from the trash.
    prisma.reviewStep.deleteMany({ where: { contractId: { in: contractIds }, status: "pending" } }),
    prisma.contract.updateMany({ where: { id: { in: contractIds }, status: "pending_approval" }, data: { status: "draft" } }),
    prisma.phoneCall.delete({ where: { id: call.id } }),
  ]);
  // A recording still kept at Telnyx goes with the call.
  if (call.telnyxRecordingId) after(() => dropRecording(call.telnyxRecordingId, call.id));
  const user = await currentUserWithRole();
  await logAudit({ workspaceId: workspace.id, actorEmail: user.email, action: "call.deleted", targetType: "PhoneCall", targetId: call.id, metadata: { leadId, trashedDeals: deals.length } });

  await syncFromCalls(leadId);
  await refreshLeadPipeline(leadId);
  after(() => refreshLeadOverview(leadId));
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads");
  return {};
}
