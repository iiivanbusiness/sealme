import { prisma } from "@/lib/db";
import { extractDealFromTranscript, buildDealFieldRows } from "@/lib/extract-deal";
import { extractActionItems } from "@/lib/extract-action-items";
import { extractCallHighlights } from "@/lib/extract-call-highlights";
import { extractPlaceholderKeys } from "@/lib/contract";
import { dispatchDealCreated } from "@/lib/webhooks";
import { notifySlack } from "@/lib/slack";
import { syncDealToHubspot } from "@/lib/hubspot";
import { syncDealToSalesforce } from "@/lib/salesforce";
import { reportError } from "@/lib/error-report";
import { leadForClient } from "@/lib/client-lead";

// What every new deal sets off, however it was made: the deal.created
// webhook, Slack, and the push to the workspace's CRM.
export async function announceNewDeal(workspaceId: string, dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { client: true } });
  if (!deal) return;
  await dispatchDealCreated(workspaceId, dealId);
  await notifySlack(workspaceId, { type: "deal.created", dealId: deal.id, clientName: deal.client.name, service: deal.service });
  await syncDealToHubspot(workspaceId, deal.id);
  await syncDealToSalesforce(workspaceId, deal.id);
}

// The slow half of POST /api/v1/deals with a transcript, run after the 202:
// read the terms from the transcript, fill the deal, and fill in the client
// where the caller left it blank. A failure leaves the deal in
// "extraction_failed", where someone can fix it by hand in the app.
// linkLead: the caller didn't say who the client is, so the deal goes on a
// lead only once the transcript has named them (never a lead called "New
// client").
export async function finishTranscriptDeal(options: {
  workspaceId: string;
  dealId: string;
  callId: string;
  clientId: string;
  transcript: string;
  templateClauses: string;
  clientGiven: { name: boolean; company: boolean; email: boolean };
  linkLead?: { ownerId: string | null };
}): Promise<void> {
  const { workspaceId, dealId, callId, clientId, transcript, templateClauses, clientGiven } = options;
  try {
    const placeholderKeys = extractPlaceholderKeys(templateClauses);
    const extracted = await extractDealFromTranscript(transcript, placeholderKeys);
    const { fieldRows, hasMissing, service, fee } = buildDealFieldRows(extracted, placeholderKeys);
    const clientFill = {
      ...(clientGiven.name ? {} : { name: extracted.clientName }),
      ...(clientGiven.company ? {} : { company: extracted.company ?? (clientGiven.name ? undefined : extracted.clientName) }),
      ...(clientGiven.email || !extracted.email ? {} : { email: extracted.email }),
    };
    await prisma.$transaction([
      prisma.deal.update({
        where: { id: dealId },
        data: { service, feeDisplay: fee, summary: extracted.summary, status: hasMissing ? "missing_info" : "ready", fields: { create: fieldRows } },
      }),
      ...(Object.keys(clientFill).length ? [prisma.client.update({ where: { id: clientId }, data: clientFill })] : []),
    ]);
  } catch (err) {
    console.error(`API deal ${dealId}: extraction failed`, err);
    await reportError(err, "Deal extraction for an API transcript", { workspaceId, dealId });
    await prisma.deal.update({ where: { id: dealId }, data: { status: "extraction_failed" } }).catch(() => {});
  }

  if (options.linkLead) {
    try {
      const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, company: true, email: true, phone: true } });
      if (client) await prisma.deal.update({ where: { id: dealId }, data: { leadId: await leadForClient(workspaceId, client, { ownerId: options.linkLead.ownerId, source: "api" }) } });
    } catch (err) {
      await reportError(err, "Putting an API deal on a lead", { dealId });
    }
  }

  await Promise.all([
    extractActionItems(callId).catch((err) => reportError(err, "Action item extraction", { dealId })),
    extractCallHighlights(dealId, transcript, callId).catch((err) => reportError(err, "Call highlight extraction", { dealId })),
  ]);
  await announceNewDeal(workspaceId, dealId).catch((err) => reportError(err, "Integrations after an API deal", { dealId }));
}
