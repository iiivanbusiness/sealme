"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { PENDING_TTL_MS, runCallProcessing } from "@/lib/call-inbox";
import { cookieTimeZone } from "@/lib/viewer-time";
import { leadForCall } from "@/lib/call-lead";

// What the start-a-call form shows when a call can't be saved: what to fix.
// The form keeps everything typed in, to fix and send again.
export type StartCallState = { error: string } | null;

// Start a call with a recording or a transcript: the call goes on a lead
// (see saveCall) and is written up in the background. The rep lands on the
// lead's profile with this call open, to watch it finish.
export async function startCallFromTranscript(_prev: StartCallState, formData: FormData): Promise<StartCallState> {
  const saved = await saveCall(formData);
  if ("error" in saved) return saved;
  // added: the call was just saved, so the lead page can say so.
  redirect(saved.leadId ? `/leads/${saved.leadId}?call=${saved.callId}&added=1` : "/leads?added=1");
}

// A meeting recorded in the iPhone app: saved the same way, but the page
// moves on by itself, after deleting the recording from the phone. Anything
// that keeps the call from being saved has to throw: the app deletes the
// recording once this returns.
export async function saveRecordedMeeting(formData: FormData): Promise<{ leadId: string; callId: string }> {
  formData.set("source", "app");
  // Proposals and contracts are made on the computer.
  formData.delete("wantsProposal");
  formData.delete("wantsContract");
  const saved = await saveCall(formData);
  if ("error" in saved) throw new Error(saved.error);
  return saved;
}

// Every call is a call on a lead and always gets notes; a proposal or a
// contract asked for too is made from the same transcript once the notes
// are in, on the template picked here or the one that fits the call.
// What the rep can fix comes back as an error instead of a thrown one, which
// would end on the app's error screen and lose the transcript.
async function saveCall(formData: FormData): Promise<{ leadId: string; callId: string } | { error: string }> {
  const transcript = String(formData.get("transcript") ?? "").trim();
  const picked = String(formData.get("leadId") ?? "new").trim() || "new";
  const typed = String(formData.get("who") ?? "").trim();
  // The meeting's name for the email in "who" (see WhoOnCall).
  const whoName = String(formData.get("whoName") ?? "").trim();
  const fromApp = formData.get("source") === "app";
  const fromRecording = fromApp || formData.get("source") === "recording";
  const seconds = Math.round(Number(formData.get("seconds")) || 0) || null;
  if (!transcript) return { error: "Add the recording or paste the transcript first" };
  if (transcript.length > 400_000) return { error: "That transcript is too long. Use one call at a time" };

  const workspace = await requireProspecting();
  const access = await leadAccess();
  // The app sends a meeting again when the answer to its first save got lost
  // (a weak signal). If that save went through, the same transcript from the
  // same person is already being written up.
  if (fromApp) {
    const since = new Date(Date.now() - PENDING_TTL_MS);
    const already = await prisma.phoneCall.findFirst({ where: { workspaceId: workspace.id, userId: access.userId, source: "app", transcript, startedAt: { gte: since } }, select: { id: true, leadId: true } });
    if (already) return { leadId: already.leadId ?? "", callId: already.id };
  }

  const wantsProposal = formData.get("wantsProposal") === "1";
  const wantsContract = formData.get("wantsContract") === "1";
  // One template per call: the contract's when there is one, else the
  // proposal's. Left out, SealMe picks from what was said.
  const pickedTemplate = String(formData.get(wantsContract ? "contractTemplateId" : "proposalTemplateId") ?? "").trim();
  const template = pickedTemplate && (wantsContract || wantsProposal) ? await prisma.contractTemplate.findFirst({ where: { id: pickedTemplate, workspaceId: workspace.id, kind: wantsContract ? { not: "proposal" } : "proposal" }, select: { id: true } }) : null;
  if (pickedTemplate && (wantsContract || wantsProposal) && !template) return { error: "That template isn't in this workspace" };

  const lead = await leadForCall(workspace.id, access.userId, picked, typed, access.where, whoName);
  if (!lead) return { error: "That lead isn't available" };

  const call = await prisma.phoneCall.create({
    data: {
      workspaceId: workspace.id,
      userId: access.userId,
      leadId: lead.id,
      source: fromApp ? "app" : fromRecording ? "upload" : "paste",
      mode: "notes",
      wantsProposal,
      wantsContract,
      templateId: template?.id ?? null,
      status: "processing",
      transcript,
      durationSec: seconds,
      sttSeconds: fromRecording ? seconds : null,
    },
    select: { id: true },
  });
  await prisma.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date() } });
  const timeZone = await cookieTimeZone();
  // Notes are asked for on purpose, so nothing is set aside as a voicemail:
  // one phone or laptop in a room often hears everyone as one voice, and a
  // pasted transcript has no length to tell a voicemail by. Notes has no
  // Process anyway either, so a set-aside call would just vanish. (The app
  // doesn't send recordings under MIN_PROCESS_SECONDS.)
  after(() => runCallProcessing(call.id, timeZone, { force: true }));
  return { leadId: lead.id, callId: call.id };
}

// The same hash the upload route looks a token up by.
function hashCaptureToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// A follow-up call on a deal (see continueLocalCapture): one Call, one
// token, always.
async function mintLocalCaptureToken(workspaceId: string, dealId: string, callId: string): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashCaptureToken(rawToken);
  await prisma.localCaptureToken.create({
    data: {
      workspaceId,
      dealId,
      callId,
      tokenHash,
      // 4h covers even an unusually long call. The token is spent once the
      // call's final upload gets through, well before that.
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    },
  });
  return rawToken;
}

// Attaches a follow-up call to a deal that already exists, instead of
// spawning a new deal + client for what's really a continuation of the
// same negotiation. Reuses the deal's existing template.
export async function continueLocalCapture(dealId: string): Promise<{ dealId: string; token: string } | { error: string }> {
  const [workspace, { where }] = await Promise.all([requireWorkspace(), dealVisibilityFilter()]);

  // Only a deal this person may see: the call rewrites its terms.
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId: workspace.id, ...where } });
  if (!deal) return { error: "Deal not found" };
  if (deal.status === "signed") return { error: "This deal is already signed. Start a new deal instead" };

  const call = await prisma.call.create({ data: { dealId, source: "local" } });
  const rawToken = await mintLocalCaptureToken(workspace.id, dealId, call.id);

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { callsUsedThisMonth: { increment: 1 } },
  });

  return { dealId, token: rawToken };
}

// "Discard" on a call recorded in the desktop app, once the app has stopped
// recording it. The call ends here and its token is spent, so a live chunk
// still on its way (or a final sent again) can't add to it. A deal that was
// waiting on the call to be read gets the status its terms call for, instead
// of "SealMe is reading the call" for good. A call that isn't there anymore,
// or isn't on a deal this person may see, leaves nothing to do.
export async function discardLocalCapture(dealId: string, token: string): Promise<void> {
  if (typeof dealId !== "string" || typeof token !== "string" || !dealId || !token) return;
  const [workspace, { where }] = await Promise.all([requireWorkspace(), dealVisibilityFilter()]);

  const [record, deal] = await Promise.all([
    prisma.localCaptureToken.findFirst({ where: { tokenHash: hashCaptureToken(token), dealId, workspaceId: workspace.id }, select: { id: true, callId: true } }),
    prisma.deal.findFirst({ where: { id: dealId, workspaceId: workspace.id, ...where }, select: { id: true } }),
  ]);
  if (!record || !deal) return;

  const now = new Date();
  if (record.callId) await prisma.call.updateMany({ where: { id: record.callId, endedAt: null }, data: { endedAt: now } });
  // Spent the way a finished call's token is (expired as of when it was
  // used): live chunks are turned away, and a final is told it's in.
  await prisma.localCaptureToken.update({ where: { id: record.id }, data: { usedAt: now, expiresAt: now } });

  // Whatever the live passes already read stays; anything still missing is
  // for the rep to fill in.
  const missing = await prisma.dealField.count({ where: { dealId, status: "missing" } });
  await prisma.deal.updateMany({ where: { id: dealId, status: "processing" }, data: { status: missing > 0 ? "missing_info" : "ready" } });
  revalidatePath(`/deals/${dealId}`);
}
