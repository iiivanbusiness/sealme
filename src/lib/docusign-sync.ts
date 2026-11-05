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
    select: { id: true, dealId: true, status: true, deliveryMethod: true, docusignEnvelopeId: true, sentAt: true, deal: { select: { workspaceId: true } } },
  });
  if (!contract?.docusignEnvelopeId) return false;
  if (contract.status === "signed") return true;

  const envelope = await docusignEnvelopeStatus(contract.deal.workspaceId, contract.docusignEnvelopeId);
  if (envelope.status === "declined" || envelope.status === "voided") {
    // A send through SealMe keeps the old envelope id, so once the rep has
    // sent the new version that way, the old envelope's decline is history.
    if (contract.deliveryMethod === "docusign") {
      const target = { id: contract.id, dealId: contract.dealId, workspaceId: contract.deal.workspaceId };
      if (docusignEnvelopeExpired(envelope)) await markDocusignExpired(target, contract.sentAt);
      else await markDocusignTurnedDown(target, envelope);
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
    data: { status: "partially_signed", signerName: primary?.name ?? "Client", signedAt: docusignTime(primary?.signedDateTime) ?? new Date() },
  });
  if (claimed.count === 0) return false;
  // DocuSign already has every recipient's signature (that's what
  // "completed" means); SealMe's own signer rows just follow, each with the
  // moment they really signed there. The envelope went out with the client
  // at routing order 1 and the signer rows, in order, from 2 (see
  // performActualSend in review.tsx).
  const signers = await prisma.contractSigner.findMany({ where: { contractId: contract.id }, select: { id: true, email: true, status: true }, orderBy: { order: "asc" } });
  for (const [i, signer] of signers.entries()) {
    if (signer.status !== "pending") continue;
    const onDocusign =
      envelope.signers.find((s) => s.routingOrder === String(i + 2)) ??
      envelope.signers.find((s) => s.routingOrder !== "1" && s.email.toLowerCase() === signer.email.toLowerCase());
    await prisma.contractSigner.updateMany({
      where: { id: signer.id, status: "pending" },
      data: { status: "signed", signedAt: docusignTime(onDocusign?.signedDateTime) ?? new Date() },
    });
  }
  await finalizeContractSigned(contract.id);
  return true;
}

function docusignTime(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// DocuSign doesn't give an expired envelope a status of its own: it voids it
// with the reason "Envelope has expired."
export function docusignEnvelopeExpired(envelope: Pick<DocusignEnvelopeStatus, "status" | "voidedReason">): boolean {
  return envelope.status === "voided" && /expired/i.test(envelope.voidedReason ?? "");
}

// The envelope ran out before everyone signed. Same as SealMe's own sign
// link running out (api/cron/remind): the contract reads "Sign link
// expired" and the rep sends it again. Nobody asked for changes, so it
// isn't changes_requested and nobody gets an email.
async function markDocusignExpired(contract: { id: string; dealId: string; workspaceId: string }, sentAt: Date | null | undefined): Promise<void> {
  // Guarded so the webhook and the daily check don't both announce it.
  // expiresAt was SealMe's own date, which DocuSign never went by: the
  // contract page says "Sign link expired on" it, so it becomes when
  // DocuSign's expiry was found.
  const now = new Date();
  const moved = await prisma.contract.updateMany({ where: { id: contract.id, status: "sent" }, data: { status: "expired", expiresAt: now } });
  if (moved.count === 0) return;
  await logAudit({ workspaceId: contract.workspaceId, action: "contract.expired", targetType: "Contract", targetId: contract.id, metadata: { via: "docusign" } });
  await dispatchWebhookEvent(contract.workspaceId, "contract.expired", { dealId: contract.dealId, contractId: contract.id, sentAt: sentAt?.toISOString() ?? null, expiredAt: now.toISOString() });
}

// A signer declined on DocuSign, or the sender voided the envelope there
// (for any reason other than it expiring, see markDocusignExpired). Either
// way nobody can sign it anymore, so the contract goes back to
// changes_requested, same as a counter-signer's "I can't sign this", and
// the rep can fix it and send again. A void isn't anyone asking for
// changes, so the pages say what happened (docusignVoid below).
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

// The audit entries for everything that puts a contract in
// changes_requested. The approval rejection is logged against the deal.
const CHANGES_REQUESTED_ACTIONS = ["contract.approval_rejected", "contract.clause_change_requested", "contract.countersign_declined", "contract.docusign_declined", "contract.docusign_voided"];

// A DocuSign contract in changes_requested because the envelope was voided
// in DocuSign: nobody asked for changes, so the pages shouldn't say they
// did. Nothing on Contract records why it's there, the audit trail does:
// the latest of the entries above explains the current state. Returns the
// void's reason (null when DocuSign gave none), or undefined when the
// contract is in changes_requested for any other reason.
export async function docusignVoid(
  contract: { id: string; dealId: string; status: string; deliveryMethod: string },
  workspaceId: string
): Promise<{ reason: string | null } | undefined> {
  if (contract.status !== "changes_requested" || contract.deliveryMethod !== "docusign") return undefined;
  const latest = await prisma.auditLog.findFirst({
    where: {
      workspaceId,
      action: { in: CHANGES_REQUESTED_ACTIONS },
      OR: [
        { targetType: "Contract", targetId: contract.id },
        { targetType: "Deal", targetId: contract.dealId },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { action: true, metadata: true },
  });
  if (latest?.action !== "contract.docusign_voided") return undefined;
  let reason: string | null = null;
  try {
    const metadata = latest.metadata ? (JSON.parse(latest.metadata) as { reason?: unknown }) : null;
    if (typeof metadata?.reason === "string" && metadata.reason.trim()) reason = metadata.reason.trim();
  } catch {
    // Unreadable metadata: still a void, just without its reason.
  }
  return { reason };
}
