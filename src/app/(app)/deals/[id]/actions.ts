"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { dispatchDealCreated } from "@/lib/webhooks";
import { requireWorkspaceId } from "@/lib/workspace";
import { applyExtractionToDeal, syncCoreDealFields } from "@/lib/deal-live";
import { documentLocksTerms } from "@/lib/contract-status";
import { contractTerms, extractPlaceholderKeys, type Clause } from "@/lib/contract";
import { fieldMeta } from "@/lib/field-meta";
import { auth } from "@/lib/auth";
import { canSendDocument, requestOrSendReview, type SendSetup } from "@/lib/review";
import { logAudit } from "@/lib/audit";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { currentUserWithRole } from "@/lib/permissions";
import { reportError } from "@/lib/error-report";
import { templateVersion } from "@/lib/deal-live-state";

const TERMS_LOCKED_ERROR = "This contract is with a reviewer or the client, so its terms can't change";
// What documentLocksTerms needs to tell a lapsed sign link from a live one.
const TERMS_LOCK_SELECT = { status: true, deliveryMethod: true, expiresAt: true } as const;

export type LiveFieldChange = { oldValue: string | null; newValue: string | null; changedBy: string; changedAt: Date };
export type LiveField = {
  id: string;
  fieldKey: string;
  groupLabel: string;
  label: string;
  value: string | null;
  status: string;
  sourceQuote: string | null;
  history: LiveFieldChange[];
};

// The text the document is drawn from: the contract's template once there
// is a contract (what a send uses), else the deal's. version is
// templateVersion (deal-live-state.ts): its id and a hash of its text.
export type LiveTemplate = { id: string; version: string; name: string; clauses: string };

// What a poll says about the template. The clauses run to tens of KB on an
// uploaded contract, so they only come back when the screen doesn't have
// them yet: templateKnown (the version the screen has) no longer matches.
export type LiveTemplateState =
  // Still the template the screen has; it keeps its own copy.
  | { templateUnchanged: true; template?: undefined }
  // A different template (picked again, or edited), or none at all.
  | { templateUnchanged: false; template: LiveTemplate | null };

export type LiveDealState = LiveTemplateState & {
  status: string;
  summary: string | null;
  fields: LiveField[];
  calls: { id: string; source: string; startedAt: Date; endedAt: Date | null; transcript: string }[];
  actionItems: { id: string; description: string; ownerType: string; dueDate: Date | null; status: string; sourceQuote: string | null }[];
  callHighlights: { id: string; type: string; body: string; sourceQuote: string | null }[];
  contract: { id: string; status: string; sentAt: string | null; viewedAt: string | null } | null;
  // The call the deal was made on (Start a call). Its transcript only grows
  // while it records, so each poll carries what came after the length the
  // page already has (transcriptKnown); when it got shorter (thrown away),
  // transcriptReset says transcriptAppend is the whole text instead.
  phoneCall: {
    id: string;
    status: string;
    startedAt: string;
    endedAt: string | null;
    transcriptLength: number;
    transcriptAppend: string;
    transcriptReset: boolean;
  } | null;
};

type FieldRow = { id: string; fieldKey: string; groupLabel: string; label: string; value: string | null; status: string; sourceQuote: string | null };
type FieldChangeRow = { fieldKey: string; oldValue: string | null; newValue: string | null; changedBy: string; changedAt: Date };

// Each term with its change history, as the deal page shows it.
function toLiveFields(fields: FieldRow[], changes: FieldChangeRow[]): LiveField[] {
  const historyByKey = new Map<string, FieldChangeRow[]>();
  for (const change of changes) {
    if (!historyByKey.has(change.fieldKey)) historyByKey.set(change.fieldKey, []);
    historyByKey.get(change.fieldKey)!.push(change);
  }
  return fields.map((f) => ({
    id: f.id,
    fieldKey: f.fieldKey,
    groupLabel: f.groupLabel,
    label: f.label,
    value: f.value,
    status: f.status,
    sourceQuote: f.sourceQuote,
    history: (historyByKey.get(f.fieldKey) ?? []).map((h) => ({ oldValue: h.oldValue, newValue: h.newValue, changedBy: h.changedBy, changedAt: h.changedAt })),
  }));
}

async function loadLiveFields(dealId: string): Promise<LiveField[]> {
  const [fields, changes] = await Promise.all([
    prisma.dealField.findMany({ where: { dealId }, orderBy: { orderIndex: "asc" } }),
    prisma.dealFieldChange.findMany({ where: { dealId }, orderBy: { changedAt: "asc" } }),
  ]);
  return toLiveFields(fields, changes);
}

const iso = (date: Date | null | undefined) => (date ? date.toISOString() : null);

// Polled by LiveDealView (a client component) every few seconds while a
// call is actively being recorded, so the extracted terms/summary/action
// items that a background upload-and-extract pass (see
// src/app/api/local-capture/transcribe/route.ts) writes to the DB show up
// on an already-open deal page without the rep having to navigate away and
// back — the same live-without-reload pattern ReviewPanel already uses for
// review state (src/app/(app)/deals/[id]/review-actions.ts's
// getReviewState).
// templateKnown: the version of the template the page already has, so the
// clauses can stay out of the answer while it's still the same one.
export async function getLiveDealState(dealId: string, transcriptKnown = 0, templateKnown: string | null = null): Promise<LiveDealState | null> {
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
      template: { select: { id: true, name: true, clauses: true } },
      contract: { select: { id: true, status: true, sentAt: true, viewedAt: true, template: { select: { id: true, name: true, clauses: true } } } },
      phoneCall: { select: { id: true, status: true, startedAt: true, endedAt: true, transcript: true } },
    },
  });
  if (!deal) return null;

  const template = deal.contract?.template ?? deal.template;
  const version = template ? templateVersion(template) : null;
  const templateState: LiveTemplateState =
    version && typeof templateKnown === "string" && templateKnown === version
      ? { templateUnchanged: true }
      : { templateUnchanged: false, template: template && version ? { id: template.id, version, name: template.name, clauses: template.clauses } : null };
  const known = typeof transcriptKnown === "number" && Number.isFinite(transcriptKnown) && transcriptKnown > 0 ? Math.floor(transcriptKnown) : 0;
  const transcript = deal.phoneCall?.transcript ?? "";
  // Discarding a recording empties the transcript, so a shorter one is a new
  // text, not more of the old one.
  const transcriptReset = transcript.length < known;

  return {
    ...templateState,
    status: deal.status,
    summary: deal.summary,
    fields: toLiveFields(deal.fields, deal.fieldChanges),
    calls: deal.calls.map((c) => ({ id: c.id, source: c.source, startedAt: c.startedAt, endedAt: c.endedAt, transcript: c.transcript })),
    actionItems: deal.actionItems.map((a) => ({ id: a.id, description: a.description, ownerType: a.ownerType, dueDate: a.dueDate, status: a.status, sourceQuote: a.sourceQuote })),
    callHighlights: deal.callHighlights.map((h) => ({ id: h.id, type: h.type, body: h.body, sourceQuote: h.sourceQuote })),
    contract: deal.contract ? { id: deal.contract.id, status: deal.contract.status, sentAt: iso(deal.contract.sentAt), viewedAt: iso(deal.contract.viewedAt) } : null,
    phoneCall: deal.phoneCall
      ? {
          id: deal.phoneCall.id,
          status: deal.phoneCall.status,
          startedAt: deal.phoneCall.startedAt.toISOString(),
          endedAt: iso(deal.phoneCall.endedAt),
          transcriptLength: transcript.length,
          transcriptAppend: transcriptReset ? transcript : transcript.slice(known),
          transcriptReset,
        }
      : null,
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
  if (deal.kind === "proposal") return { error: "Proposals go out by email or link, not DocuSign" };
  if (deal.trashedAt) return { error: "This contract is in the trash. Restore it first" };
  if (deal.contract.status !== "draft") return { error: "This contract was already sent" };
  if (!deal.workspace.docusignEnabled) return { error: "DocuSign isn't connected for this workspace" };
  if (!deal.client.email) return { error: "This client has no email on file yet. Add one first" };

  const subject = `${deal.template.name} from ${deal.workspace.name}`;
  const message = `Hi ${deal.client.name.split(" ")[0]},\n\nHere's the ${deal.template.name.toLowerCase()} we just discussed. Take a look and sign whenever you're ready.`;

  const session = await auth();
  let result: Awaited<ReturnType<typeof requestOrSendReview>>;
  try {
    result = await requestOrSendReview(dealId, { to: deal.client.email, subject, message }, session?.user?.email, { deliveryMethod: "docusign" });
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
  if (missing) throw new Error(`Cannot generate a ${deal.kind === "proposal" ? "proposal" : "contract"} while information is missing`);

  await prisma.contract.upsert({
    where: { dealId },
    create: { dealId, templateId: deal.templateId, status: "draft" },
    update: {},
  });

  if (deal.status !== "sent" && deal.status !== "signed" && deal.status !== "pending_approval") {
    await prisma.deal.update({ where: { id: dealId }, data: { status: "ready" } });
  }

  // The deal page is the contract screen.
  redirect(`/deals/${dealId}`);
}

// The draft generateContract would make, for the contract screen, which
// stays where it is: refused while a term is missing (the way the send
// itself checks it: an empty row, or a term the text has with no value) and
// from the trash. Returns the Contract row's id.
async function makeDraft(dealId: string): Promise<{ error: string } | { contractId: string | null }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: { fields: true, template: { select: { clauses: true } }, contract: { select: { status: true, template: { select: { clauses: true } } } } },
  });
  if (!deal) return { error: "Deal not found" };
  const doc = deal.kind === "proposal" ? "proposal" : "contract";
  if (deal.trashedAt) return { error: `This ${doc} is in the trash. Restore it first` };

  const clauses = deal.contract?.template?.clauses ?? deal.template?.clauses;
  const terms = contractTerms(clauses ? (JSON.parse(clauses) as Clause[]) : [], deal.fields, (key) => fieldMeta(key).label);
  const missing = terms.filter((t) => t.state === "empty" || deal.fields.some((f) => f.fieldKey === t.key && f.status === "missing"));
  if (missing.length > 0) {
    return { error: `Fill in ${missing.map((t) => t.label).join(", ")} before sending. The ${doc} still has blanks` };
  }

  const contract = await prisma.contract.upsert({
    where: { dealId },
    create: { dealId, templateId: deal.templateId, status: "draft" },
    update: {},
  });

  // A contract that exists already keeps the deal's status: it may be out
  // for changes, or past a lapsed link, which "ready" would hide.
  if (!deal.contract && deal.status !== "sent" && deal.status !== "signed" && deal.status !== "pending_approval") {
    await prisma.deal.update({ where: { id: dealId }, data: { status: "ready" } });
  }
  return { contractId: contract?.id ?? null };
}

// "Send for signature" on the contract screen when there's no contract yet
// (a call still on, or a deal never opened as a contract): the draft, then
// straight to the Send page. Refusals come back as { error }, since a thrown
// message is hidden in production.
export async function generateContractAndSend(dealId: string): Promise<{ error?: string }> {
  const made = await makeDraft(dealId);
  if ("error" in made) return { error: made.error };
  redirect(`/deals/${dealId}/send`);
}

// Copy link and Download PDF on a proposal that has no document yet (one
// made from a call with blanks, filled in later on the paper): the draft is
// made right there, so the link and the PDF work without a trip to the Send
// page. Nothing goes out from here.
export async function makeDocumentDraft(dealId: string): Promise<{ error?: string; contractId?: string }> {
  const made = await makeDraft(dealId);
  if ("error" in made) return { error: made.error };
  if (!made.contractId) return { error: "Couldn't make it. Try again" };
  revalidatePath(`/deals/${dealId}`);
  return { contractId: made.contractId };
}

export async function fillMissingFields(dealId: string, formData: FormData) {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { fields: true, contract: { select: TERMS_LOCK_SELECT } } });
  if (!deal) throw new Error("Deal not found");
  if (documentLocksTerms(deal.contract, deal.kind)) throw new Error(TERMS_LOCKED_ERROR);

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

type EditableDeal = { id: string; clientId: string; status: string };
type EditableField = { id: string; fieldKey: string; value: string | null; status: string };

// The rep's own values for some of a deal's terms. A cleared term is missing
// again: it shows up to be filled in and the contract can't go out with a raw
// "{fee}" in it. A changed value keeps the old one in the history. Then the
// copies on the deal and client follow, and the deal moves between "missing
// info" and "ready". Returns the deal's status after.
async function saveFieldEdits(deal: EditableDeal, edits: { field: EditableField; value: string }[]): Promise<string> {
  const dealId = deal.id;
  const changed: { fieldKey: string; value: string }[] = [];
  for (const { field, value: raw } of edits) {
    const value = raw.trim();
    if (!value) {
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
    return "ready";
  }
  if (stillMissing > 0 && deal.status === "ready") {
    await prisma.deal.update({ where: { id: dealId }, data: { status: "missing_info" } });
    return "missing_info";
  }
  return deal.status;
}

export async function updateFieldValues(dealId: string, formData: FormData) {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { fields: true, contract: { select: TERMS_LOCK_SELECT } } });
  if (!deal) throw new Error("Deal not found");
  if (documentLocksTerms(deal.contract, deal.kind)) throw new Error(TERMS_LOCKED_ERROR);

  // A form may edit only some of the fields; absent ones stay as-is.
  const edits = deal.fields.filter((field) => formData.has(field.id)).map((field) => ({ field, value: String(formData.get(field.id) ?? "") }));
  await saveFieldEdits(deal, edits);

  // Every way in ends on the deal page, the one contract screen (a form
  // that still says returnTo=contract included).
  revalidatePath(`/deals/${dealId}`);
  redirect(`/deals/${dealId}`);
}

// One term typed in on the contract screen (on the paper, or in the list of
// terms), saved without leaving the page: the screen shows it at once and
// takes the terms and status that come back. Same checks and writes as
// updateFieldValues; an empty value makes the term missing again. A term
// the text has but the deal has no row for (the template changed after the
// deal was made) gets its row here. Refusals come back as { error }, since a
// thrown message is hidden in production.
export async function setDealField(dealId: string, fieldKey: string, value: string): Promise<{ error?: string; fields?: LiveField[]; status?: string }> {
  if (typeof fieldKey !== "string" || !/^\w+$/.test(fieldKey)) return { error: "This deal has no such term" };
  const text = typeof value === "string" ? value : "";

  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: { fields: true, template: { select: { clauses: true } }, contract: { select: { ...TERMS_LOCK_SELECT, template: { select: { clauses: true } } } } },
  });
  if (!deal) return { error: "Deal not found" };
  if (documentLocksTerms(deal.contract, deal.kind)) return { error: TERMS_LOCKED_ERROR };

  try {
    let field: EditableField | undefined = deal.fields.find((f) => f.fieldKey === fieldKey);
    if (!field) {
      const clauses = deal.contract?.template?.clauses ?? deal.template?.clauses;
      const keys = clauses ? extractPlaceholderKeys(clauses) : [];
      if (!keys.includes(fieldKey)) return { error: "This deal has no such term anymore" };
      // Nothing to clear on a term that was never filled in.
      if (!text.trim()) return { fields: await loadLiveFields(dealId), status: deal.status };
      const meta = fieldMeta(fieldKey);
      // Made empty first, so the edit below writes it the one usual way
      // (and a row a reading of the call made meanwhile is edited, not doubled).
      field = await prisma.dealField.upsert({
        where: { dealId_fieldKey: { dealId, fieldKey } },
        create: { dealId, fieldKey, label: meta.label, groupLabel: meta.groupLabel, value: null, status: "missing", orderIndex: keys.indexOf(fieldKey) },
        update: {},
      });
    }

    const status = await saveFieldEdits(deal, [{ field, value: text }]);
    revalidatePath(`/deals/${dealId}`);
    revalidatePath(`/deals/${dealId}/contract`);
    return { fields: await loadLiveFields(dealId), status };
  } catch (err) {
    await reportError(err, "Saving a deal term", { dealId, fieldKey });
    return { error: "Couldn't save that. Try again" };
  }
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
  if (documentLocksTerms(deal.contract, deal.kind)) return { error: TERMS_LOCKED_ERROR };

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

  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where }, include: { contract: true } });
  if (!deal || !deal.contract) return { status: "error", error: "Deal not found" };
  // A proposal is only read: nobody signs it, so there are no signers and no
  // DocuSign, whatever the form sent.
  const isProposal = deal.kind === "proposal";
  const doc = isProposal ? "proposal" : "contract";
  // Nothing goes out from the trash: the client's link there doesn't open.
  if (deal.trashedAt) return { status: "error", error: `This ${doc} is in the trash. Restore it first` };
  if (!canSendDocument(deal.contract, deal.kind)) {
    return { status: "error", error: deal.contract.status === "pending_approval" ? `This ${doc} is already waiting on review` : `This ${doc} was already sent` };
  }

  let countersigners: { name: string; email: string; role: string }[] = [];
  if (!isProposal) {
    const signerNames = formData.getAll("signerName").map((v) => String(v).trim());
    const signerEmails = formData.getAll("signerEmail").map((v) => String(v).trim());
    const signerRoles = formData.getAll("signerRole").map((v) => String(v).trim());
    const signerRows = signerNames.map((name, i) => ({ name, email: signerEmails[i] ?? "", role: signerRoles[i] || "Counter-signer" }));
    // A row with only a name or only an email would otherwise be dropped
    // without a word, taking that signer off the contract.
    if (signerRows.some((s) => !s.name !== !s.email)) {
      return { status: "error", error: "Add a name and an email for each additional signer, or remove the row" };
    }
    countersigners = signerRows.filter((s) => s.name && s.email);
  }

  // CC list, counter-signers, and delivery method are contract setup, not
  // part of the approval-gated email content. requestOrSendReview stores
  // them only in the write that records the send, or as a review starts
  // holding it, so a send that's refused, loses to another or fails leaves
  // the contract as its last round went out.
  const setup: SendSetup = {
    deliveryMethod: !isProposal && String(formData.get("deliveryMethod") ?? "sealme") === "docusign" ? "docusign" : "sealme",
    ccEmails: ccList,
    countersigners: isProposal ? undefined : countersigners,
  };

  const session = await auth();
  let result: Awaited<ReturnType<typeof requestOrSendReview>>;
  try {
    result = await requestOrSendReview(dealId, { to, subject, message }, session?.user?.email, setup);
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
  // A proposal is never signed, and a renewal is a new contract to sign.
  if (deal.kind === "proposal") throw new Error("A proposal can't be renewed");
  if (deal.contract?.status !== "signed") throw new Error("Only a signed deal can be renewed");

  const newDeal = await prisma.deal.create({
    data: {
      workspaceId,
      clientId: deal.clientId,
      // The renewal is on the same lead, as the same kind of document.
      leadId: deal.leadId,
      kind: deal.kind,
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

  redirect(`/deals/${newDeal.id}`);
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
