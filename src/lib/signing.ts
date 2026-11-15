import { after } from "next/server";
import { prisma } from "@/lib/db";
import { sendSignedNotificationEmail, sendCountersignRequestEmail } from "@/lib/email";
import { extractRenewalTerms } from "@/lib/extract-renewal";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { notifySlack } from "@/lib/slack";
import { syncDealToHubspot } from "@/lib/hubspot";
import { syncDealToSalesforce } from "@/lib/salesforce";
import { markGhlOpportunityWon } from "@/lib/gohighlevel";
import { clientCrmIds } from "@/lib/crm-leads";
import { logAudit } from "@/lib/audit";
import { reportError } from "@/lib/error-report";
import { parseContractSnapshot } from "@/lib/contract-snapshot";
import { markLeadClient } from "@/lib/lead-pipeline";

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

// Runs fn after the signer has their answer when there's a request to hang
// it on; otherwise (a script) right away. The same as webhooks.ts does for
// deliveries.
async function soon(fn: () => Promise<void>): Promise<void> {
  try {
    after(fn);
  } catch {
    await fn().catch((err) => console.error("Work after signing failed", err));
  }
}

type SignedLead = { id: string; hubspotContactId: string | null; salesforceRecordId: string | null; salesforceRecordType: string | null; ghlOpportunityId: string | null };

// The lead behind a signed deal (markLeadClient just linked one if it had
// none). The CRM record it came from goes over to the client when the client
// has none yet, so the HubSpot and Salesforce push updates that person
// instead of making a second contact. Never stops the signing finishing.
async function signedLead(dealId: string, client: { id: string; hubspotContactId: string | null; salesforceContactId: string | null }): Promise<SignedLead | null> {
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { lead: { select: { id: true, hubspotContactId: true, salesforceRecordId: true, salesforceRecordType: true, ghlOpportunityId: true } } },
    });
    const lead = deal?.lead ?? null;
    if (!lead) return null;
    const ids = clientCrmIds(lead);
    const missing = {
      ...(ids.hubspotContactId && !client.hubspotContactId ? { hubspotContactId: ids.hubspotContactId } : {}),
      ...(ids.salesforceContactId && !client.salesforceContactId ? { salesforceContactId: ids.salesforceContactId } : {}),
    };
    if (Object.keys(missing).length > 0) {
      // Only into an empty slot: a contact the client got meanwhile stays.
      const empty = Object.fromEntries(Object.keys(missing).map((k) => [k, null]));
      await prisma.client.updateMany({ where: { id: client.id, ...empty }, data: missing });
    }
    return lead;
  } catch (err) {
    await reportError(err, "Lead and CRM ids after signing", { dealId });
    return null;
  }
}

// GoHighLevel: the opportunity the lead's first call opened is won.
async function markGhlWon(workspaceId: string, dealId: string, opportunityId: string): Promise<void> {
  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { ghlEnabled: true, ghlAccessToken: true } });
    if (!workspace?.ghlEnabled || !workspace.ghlAccessToken) return;
    await markGhlOpportunityWon(workspace.ghlAccessToken, opportunityId);
  } catch (err) {
    await reportError(err, "GoHighLevel opportunity won", { workspaceId, dealId });
  }
}

// Called once every REQUIRED signature is in: just the client (the common
// case, zero ContractSigner rows), or the client plus every counter-signer
// after them. Fires the same "the deal is done" effects whoever signed last,
// whether it came through SealMe's own page or DocuSign.
//
// Claims the contract first: only the call that actually moves it to
// "signed" goes on, so two signers finishing at once, or a DocuSign event
// and the daily check arriving together, can't send every email, webhook
// and CRM update twice. A proposal is never signed, whatever reaches here.
// A contract marked not signed, or run out, still finishes when a real
// signature arrives for it (a DocuSign envelope completed later): the
// signature wins.
export async function finalizeContractSigned(contractId: string): Promise<void> {
  const claimed = await prisma.contract.updateMany({
    where: { id: contractId, status: { not: "signed" }, deal: { kind: { not: "proposal" } } },
    data: { status: "signed" },
  });
  if (claimed.count === 0) return;

  const contract = await prisma.contract.findUniqueOrThrow({
    where: { id: contractId },
    // Deactivated (SCIM offboarded) users don't get the "signed" email.
    include: { deal: { include: { client: true, workspace: { include: { users: { where: { deactivatedAt: null } } } } } }, template: true },
  });
  const { workspaceId } = contract.deal;

  await prisma.deal.update({ where: { id: contract.dealId }, data: { status: "signed" } });
  // The lead the contract came from is a client now.
  await markLeadClient(contract.dealId);
  const lead = await signedLead(contract.dealId, contract.deal.client);

  await logAudit({
    workspaceId,
    action: "contract.signed",
    targetType: "Contract",
    targetId: contract.id,
  });

  if (contract.deal.workspace.notifyOnSigned && contract.deal.workspace.users.length > 0) {
    try {
      await sendSignedNotificationEmail({
        to: contract.deal.workspace.users.map((u) => u.email),
        clientName: contract.signerName ?? contract.deal.client.name,
        templateName: parseContractSnapshot(contract.snapshot)?.templateName ?? contract.template?.name ?? "contract",
        contractUrl: `${appUrl()}/deals/${contract.dealId}/contract`,
      });
    } catch (err) {
      console.error("Failed to send signed-notification email", err);
    }
  }

  await dispatchWebhookEvent(workspaceId, "contract.signed", {
    dealId: contract.dealId,
    contractId: contract.id,
    leadId: lead?.id ?? null,
    // The proposal this contract was made from, if it was.
    sourceDealId: contract.deal.sourceDealId,
    clientName: contract.deal.client.name,
    signerName: contract.signerName,
    signedAt: new Date().toISOString(),
  });

  // The signer doesn't wait on reading the renewal terms (an AI call),
  // Slack or the CRMs. One failing leaves the others to run.
  await soon(async () => {
    const tryTo = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        console.error(`Failed to ${what} for signed contract ${contract.id}`, err);
      }
    };
    await tryTo("extract renewal terms", () => extractRenewalTerms(contract.id));
    await tryTo("notify Slack", () =>
      notifySlack(workspaceId, { type: "contract.signed", dealId: contract.dealId, clientName: contract.deal.client.name, signerName: contract.signerName ?? contract.deal.client.name }),
    );
    await tryTo("sync HubSpot", () => syncDealToHubspot(workspaceId, contract.dealId));
    await tryTo("sync Salesforce", () => syncDealToSalesforce(workspaceId, contract.dealId));
    if (lead?.ghlOpportunityId) await markGhlWon(workspaceId, contract.dealId, lead.ghlOpportunityId);
  });
}

// Called right after ANY signer (the client, or a counter-signer) signs.
// If someone's still pending in the routing order, notifies whoever's
// next and leaves the contract "partially_signed"; otherwise finalizes.
// The client always signs first: a counter-signer who signs while the
// contract is still out to the client doesn't complete or advance it.
export async function advanceSigningOrFinalize(contractId: string): Promise<void> {
  const nextSigner = await prisma.contractSigner.findFirst({
    where: { contractId, status: "pending" },
    orderBy: { order: "asc" },
  });

  if (!nextSigner) {
    const { signedAt } = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, select: { signedAt: true } });
    if (signedAt) await finalizeContractSigned(contractId);
    return;
  }

  // Guarded: if a signer racing this one already finalized it, or it was
  // pulled back for changes meanwhile, it stays that way and nobody else
  // gets asked to sign. Nobody signs a proposal.
  const moved = await prisma.contract.updateMany({
    where: { id: contractId, status: { in: ["sent", "partially_signed"] }, signedAt: { not: null }, deal: { kind: { not: "proposal" } } },
    data: { status: "partially_signed" },
  });
  if (moved.count === 0) return;

  const contract = await prisma.contract.findUniqueOrThrow({
    where: { id: contractId },
    include: { deal: { include: { client: true, workspace: true } }, template: true },
  });

  try {
    await sendCountersignRequestEmail({
      to: nextSigner.email,
      signerName: nextSigner.name,
      clientName: contract.deal.client.name,
      templateName: parseContractSnapshot(contract.snapshot)?.templateName ?? contract.template?.name ?? "contract",
      signLink: `${appUrl()}/sign/${contract.id}/countersign/${nextSigner.token}`,
      workspaceName: contract.deal.workspace.name,
      verifiedSenderEmail: contract.deal.workspace.senderDomainStatus === "verified" ? contract.deal.workspace.senderEmail : null,
    });
    await prisma.contractSigner.update({ where: { id: nextSigner.id }, data: { notifiedAt: new Date() } });
  } catch (err) {
    console.error(`Failed to notify next signer for contract ${contractId}`, err);
  }
}
