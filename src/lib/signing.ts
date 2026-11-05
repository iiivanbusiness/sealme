import { prisma } from "@/lib/db";
import { sendSignedNotificationEmail, sendCountersignRequestEmail } from "@/lib/email";
import { extractRenewalTerms } from "@/lib/extract-renewal";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { notifySlack } from "@/lib/slack";
import { syncDealToHubspot } from "@/lib/hubspot";
import { syncDealToSalesforce } from "@/lib/salesforce";
import { logAudit } from "@/lib/audit";
import { parseContractSnapshot } from "@/lib/contract-snapshot";

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

// Called once every REQUIRED signature is in — whether that's just the
// client (the common case, zero ContractSigner rows) or the client plus
// every counter-signer after them. Fires all the same "the deal is done"
// effects regardless of which signer completed it last, so a contract
// with counter-signers behaves identically to today's single-signer one
// from here on — the only difference is how many people had to sign to
// get here.
//
// Claims the contract first: only the call that actually moves it to
// "signed" goes on, so two signers finishing at once, or a DocuSign event
// and the daily check arriving together, can't send every email, webhook
// and CRM update twice.
export async function finalizeContractSigned(contractId: string): Promise<void> {
  const claimed = await prisma.contract.updateMany({
    where: { id: contractId, status: { not: "signed" } },
    data: { status: "signed" },
  });
  if (claimed.count === 0) return;

  const contract = await prisma.contract.findUniqueOrThrow({
    where: { id: contractId },
    // Deactivated (SCIM offboarded) users don't get the "signed" email.
    include: { deal: { include: { client: true, workspace: { include: { users: { where: { deactivatedAt: null } } } } } }, template: true },
  });

  await prisma.deal.update({ where: { id: contract.dealId }, data: { status: "signed" } });

  await logAudit({
    workspaceId: contract.deal.workspaceId,
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

  try {
    await extractRenewalTerms(contract.id);
  } catch (err) {
    console.error("Failed to extract renewal terms", err);
  }

  await dispatchWebhookEvent(contract.deal.workspaceId, "contract.signed", {
    dealId: contract.dealId,
    contractId: contract.id,
    clientName: contract.deal.client.name,
    signerName: contract.signerName,
    signedAt: new Date().toISOString(),
  });
  await notifySlack(contract.deal.workspaceId, {
    type: "contract.signed",
    dealId: contract.dealId,
    clientName: contract.deal.client.name,
    signerName: contract.signerName ?? contract.deal.client.name,
  });
  await syncDealToHubspot(contract.deal.workspaceId, contract.dealId);
  await syncDealToSalesforce(contract.deal.workspaceId, contract.dealId);
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
  // gets asked to sign.
  const moved = await prisma.contract.updateMany({
    where: { id: contractId, status: { in: ["sent", "partially_signed"] }, signedAt: { not: null } },
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
