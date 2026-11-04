import { prisma } from "@/lib/db";
import { docusignEnvelopeStatus, type DocusignEnvelopeStatus } from "@/lib/docusign";
import { finalizeContractSigned } from "@/lib/signing";
import { reportError } from "@/lib/error-report";
import { notifyChangesRequested } from "@/lib/review";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { logAudit } from "@/lib/audit";

// A contract sent through DocuSign is marked signed once DocuSign itself
// says the envelope is completed, asked with the workspace's own DocuSign
// connection. Called when DocuSign's event arrives and by the daily cron,
// in case an event never does. Returns whether it's signed now.
export async function syncDocusignContract(contractId: string): Promise<boolean> {
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    select: { id: true, dealId: true, status: true, deliveryMethod: true, docusignEnvelopeId: true, deal: { select: { workspaceId: true } } },
  });
  if (!contract?.docusignEnvelopeId) return false;
  if (contract.status === "signed") return true;

  const envelope = await docusignEnvelopeStatus(contract.deal.workspaceId, contract.docusignEnvelopeId);
  if (envelope.status === "declined" || envelope.status === "voided") {
    // A send through SealMe keeps the old envelope id, so once the rep has
    // sent the new version that way, the old envelope's decline is history.
    if (contract.deliveryMethod === "docusign") {
      await markDocusignTurnedDown({ id: contract.id, dealId: contract.dealId, workspaceId: contract.deal.workspaceId }, envelope);
    }
    return false;
  }
  if (envelope.status !== "completed") return false;

  const primary = envelope.signers.find((s) => s.routingOrder === "1") ?? envelope.signers[0];
  // Moving the status off "sent" in the same write means the webhook and
  // the daily check can't both finalize the same envelope. changes_requested
  // too: a client could comment on the SealMe page of a DocuSign contract
  // before that page turned them away, and still sign the envelope.
  const claimed = await prisma.contract.updateMany({
    where: { id: contract.id, status: { in: ["sent", "expired", "changes_requested"] } },
    data: { status: "partially_signed", signerName: primary?.name ?? "Client", signedAt: primary?.signedDateTime ? new Date(primary.signedDateTime) : new Date() },
  });
  if (claimed.count === 0) return false;
  // DocuSign already has every recipient's signature (that's what
  // "completed" means); SealMe's own signer rows just follow.
  await prisma.contractSigner.updateMany({ where: { contractId: contract.id, status: "pending" }, data: { status: "signed", signedAt: new Date() } });
  await finalizeContractSigned(contract.id);
  return true;
}

// A signer declined on DocuSign, or the sender voided the envelope there.
// Either way nobody can sign it anymore, so the contract goes back to
// changes_requested, same as a counter-signer's "I can't sign this", and
// the rep can fix it and send again.
async function markDocusignTurnedDown(contract: { id: string; dealId: string; workspaceId: string }, envelope: DocusignEnvelopeStatus): Promise<void> {
  // Guarded so the webhook and the daily check don't both announce it.
  const moved = await prisma.contract.updateMany({
    where: { id: contract.id, status: { in: ["sent", "expired"] } },
    data: { status: "changes_requested" },
  });
  if (moved.count === 0) return;
  await prisma.deal.update({ where: { id: contract.dealId }, data: { status: "changes_requested" } });

  const decliner = envelope.signers.find((s) => s.status === "declined");
  const reason = (envelope.status === "voided" ? envelope.voidedReason : decliner?.declinedReason) || null;
  await logAudit({
    workspaceId: contract.workspaceId,
    actorEmail: decliner?.email,
    action: envelope.status === "voided" ? "contract.docusign_voided" : "contract.docusign_declined",
    targetType: "Contract",
    targetId: contract.id,
    metadata: { signerName: decliner?.name, reason },
  });

  // A void is the sender's own doing in DocuSign; a decline is news.
  if (envelope.status === "declined") {
    await dispatchWebhookEvent(contract.workspaceId, "contract.declined", {
      dealId: contract.dealId,
      contractId: contract.id,
      signerName: decliner?.name ?? null,
      signerEmail: decliner?.email ?? null,
      reason,
      declinedAt: new Date().toISOString(),
    });
    await notifyChangesRequested(contract.dealId, decliner?.name ?? "A signer", reason ? `Declined on DocuSign: ${reason}` : "Declined on DocuSign");
  }
}

// Daily: DocuSign contracts still out for signature from the last 60 days.
// "expired" too, for ones SealMe's own expiry marked before it learned to
// leave DocuSign contracts alone: the envelope itself may still get signed.
export async function syncPendingDocusignContracts(): Promise<number> {
  const pending = await prisma.contract.findMany({
    where: { status: { in: ["sent", "expired"] }, docusignEnvelopeId: { not: null }, sentAt: { gte: new Date(Date.now() - 60 * 86_400_000) } },
    select: { id: true },
    take: 200,
  });
  let signed = 0;
  for (const c of pending) {
    try {
      if (await syncDocusignContract(c.id)) signed++;
    } catch (err) {
      await reportError(err, "DocuSign status check", { contractId: c.id });
    }
  }
  return signed;
}
