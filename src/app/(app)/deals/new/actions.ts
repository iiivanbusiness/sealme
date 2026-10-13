"use server";

import { redirect } from "next/navigation";
import { after } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { dispatchDealCreated } from "@/lib/webhooks";
import { notifySlack } from "@/lib/slack";
import { syncDealToHubspot } from "@/lib/hubspot";
import { syncDealToSalesforce } from "@/lib/salesforce";
import { reportError } from "@/lib/error-report";
import { createDealFromTranscriptText, finishTranscriptDealInBackground, type TranscriptDeal } from "@/lib/transcript-deal";
import { extractPlaceholderKeys } from "@/lib/contract";
import { fieldMeta } from "@/lib/extract-deal";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { runCallProcessing } from "@/lib/call-inbox";
import { NEW_LEAD_NAME } from "@/lib/cold-call";
import { cookieTimeZone } from "@/lib/viewer-time";

export async function createDeal(formData: FormData) {
  const clientName = String(formData.get("clientName") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim() || clientName;
  const email = String(formData.get("email") ?? "").trim() || null;
  const service = String(formData.get("service") ?? "").trim();
  const feeDisplay = String(formData.get("feeDisplay") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "") || null;

  if (!clientName || !service || !feeDisplay) {
    throw new Error("Client, service, and fee are required");
  }

  const [workspace, user] = await Promise.all([requireWorkspace(), currentUserWithRole()]);
  const workspaceId = workspace.id;

  // Whatever else the template fills in (a start date, say) isn't on this
  // form, so it's asked for on the deal instead of showing up in the
  // contract as "{startDate}".
  const template = templateId ? await prisma.contractTemplate.findFirst({ where: { id: templateId, workspaceId }, select: { clauses: true } }) : null;
  const given = ["clientName", "service", "fee"];
  const asked = (template ? extractPlaceholderKeys(template.clauses) : []).filter((key) => !given.includes(key));
  const extraFields = asked.map((fieldKey, i) => ({ ...fieldMeta(fieldKey), fieldKey, value: null, status: "missing", orderIndex: 3 + i }));

  const client = await prisma.client.create({
    data: { workspaceId, name: clientName, company, email },
  });

  const deal = await prisma.deal.create({
    data: {
      workspaceId,
      clientId: client.id,
      templateId,
      ownerId: user.id,
      teamId: user.teamId,
      service,
      feeDisplay,
      status: extraFields.length ? "missing_info" : "ready",
      source: "upload",
      fields: {
        create: [
          // The contract is with the company when one was given.
          { groupLabel: "Client & engagement", label: "Client", fieldKey: "clientName", value: company, status: "confirmed", orderIndex: 0 },
          { groupLabel: "Client & engagement", label: "Service", fieldKey: "service", value: service, status: "confirmed", orderIndex: 1 },
          { groupLabel: "Commercial terms", label: "Fee", fieldKey: "fee", value: feeDisplay, status: "confirmed", orderIndex: 2 },
          ...extraFields,
        ],
      },
    },
  });

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { callsUsedThisMonth: { increment: 1 } },
  });

  await dispatchDealCreated(workspaceId, deal.id);
  await notifySlack(workspaceId, { type: "deal.created", dealId: deal.id, clientName, service });
  await syncDealToHubspot(workspaceId, deal.id);
  await syncDealToSalesforce(workspaceId, deal.id);

  redirect(`/deals/${deal.id}`);
}

export async function createDealFromTranscript(formData: FormData) {
  const transcript = String(formData.get("transcript") ?? "").trim();
  const templateId = String(formData.get("templateId") ?? "").trim();
  // The transcript came from an uploaded video/audio file rather than text.
  const fromRecording = formData.get("source") === "recording";

  if (!transcript) throw new Error("Paste a call transcript first");
  if (!templateId) throw new Error("Choose a template");

  const [workspace, user] = await Promise.all([requireWorkspace(), currentUserWithRole()]);
  const workspaceId = workspace.id;

  const template = await prisma.contractTemplate.findFirst({ where: { id: templateId, workspaceId }, select: { id: true } });
  if (!template) throw new Error("Template not found");

  let made: TranscriptDeal;
  try {
    made = await createDealFromTranscriptText({
      workspaceId,
      ownerId: user.id,
      teamId: user.teamId,
      templateId,
      transcript,
      callSource: fromRecording ? "recording" : "upload",
      dealSource: "upload",
    });
  } catch (err) {
    await reportError(err, "Deal extraction from pasted transcript", { workspaceId });
    redirect(`/deals/new?error=${encodeURIComponent("Couldn't extract deal terms from that transcript. Try again or enter it manually.")}`);
  }

  // Two more model calls plus integrations. Done inline it pushed a long
  // call past the function timeout before the redirect, so the rep saw
  // nothing happen. The deal page polls these in as they land.
  after(() => finishTranscriptDealInBackground(workspaceId, made.dealId, made.callId, transcript));

  redirect(`/deals/${made.dealId}`);
}

// "Notes only" on Start a call: the call becomes notes on a lead (one
// picked, or a new one the call names) and never a deal or contract. It's
// written up in the background the same way as a call from the Calls
// inbox, which is where the person lands to watch it finish.
export async function createNotesFromTranscript(formData: FormData) {
  await saveNotesCall(formData);
  // From the Notes page, back there: the call shows as being written up.
  redirect(formData.get("back") === "/notes" ? "/notes?added=1" : "/calls");
}

// A meeting recorded in the iPhone app: saved the same way, but the page
// moves on by itself, after deleting the recording from the phone.
export async function saveRecordedMeeting(formData: FormData): Promise<void> {
  formData.set("source", "app");
  await saveNotesCall(formData);
}

async function saveNotesCall(formData: FormData): Promise<void> {
  const transcript = String(formData.get("transcript") ?? "").trim();
  const leadId = String(formData.get("leadId") ?? "new").trim() || "new";
  const fromApp = formData.get("source") === "app";
  const fromRecording = fromApp || formData.get("source") === "recording";
  const seconds = Math.round(Number(formData.get("seconds")) || 0) || null;
  if (!transcript) throw new Error("Add the recording or paste the transcript first");
  if (transcript.length > 400_000) throw new Error("That transcript is too long. Use one call at a time");

  const workspace = await requireProspecting();
  const access = await leadAccess();
  const lead =
    leadId === "new"
      ? await prisma.lead.create({ data: { workspaceId: workspace.id, ownerId: access.userId, name: NEW_LEAD_NAME, source: "call" }, select: { id: true } })
      : await prisma.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id, AND: [access.where] }, select: { id: true } });
  if (!lead) throw new Error("That lead isn't available");

  const call = await prisma.phoneCall.create({
    data: {
      workspaceId: workspace.id,
      userId: access.userId,
      leadId: lead.id,
      source: fromApp ? "app" : fromRecording ? "upload" : "paste",
      mode: "notes",
      status: "processing",
      transcript,
      durationSec: seconds,
      sttSeconds: fromRecording ? seconds : null,
    },
    select: { id: true },
  });
  const timeZone = await cookieTimeZone();
  // A meeting recorded in the app was recorded on purpose, and one phone in a
  // room often hears everyone as one voice: write it up anyway. (The app
  // doesn't send recordings under MIN_PROCESS_SECONDS.)
  after(() => runCallProcessing(call.id, timeZone, { force: fromApp }));
}

// Desktop-app-only: starts a deal backed by a locally-recorded call instead
// of a Recall bot. Unlike the other actions here, this one returns a value
// instead of redirecting — the caller is a client component that still needs
// to kick off native audio capture (via Tauri) before navigating, and needs
// the upload token back to authenticate that capture's later upload.
export async function startLocalCapture(formData: FormData): Promise<{ dealId: string; token: string } | { error: string }> {
  const clientName = String(formData.get("clientName") ?? "").trim();
  const clientEmail = String(formData.get("clientEmail") ?? "").trim() || null;
  const templateId = String(formData.get("templateId") ?? "").trim();

  if (!clientName) return { error: "Enter who you're meeting with" };
  if (!templateId) return { error: "Choose a template" };

  const [workspace, user] = await Promise.all([requireWorkspace(), currentUserWithRole()]);
  const workspaceId = workspace.id;

  const client = await prisma.client.create({
    data: { workspaceId, name: clientName, company: clientName, email: clientEmail },
  });

  const deal = await prisma.deal.create({
    data: {
      workspaceId,
      clientId: client.id,
      templateId,
      ownerId: user.id,
      teamId: user.teamId,
      service: "",
      feeDisplay: "",
      status: "processing",
      source: "local",
    },
  });

  const call = await prisma.call.create({ data: { dealId: deal.id, source: "local" } });
  const rawToken = await mintLocalCaptureToken(workspaceId, deal.id, call.id);

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { callsUsedThisMonth: { increment: 1 } },
  });

  await dispatchDealCreated(workspaceId, deal.id);
  await notifySlack(workspaceId, { type: "deal.created", dealId: deal.id, clientName, service: "" });
  await syncDealToHubspot(workspaceId, deal.id);
  await syncDealToSalesforce(workspaceId, deal.id);

  return { dealId: deal.id, token: rawToken };
}

// Shared by startLocalCapture (brand-new deal) and continueLocalCapture (a
// follow-up call on an existing deal) — one Call, one token, always.
async function mintLocalCaptureToken(workspaceId: string, dealId: string, callId: string): Promise<string> {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  await prisma.localCaptureToken.create({
    data: {
      workspaceId,
      dealId,
      callId,
      tokenHash,
      // 4h covers even an unusually long call — the token is single-use and
      // burned the moment the recording is uploaded, well before that.
      expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
    },
  });
  return rawToken;
}

// Attaches a follow-up call to a deal that already exists, instead of
// spawning a new deal + client for what's really a continuation of the
// same negotiation. Reuses the deal's existing template.
export async function continueLocalCapture(dealId: string): Promise<{ dealId: string; token: string } | { error: string }> {
  const workspace = await requireWorkspace();

  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId: workspace.id } });
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

