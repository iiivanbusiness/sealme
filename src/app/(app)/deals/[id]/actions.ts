"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { dispatchDealCreated } from "@/lib/webhooks";
import { requireWorkspaceId } from "@/lib/workspace";
import { applyExtractionToDeal, contractLocksTerms, syncCoreDealFields } from "@/lib/deal-live";
import { extractPlaceholderKeys } from "@/lib/contract";
import { auth } from "@/lib/auth";
import { canSendContract, requestOrSendReview } from "@/lib/review";
import { logAudit } from "@/lib/audit";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { currentUserWithRole } from "@/lib/permissions";
import { randomBytes } from "crypto";
import { reportError } from "@/lib/error-report";

const TERMS_LOCKED_ERROR = "This contract is with a reviewer or the client, so its terms can't change";
// What contractLocksTerms needs to tell a lapsed sign link from a live one.
const TERMS_LOCK_SELECT = { status: true, deliveryMethod: true, expiresAt: true } as const;

export type LiveDealState = {
  status: string;
  summary: string | null;
  fields: {
    id: string;
    fieldKey: string;
    groupLabel: string;
    label: string;
    value: string | null;
    status: string;
    sourceQuote: string | null;
    history: { oldValue: string | null; newValue: string | null; changedBy: string; changedAt: Date }[];
  }[];
  calls: { id: string; source: string; startedAt: Date; endedAt: Date | null; transcript: string }[];
  actionItems: { id: string; description: string; ownerType: string; dueDate: Date | null; status: string; sourceQuote: string | null }[];
  callHighlights: { id: string; type: string; body: string; sourceQuote: string | null }[];
};

// Polled by LiveDealView (a client component) every few seconds while a
// call is actively being recorded, so the extracted terms/summary/action
// items that a background upload-and-extract pass (see
// src/app/api/local-capture/transcribe/route.ts) writes to the DB show up
// on an already-open deal page without the rep having to navigate away and
// back — the same live-without-reload pattern ReviewPanel already uses for
// review state (src/app/(app)/deals/[id]/review-actions.ts's
// getReviewState).
export async function getLiveDealState(dealId: string): Promise<LiveDealState | null> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
      calls: { orderBy: { startedAt: "asc" } },
      fieldChanges: { orderBy: { changedAt: "asc" } },
      actionItems: { orderBy: { createdAt: "asc" } },
      callHighlights: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!deal) return null;

  const historyByKey = new Map<string, typeof deal.fieldChanges>();
  for (const change of deal.fieldChanges) {
    if (!historyByKey.has(change.fieldKey)) historyByKey.set(change.fieldKey, []);
    historyByKey.get(change.fieldKey)!.push(change);
  }

  return {
    status: deal.status,
    summary: deal.summary,
    fields: deal.fields.map((f) => ({
      id: f.id,
      fieldKey: f.fieldKey,
      groupLabel: f.groupLabel,
      label: f.label,
      value: f.value,
      status: f.status,
      sourceQuote: f.sourceQuote,
      history: (historyByKey.get(f.fieldKey) ?? []).map((h) => ({ oldValue: h.oldValue, newValue: h.newValue, changedBy: h.changedBy, changedAt: h.changedAt })),
    })),
    calls: deal.calls.map((c) => ({ id: c.id, source: c.source, startedAt: c.startedAt, endedAt: c.endedAt, transcript: c.transcript })),
    actionItems: deal.actionItems.map((a) => ({ id: a.id, description: a.description, ownerType: a.ownerType, dueDate: a.dueDate, status: a.status, sourceQuote: a.sourceQuote })),
    callHighlights: deal.callHighlights.map((h) => ({ id: h.id, type: h.type, body: h.body, sourceQuote: h.sourceQuote })),
  };
}

export async function retryExtraction(dealId: string) {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { template: true } });
  if (!deal || !deal.template) throw new Error("Deal not found");

  try {
    const placeholderKeys = extractPlaceholderKeys(deal.template.clauses);
    await applyExtractionToDeal(dealId, deal.liveTranscript ?? "", placeholderKeys);
  } catch (err) {
    await reportError(err, "Retry extraction", { dealId });
    await prisma.deal.update({ where: { id: dealId }, data: { status: "extraction_failed" } });
  }

  redirect(`/deals/${dealId}`);
}

// One-click "send it right now" — meant for the moment a deal goes
// "ready" mid-call: instead of the full Send page (to/cc/subject/message,
// extra signers), this fires immediately with sane defaults, routed
// through DocuSign so the client's own DocuSign email is what reaches
// them. Still goes through requestOrSendReview, so a configured
// review chain still gates it exactly like any other send — this is a
// shortcut to the same pipeline, not a way around it. A confirmation
// click (not a fully silent auto-send) on purpose: the rep glances at the
// terms and decides, rather than the system sending without anyone looking.
// heldForReviewBy: a review chain caught it, so nothing went out yet.
export async function sendViaDocusignNow(dealId: string): Promise<{ error?: string; heldForReviewBy?: string }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: { client: true, template: true, contract: true, workspace: true },
  });
  if (!deal || !deal.contract || !deal.template) return { error: "Deal not found" };
  if (deal.contract.status !== "draft") return { error: "This contract was already sent" };
  if (!deal.workspace.docusignEnabled) return { error: "DocuSign isn't connected for this workspace" };
  if (!deal.client.email) return { error: "This client has no email on file yet. Add one first" };

  await prisma.contract.update({ where: { id: deal.contract.id }, data: { deliveryMethod: "docusign" } });

  const subject = `${deal.template.name} from ${deal.workspace.name}`;
  const message = `Hi ${deal.client.name.split(" ")[0]},\n\nHere's the ${deal.template.name.toLowerCase()} we just discussed. Take a look and sign whenever you're ready.`;

  const session = await auth();
  let result: Awaited<ReturnType<typeof requestOrSendReview>>;
  try {
    result = await requestOrSendReview(dealId, { to: deal.client.email, subject, message }, session?.user?.email);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't send via DocuSign" };
  }

  revalidatePath(`/deals/${dealId}`);
  return result.status === "pending_approval" ? { heldForReviewBy: result.assigneeName } : {};
}

export async function generateContract(dealId: string) {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { fields: true } });
  if (!deal) throw new Error("Deal not found");

  const missing = deal.fields.some((f) => f.status === "missing");
  if (missing) throw new Error("Cannot generate a contract while information is missing");

  await prisma.contract.upsert({
    where: { dealId },
    create: { dealId, templateId: deal.templateId, status: "draft" },
    update: {},
  });

  if (deal.status !== "sent" && deal.status !== "signed" && deal.status !== "pending_approval") {
    await prisma.deal.update({ where: { id: dealId }, data: { status: "ready" } });
  }

  redirect(`/deals/${dealId}/contract`);
}

export async function fillMissingFields(dealId: string, formData: FormData) {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { fields: true, contract: { select: TERMS_LOCK_SELECT } } });
  if (!deal) throw new Error("Deal not found");
  if (contractLocksTerms(deal.contract)) throw new Error(TERMS_LOCKED_ERROR);

  const missingFields = deal.fields.filter((f) => f.status === "missing");
  const changed: { fieldKey: string; value: string }[] = [];
  for (const field of missingFields) {
    const value = String(formData.get(field.id) ?? "").trim();
    if (!value) continue;
    await prisma.dealField.update({
      where: { id: field.id },
      data: { value, status: "confirmed", groupLabel: "Confirmed details" },
    });
    changed.push({ fieldKey: field.fieldKey, value });
  }
  await syncCoreDealFields(dealId, deal.clientId, changed);

  const stillMissing = await prisma.dealField.count({ where: { dealId, status: "missing" } });
  if (stillMissing === 0 && deal.status === "missing_info") {
    await prisma.deal.update({ where: { id: dealId }, data: { status: "ready" } });
  }

  redirect(`/deals/${dealId}`);
}

export async function updateFieldValues(dealId: string, formData: FormData) {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { fields: true, contract: { select: TERMS_LOCK_SELECT } } });
  if (!deal) throw new Error("Deal not found");
  if (contractLocksTerms(deal.contract)) throw new Error(TERMS_LOCKED_ERROR);

  const changed: { fieldKey: string; value: string }[] = [];
  for (const field of deal.fields) {
    // The contract page edits only one clause's fields; absent ones stay as-is.
    if (!formData.has(field.id)) continue;
    const value = String(formData.get(field.id) ?? "").trim();
    if (!value) {
      // A cleared term is missing again: it shows up to be filled in and the
      // contract can't go out with a raw "{fee}" in it.
      if (field.status === "missing") continue;
      if (field.value) {
        await prisma.dealFieldChange.create({
          data: { dealId, fieldKey: field.fieldKey, oldValue: field.value, newValue: null, changedBy: "manual" },
        });
      }
      await prisma.dealField.update({ where: { id: field.id }, data: { value: null, status: "missing" } });
      continue;
    }
    if (value === field.value) continue;
    if (field.value) {
      await prisma.dealFieldChange.create({
        data: { dealId, fieldKey: field.fieldKey, oldValue: field.value, newValue: value, changedBy: "manual" },
      });
    }
    await prisma.dealField.update({
      where: { id: field.id },
      // A term the call never covered, typed in here, counts the same as one
      // filled in on the Missing information card.
      data: { value, status: field.status === "missing" ? "confirmed" : "user_edited" },
    });
    changed.push({ fieldKey: field.fieldKey, value });
  }
  await syncCoreDealFields(dealId, deal.clientId, changed);

  const stillMissing = await prisma.dealField.count({ where: { dealId, status: "missing" } });
  if (stillMissing === 0 && deal.status === "missing_info") {
    await prisma.deal.update({ where: { id: dealId }, data: { status: "ready" } });
  } else if (stillMissing > 0 && deal.status === "ready") {
    await prisma.deal.update({ where: { id: dealId }, data: { status: "missing_info" } });
  }

  if (formData.get("returnTo") === "contract") {
    revalidatePath(`/deals/${dealId}`);
    redirect(`/deals/${dealId}/contract?updated=1`);
  }
  redirect(`/deals/${dealId}`);
}

// Applies exactly one field change the rep already confirmed after hearing
// it read back (see /api/deals/[id]/voice-correction) — same
// value/history-tracking shape as updateFieldValues, just for a single
// field triggered from the voice-correction UI instead of the edit form.
// Refusals come back as { error } (a thrown message is hidden in production)
// so VoiceCorrectionButton can say why.
export async function applyVoiceFieldCorrection(dealId: string, fieldKey: string, newValue: string): Promise<{ error?: string }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { fields: true, contract: { select: TERMS_LOCK_SELECT } } });
  if (!deal) return { error: "Deal not found" };
  if (contractLocksTerms(deal.contract)) return { error: TERMS_LOCKED_ERROR };

  const field = deal.fields.find((f) => f.fieldKey === fieldKey);
  if (!field) return { error: "This deal has no such term anymore" };

  const value = newValue.trim();
  if (value && value !== field.value) {
    if (field.status === "missing") {
      // Filling in a previously-missing field via voice — same status/group
      // shift as the manual "missing info" form (fillMissingFields), so it
      // moves out of the Missing card into the regular deal-terms groups
      // instead of just sitting there with a value but the wrong status.
      await prisma.dealField.update({ where: { id: field.id }, data: { value, status: "confirmed", groupLabel: "Confirmed details" } });
    } else {
      if (field.value) {
        await prisma.dealFieldChange.create({
          data: { dealId, fieldKey: field.fieldKey, oldValue: field.value, newValue: value, changedBy: "voice" },
        });
      }
      await prisma.dealField.update({ where: { id: field.id }, data: { value, status: "user_edited" } });
    }
    await syncCoreDealFields(dealId, deal.clientId, [{ fieldKey: field.fieldKey, value }]);

    const stillMissing = await prisma.dealField.count({ where: { dealId, status: "missing" } });
    if (stillMissing === 0 && deal.status === "missing_info") {
      await prisma.deal.update({ where: { id: dealId }, data: { status: "ready" } });
    }
  }

  revalidatePath(`/deals/${dealId}`);
  return {};
}

type SendContractResult = Awaited<ReturnType<typeof requestOrSendReview>> | { status: "error"; error: string };

export async function sendContractEmail(dealId: string, formData: FormData): Promise<SendContractResult> {
  const to = String(formData.get("to") ?? "").trim();
  const subject = String(formData.get("subject") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();
  if (!to || !subject || !message) return { status: "error", error: "To, subject, and message are all required" };

  const ccRaw = String(formData.get("cc") ?? "").trim();
  const ccList = ccRaw
    ? ccRaw.split(",").map((e) => e.trim()).filter(Boolean)
    : [];

  const signerNames = formData.getAll("signerName").map((v) => String(v).trim());
  const signerEmails = formData.getAll("signerEmail").map((v) => String(v).trim());
  const signerRoles = formData.getAll("signerRole").map((v) => String(v).trim());
  const signerRows = signerNames.map((name, i) => ({ name, email: signerEmails[i] ?? "", role: signerRoles[i] || "Counter-signer" }));
  // A row with only a name or only an email would otherwise be dropped
  // without a word, taking that signer off the contract.
  if (signerRows.some((s) => !s.name !== !s.email)) {
    return { status: "error", error: "Add a name and an email for each additional signer, or remove the row" };
  }
  const countersigners = signerRows.filter((s) => s.name && s.email);

  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { contract: true } });
  if (!deal || !deal.contract) return { status: "error", error: "Deal not found" };
  if (!canSendContract(deal.contract)) {
    return { status: "error", error: deal.contract.status === "pending_approval" ? "This contract is already waiting on review" : "This contract was already sent" };
  }

  const deliveryMethod = String(formData.get("deliveryMethod") ?? "sealme") === "docusign" ? "docusign" : "sealme";

  // CC list, counter-signers, and delivery method are contract setup, not
  // part of the approval-gated email content — stored immediately
  // regardless of whether an approval chain holds the actual send.
  await prisma.contract.update({
    where: { id: deal.contract.id },
    data: { ccEmails: ccList.length > 0 ? JSON.stringify(ccList) : null, deliveryMethod },
  });
  // The Send page starts from the current signers, so what comes back is the
  // whole list: it replaces everyone on an earlier version, including anyone
  // who signed or declined it, and an empty list means no counter-signers
  // (how a rep takes off one who declined).
  try {
    await prisma.contractSigner.deleteMany({ where: { contractId: deal.contract.id } });
    if (countersigners.length > 0) {
      await prisma.contractSigner.createMany({
        data: countersigners.map((s, i) => ({
          contractId: deal.contract!.id,
          name: s.name,
          email: s.email,
          role: s.role,
          order: i + 1,
          token: randomBytes(24).toString("hex"),
        })),
      });
    }
  } catch (err) {
    await reportError(err, "Save counter-signers", { dealId });
    return { status: "error", error: "Couldn't save the additional signers. Try again" };
  }

  const session = await auth();
  let result: Awaited<ReturnType<typeof requestOrSendReview>>;
  try {
    result = await requestOrSendReview(dealId, { to, subject, message }, session?.user?.email);
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : "Couldn't send the email. Check your Resend setup and try again." };
  }

  return result;
}

// Spins up a fresh deal for the same client, pre-filled with the current
// terms — the "renewal proposal" starting point. Values come in already
// "confirmed" (they're a known-good copy of what the client already signed
// once), so the new deal is immediately reviewable/sendable instead of
// looking like it's missing information. Owned by whoever starts the
// renewal, not carried over from the original deal's owner.
export async function startRenewal(dealId: string) {
  const currentUser = await currentUserWithRole();
  const { where, userId } = await dealVisibilityFilter(currentUser);
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: { fields: true, contract: true },
  });
  if (!deal) throw new Error("Deal not found");
  if (deal.contract?.status !== "signed") throw new Error("Only a signed deal can be renewed");

  const newDeal = await prisma.deal.create({
    data: {
      workspaceId,
      clientId: deal.clientId,
      templateId: deal.templateId,
      ownerId: userId,
      teamId: currentUser.teamId,
      service: deal.service,
      feeDisplay: deal.feeDisplay,
      status: "ready",
      source: "renewal",
      fields: {
        create: deal.fields.map((f) => ({
          groupLabel: f.groupLabel,
          label: f.label,
          fieldKey: f.fieldKey,
          value: f.value,
          status: f.value ? "confirmed" : "missing",
          orderIndex: f.orderIndex,
        })),
      },
      contract: { create: { templateId: deal.templateId, status: "draft" } },
    },
  });

  const session = await auth();
  await logAudit({
    workspaceId,
    actorEmail: session?.user?.email,
    action: "deal.renewal_started",
    targetType: "Deal",
    targetId: newDeal.id,
    metadata: { fromDealId: dealId },
  });
  await dispatchDealCreated(workspaceId, newDeal.id);

  redirect(`/deals/${newDeal.id}/contract`);
}

export async function toggleActionItem(dealId: string, itemId: string): Promise<{ error?: string }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const item = await prisma.actionItem.findFirst({ where: { id: itemId, dealId, deal: { workspaceId, ...where } } });
  if (!item) return { error: "Action item not found" };

  const done = item.status !== "done";
  await prisma.actionItem.update({
    where: { id: itemId },
    data: { status: done ? "done" : "open", doneAt: done ? new Date() : null },
  });

  revalidatePath(`/deals/${dealId}`);
  return {};
}

// Internal-only note thread on a deal — never shown to the client, unlike
// ClauseComment (client-authored, tied to one clause) or an approval
// step's note (tied to one decision). This is just "the team left context
// here," the gap a real CRM's activity feed fills.
export async function addDealNote(dealId: string, body: string): Promise<{ error?: string }> {
  const text = body.trim();
  if (!text) return { error: "Note can't be empty" };

  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const currentUser = await currentUserWithRole();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where } });
  if (!deal) return { error: "Deal not found" };

  await prisma.dealNote.create({
    data: { dealId, authorEmail: currentUser.email, authorName: currentUser.name, body: text },
  });

  revalidatePath(`/deals/${dealId}`);
  return {};
}

export async function deleteDealNote(dealId: string, noteId: string): Promise<{ error?: string }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const currentUser = await currentUserWithRole();
  const note = await prisma.dealNote.findFirst({ where: { id: noteId, dealId, deal: { workspaceId, ...where } } });
  if (!note) return { error: "Note not found" };
  if (note.authorEmail !== currentUser.email && !currentUser.role?.canManageWorkspace) {
    return { error: "Only the author or a workspace admin can delete this note" };
  }

  await prisma.dealNote.delete({ where: { id: noteId } });
  revalidatePath(`/deals/${dealId}`);
  return {};
}
