"use server";

import crypto from "crypto";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { leadForCall } from "@/lib/call-lead";
import { NEW_LEAD_NAME } from "@/lib/cold-call";
import { startLiveDeal, refreshLiveDeals } from "@/lib/live-call";
import { refreshLeadPipeline, wentOutWhere } from "@/lib/lead-pipeline";
import { reportError } from "@/lib/error-report";
import type { DealKind } from "@/lib/call-deal";

// Start a call in the desktop app, live: the call goes on a lead as it
// starts (it shows on the lead as "Recording now"), and the desktop app gets
// a token to send the recording with, a chunk about a minute apart. A
// proposal or contract ticked before the call is made now and fills in as
// the terms are said; one with no template yet is left to the end of the
// call, which says what's missing.
export async function startLiveCall(formData: FormData): Promise<{ phoneCallId: string; leadId: string; token: string } | { error: string }> {
  const picked = String(formData.get("leadId") ?? "new").trim() || "new";
  const typed = String(formData.get("who") ?? "").trim();
  // The meeting's name for the email in "who" (see WhoOnCall).
  const whoName = String(formData.get("whoName") ?? "").trim();
  const wantsProposal = formData.get("wantsProposal") === "1";
  const wantsContract = formData.get("wantsContract") === "1";
  const workspace = await requireProspecting();
  const access = await leadAccess();

  const pickedTemplate = String(formData.get(wantsContract ? "contractTemplateId" : "proposalTemplateId") ?? "").trim();
  const template = pickedTemplate ? await prisma.contractTemplate.findFirst({ where: { id: pickedTemplate, workspaceId: workspace.id, kind: wantsContract ? { not: "proposal" } : "proposal" }, select: { id: true } }) : null;

  const lead = await leadForCall(workspace.id, access.userId, picked, typed, access.where, whoName);
  if (!lead) return { error: "That lead isn't available" };

  const now = new Date();
  const call = await prisma.phoneCall.create({
    data: {
      workspaceId: workspace.id,
      userId: access.userId,
      leadId: lead.id,
      source: "desktop",
      mode: "notes",
      status: "recording",
      wantsProposal,
      wantsContract,
      templateId: template?.id ?? null,
      startedAt: now,
    },
    select: { id: true },
  });
  const rawToken = crypto.randomBytes(32).toString("hex");
  await prisma.localCaptureToken.create({
    data: {
      workspaceId: workspace.id,
      phoneCallId: call.id,
      tokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
      // Covers even an unusually long call; spent once the final gets through.
      expiresAt: new Date(now.getTime() + 4 * 60 * 60 * 1000),
    },
  });
  await prisma.lead.update({ where: { id: lead.id }, data: { lastActivityAt: now } });
  await prisma.workspace.update({ where: { id: workspace.id }, data: { callsUsedThisMonth: { increment: 1 } } });

  for (const kind of [...(wantsProposal ? (["proposal"] as const) : []), ...(wantsContract ? (["contract"] as const) : [])]) {
    await startLiveDeal(call.id, kind, { templateId: template?.id ?? null }).catch((err) => {
      // No template of that kind: the notes go ahead, and the end of the
      // call tells the rep (see runCallProcessing).
      if (!(err instanceof Error && /template first/.test(err.message))) return reportError(err, "Starting a document on a live call", { phoneCallId: call.id, kind });
    });
  }
  revalidatePath(`/leads/${lead.id}`);
  revalidatePath("/leads");
  return { phoneCallId: call.id, leadId: lead.id, token: rawToken };
}

async function visibleCall(phoneCallId: string) {
  if (typeof phoneCallId !== "string" || !phoneCallId) return null;
  const [workspace, access] = await Promise.all([requireProspecting(), leadAccess()]);
  return prisma.phoneCall.findFirst({
    where: { id: phoneCallId, workspaceId: workspace.id, lead: access.where },
    select: { id: true, workspaceId: true, status: true, startedAt: true, transcript: true, leadId: true, lead: { select: { name: true } } },
  });
}

export type LiveDoc = { kind: DealKind; dealId: string; template: string | null; filled: number; total: number; missing: string[]; reading: boolean };
export type LiveCallState = {
  status: string;
  leadId: string | null;
  leadName: string | null;
  startedAt: string;
  heard: string; // the last few lines said, for "it's hearing us"
  words: number;
  docs: LiveDoc[];
  canMake: Record<DealKind, boolean>;
};

// What the recording panel shows while the call runs: who it's on, what's
// been heard lately, and each proposal or contract with how many of its
// terms are in and which are still missing, so the rep can ask before the
// call ends.
export async function liveCallState(phoneCallId: string): Promise<LiveCallState | null> {
  const call = await visibleCall(phoneCallId);
  if (!call) return null;
  const [deals, kinds] = await Promise.all([
    prisma.deal.findMany({
      where: { phoneCallId: call.id, trashedAt: null },
      select: { id: true, kind: true, status: true, template: { select: { name: true } }, fields: { where: { fieldKey: { not: "clientEmail" } }, select: { label: true, status: true }, orderBy: { orderIndex: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.contractTemplate.groupBy({ by: ["kind"], where: { workspaceId: call.workspaceId }, _count: true }),
  ]);
  const transcript = (call.transcript ?? "").trim();
  const docs: LiveDoc[] = deals.map((d) => ({
    kind: d.kind === "proposal" ? "proposal" : "contract",
    dealId: d.id,
    template: d.template?.name ?? null,
    filled: d.fields.filter((f) => f.status !== "missing").length,
    total: d.fields.length,
    missing: d.fields.filter((f) => f.status === "missing").map((f) => f.label),
    reading: d.status === "processing",
  }));
  const has = (kind: DealKind) => kinds.some((t) => (kind === "proposal" ? t.kind === "proposal" : t.kind !== "proposal"));
  return {
    status: call.status,
    leadId: call.leadId,
    leadName: call.lead && call.lead.name !== NEW_LEAD_NAME ? call.lead.name : null,
    startedAt: call.startedAt.toISOString(),
    heard: transcript.split("\n").slice(-3).join("\n").slice(-400),
    words: transcript ? transcript.split(/\s+/).length : 0,
    docs,
    canMake: { proposal: has("proposal") && !docs.some((d) => d.kind === "proposal"), contract: has("contract") && !docs.some((d) => d.kind === "contract") },
  };
}

// Create proposal / Create contract on the recording panel: made from
// everything said so far, and kept filling in until the call ends.
export async function createLiveDocument(phoneCallId: string, kind: DealKind): Promise<{ dealId?: string; error?: string }> {
  if (kind !== "proposal" && kind !== "contract") return { error: "Pick a proposal or a contract" };
  const call = await visibleCall(phoneCallId);
  if (!call) return { error: "This call isn't available" };
  try {
    const { dealId } = await startLiveDeal(call.id, kind);
    // The first reading, from what's been said so far, after the answer.
    if ((call.transcript ?? "").trim()) after(() => refreshLiveDeals(call.id, call.transcript ?? ""));
    if (call.leadId) revalidatePath(`/leads/${call.leadId}`);
    return { dealId };
  } catch (err) {
    if (err instanceof Error && /template first|has ended|isn't on a lead/.test(err.message)) return { error: err.message };
    await reportError(err, "Creating a document on a live call", { phoneCallId, kind });
    return { error: `Couldn't start the ${kind}. Try again` };
  }
}

// Discard on a live call, once the app has stopped recording: the call and
// its words are thrown away, its token can't add to it, and a draft made on
// it goes to the trash. A lead the call made for itself, with nothing else
// on it, goes too.
export async function discardLiveCall(phoneCallId: string, token: string): Promise<void> {
  if (typeof token !== "string" || !token) return;
  const call = await visibleCall(phoneCallId);
  if (!call) return;
  const record = await prisma.localCaptureToken.findFirst({ where: { phoneCallId: call.id, workspaceId: call.workspaceId, tokenHash: crypto.createHash("sha256").update(token).digest("hex") }, select: { id: true } });
  if (!record) return;
  const now = new Date();
  await prisma.localCaptureToken.update({ where: { id: record.id }, data: { usedAt: now, expiresAt: now } });
  // Only a call still recording: one already being written up is the rep's
  // to delete from the lead.
  const { count } = await prisma.phoneCall.updateMany({ where: { id: call.id, status: "recording" }, data: { status: "discarded", transcript: null, summary: null, endedAt: now } });
  if (count === 0) return;
  // What was made on the call goes to the trash, except a document that
  // already went to the client (the same rule as deleting a call), and a
  // draft waiting on a reviewer stops waiting: nothing is approved and sent
  // from the trash.
  const drafts = await prisma.deal.findMany({
    where: { phoneCallId: call.id, trashedAt: null, OR: [{ contract: null }, { contract: { NOT: wentOutWhere } }] },
    select: { id: true, contract: { select: { id: true } } },
  });
  const contractIds = drafts.flatMap((d) => (d.contract ? [d.contract.id] : []));
  await prisma.$transaction([
    prisma.deal.updateMany({ where: { id: { in: drafts.map((d) => d.id) } }, data: { trashedAt: now } }),
    prisma.reviewStep.deleteMany({ where: { contractId: { in: contractIds }, status: "pending" } }),
    prisma.contract.updateMany({ where: { id: { in: contractIds }, status: "pending_approval" }, data: { status: "draft" } }),
  ]);
  if (call.leadId) {
    await prisma.lead.deleteMany({ where: { id: call.leadId, name: NEW_LEAD_NAME, phoneCalls: { none: { status: { not: "discarded" } } }, tasks: { none: {} }, callIntents: { none: {} }, deals: { none: { trashedAt: null } } } });
    await refreshLeadPipeline(call.leadId);
    revalidatePath(`/leads/${call.leadId}`);
  }
  revalidatePath("/leads");
}
