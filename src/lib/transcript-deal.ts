import { prisma } from "@/lib/db";
import { extractDealFromTranscript, buildDealFieldRows, fieldMeta } from "@/lib/extract-deal";
import { extractActionItems } from "@/lib/extract-action-items";
import { extractCallHighlights } from "@/lib/extract-call-highlights";
import { extractPlaceholderKeys } from "@/lib/contract";
import { announceNewDeal } from "@/lib/api-deals";
import { reportError } from "@/lib/error-report";
import { fillKnownDetails } from "@/lib/known-details";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type KnownClient = { name: string; company: string | null; title?: string | null; email: string | null; phone: string | null; hubspotContactId?: string; salesforceContactId?: string };

export type TranscriptDeal = { dealId: string; callId: string; clientId: string; clientName: string; service: string; summary: string | null; hasMissing: boolean };

// A call transcript becomes a client and a deal on the chosen template:
// the terms are read off the call, anything the template needs that the
// call didn't say is marked missing. Used by "Paste a transcript" and by a
// sales call from the Calls inbox. Throws if the terms can't be read, so
// the caller decides what the rep sees.
//
// knownClient: who the call was with, when SealMe already knows (a lead).
// Their name and contact details win over what the model heard, a client
// with the same email is reused, and a new client keeps the lead's CRM
// record. requireEmail adds a "Client email"
// detail to fill in when neither the lead nor the call gave one, so the
// contract can't be sent to nobody.
export async function createDealFromTranscriptText(options: {
  workspaceId: string;
  ownerId: string;
  teamId: string | null;
  templateId: string;
  transcript: string;
  callSource: string; // Call.source
  dealSource: string; // Deal.source
  knownClient?: KnownClient | null;
  requireEmail?: boolean;
  note?: { authorEmail: string; authorName: string; body: string } | null;
}): Promise<TranscriptDeal> {
  const { workspaceId, knownClient } = options;
  const template = await prisma.contractTemplate.findFirst({ where: { id: options.templateId, workspaceId } });
  if (!template) throw new Error("Template not found");

  const placeholderKeys = extractPlaceholderKeys(template.clauses);
  const extracted = await extractDealFromTranscript(options.transcript, placeholderKeys);
  const built = buildDealFieldRows(extracted, placeholderKeys);

  const clientName = knownClient?.name || extracted.clientName;
  const company = knownClient?.company || extracted.company || clientName;
  const heardEmail = extracted.email?.trim().toLowerCase() || null;
  const email = knownClient?.email?.toLowerCase() || (heardEmail && EMAIL.test(heardEmail) ? heardEmail : null);

  const existingClient = knownClient && email ? await prisma.client.findFirst({ where: { workspaceId, email: { equals: email, mode: "insensitive" } } }) : null;

  // A known client's contract is with their company, when there is one.
  let fieldRows = knownClient ? built.fieldRows.map((f) => (f.fieldKey === "clientName" ? { ...f, value: company, status: "confirmed", confidence: null } : f)) : built.fieldRows;
  // What a template asks about the person ({clientEmail}, {clientSignerName},
  // {contactTitle}, {billingAddress}) and the call didn't say comes from the
  // lead and the client on file, rather than holding up the contract. A
  // deal has one row per field, so none is ever added for these.
  fieldRows = fillKnownDetails(fieldRows, {
    name: knownClient?.name,
    title: knownClient?.title,
    email,
    phone: knownClient?.phone,
    address: existingClient?.billingAddress,
  });
  if (options.requireEmail && !email && !fieldRows.some((f) => f.fieldKey === "clientEmail")) {
    const meta = fieldMeta("clientEmail");
    fieldRows = [...fieldRows, { groupLabel: meta.groupLabel, label: meta.label, fieldKey: "clientEmail", value: null, status: "missing", confidence: null, sourceQuote: null, orderIndex: fieldRows.length }];
  }
  const hasMissing = fieldRows.some((f) => f.status === "missing");

  const deal = await prisma.$transaction(async (tx) => {
    const client =
      existingClient ??
      (await tx.client.create({
        data: {
          workspaceId,
          name: clientName,
          company,
          email,
          ...(knownClient?.phone ? { phone: knownClient.phone } : {}),
          ...(knownClient?.hubspotContactId ? { hubspotContactId: knownClient.hubspotContactId } : {}),
          ...(knownClient?.salesforceContactId ? { salesforceContactId: knownClient.salesforceContactId } : {}),
        },
      }));
    const created = await tx.deal.create({
      data: {
        workspaceId,
        clientId: client.id,
        templateId: template.id,
        ownerId: options.ownerId,
        teamId: options.teamId,
        service: built.service,
        feeDisplay: built.fee,
        status: hasMissing ? "missing_info" : "ready",
        summary: extracted.summary,
        source: options.dealSource,
        fields: { create: fieldRows },
        calls: { create: { transcript: options.transcript, source: options.callSource, endedAt: new Date() } },
        ...(options.note ? { notes: { create: options.note } } : {}),
      },
      include: { calls: true },
    });
    await tx.workspace.update({ where: { id: workspaceId }, data: { callsUsedThisMonth: { increment: 1 } } });
    return created;
  });

  return { dealId: deal.id, callId: deal.calls[0].id, clientId: deal.clientId, clientName, service: built.service, summary: extracted.summary, hasMissing };
}

// The slow half, for after the rep is already looking at the deal: action
// items and highlights from the call (two more model calls), then the
// deal.created webhook, Slack and the CRM push.
export async function finishTranscriptDealInBackground(workspaceId: string, dealId: string, callId: string, transcript: string): Promise<void> {
  await Promise.all([
    extractActionItems(callId).catch((err) => reportError(err, "Action item extraction", { dealId })),
    extractCallHighlights(dealId, transcript, callId).catch((err) => reportError(err, "Call highlight extraction", { dealId })),
  ]);
  await announceNewDeal(workspaceId, dealId).catch((err) => reportError(err, "Integrations after a new deal", { dealId }));
}
