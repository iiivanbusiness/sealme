import { prisma } from "@/lib/db";
import { refreshLeadPipeline } from "@/lib/lead-pipeline";
import { DOCUSIGN_EXPIRED, DOCUSIGN_NOT_CONNECTED, docusignEnvelopeStatus, voidDocusignEnvelope, type DocusignEnvelopeStatus } from "@/lib/docusign";
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
    select: { id: true, dealId: true, status: true, deliveryMethod: true, docusignEnvelopeId: true, sentAt: true, deal: { select: { workspaceId: true, leadId: true } } },
  });
  if (!contract?.docusignEnvelopeId) return false;
  if (contract.status === "signed") return true;

  const envelope = await docusignEnvelopeStatus(contract.deal.workspaceId, contract.docusignEnvelopeId);
  if (envelope.status === "declined" || envelope.status === "voided") {
    // Only news for the round out now, when that round went out in this
    // envelope: by DocuSign (deliveryMethod is stored only with a send that
    // went out, see performActualSend), and closed after it went out. A
    // SealMe link sent before new rounds let go of the old envelope still
    // points at it, and that envelope running out, being voided or declined
    // later says nothing about the link the client has now. One closed
    // before the round went out was dealt with back then. Acting on either
    // would email the team about a decline from rounds ago or close a link
    // the client can still sign. A completed envelope, below, is a real
    // signature whatever the round.
    if (contract.deliveryMethod === "docusign" && closedThisRound(envelope, contract.sentAt)) {
      const target = { id: contract.id, dealId: contract.dealId, workspaceId: contract.deal.workspaceId, leadId: contract.deal.leadId };
      if (docusignEnvelopeExpired(envelope)) await markDocusignExpired(target, contract.sentAt);
      else await markDocusignTurnedDown(target, envelope);
    }
    return false;
  }
  if (envelope.status !== "completed") return false;
  return finalizeFromEnvelope(contract.id, envelope);
}

// The client finished the envelope, so the contract is signed. Returns
// whether this call finalized it: false when something else got there first.
async function finalizeFromEnvelope(contractId: string, envelope: DocusignEnvelopeStatus): Promise<boolean> {
  const primary = envelope.signers.find((s) => s.routingOrder === "1") ?? envelope.signers[0];
  // Moving the status off "sent" in the same write means the webhook and
  // the daily check can't both finalize the same envelope. changes_requested
  // too: a client could comment on the SealMe page of a DocuSign contract
  // before that page turned them away, and still sign the envelope. And
  // not_signed: an envelope completed before the rep's void reached DocuSign
  // is a real signature, and a real signature always wins. pending_approval
  // for the same reason: a new version in review hasn't gone out, so the
  // contract's text is still the round this envelope carried.
  const claimed = await prisma.contract.updateMany({
    where: { id: contractId, status: { in: ["sent", "expired", "changes_requested", "not_signed", "pending_approval"] } },
    data: { status: "partially_signed", signerName: primary?.name ?? "Client", signedAt: docusignTime(primary?.signedDateTime) ?? new Date() },
  });
  if (claimed.count === 0) return false;
  // DocuSign already has every recipient's signature (that's what
  // "completed" means); SealMe's own signer rows just follow, each with the
  // moment they really signed there. The envelope went out with the client
  // at routing order 1 and the signer rows, in order, from 2 (see
  // performActualSend in review.tsx).
  const signers = await prisma.contractSigner.findMany({ where: { contractId }, select: { id: true, email: true, status: true }, orderBy: { order: "asc" } });
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
  await finalizeContractSigned(contractId);
  return true;
}

// What became of the envelope a contract went out in before:
// - "gone": nobody can sign it anymore (there was none, it was just voided,
//   DocuSign had closed it, or it isn't on the DocuSign account connected
//   now). The contract stops pointing at it.
// - "signed": the client finished it, and the contract is finalized.
// - "busy": everyone signed and DocuSign is still finishing it, or it's in a
//   state SealMe doesn't know. It may be signed any moment, so nothing that
//   would replace it goes ahead.
// - "still_out": it couldn't be voided.
// - "unchecked": DocuSign couldn't be asked (down, timed out).
// - "disconnected": the workspace's DocuSign connection is gone or expired;
//   error says which, in the words the rep is shown elsewhere.
export type EarlierEnvelope =
  | { outcome: "gone" | "signed" | "busy" | "still_out" | "unchecked" }
  | { outcome: "disconnected"; error: Error };

// What a rep reads when the client is in the middle of signing on DocuSign.
export const DOCUSIGN_BUSY = "The client is signing this in DocuSign right now. Try again in a minute";

// A contract has at most one envelope the client can still sign, and an
// envelope the client finished is always finalized. So before a contract
// starts a new round (a send, a review, the rep marking it not signed), the
// envelope from before is looked up: a finished one finalizes the contract,
// one still out is voided. Only its status is read, never through
// syncDocusignContract, whose decline branch would announce a decline from
// rounds ago all over again. Failures are reported here, except a lost
// connection, which the caller either tells the rep about or reports; the
// caller decides whether it can go on.
export async function retireEarlierEnvelope(
  target: { contractId: string; dealId: string; workspaceId: string; envelopeId: string | null },
  voidReason: string
): Promise<EarlierEnvelope> {
  const { contractId, dealId, workspaceId, envelopeId } = target;
  if (!envelopeId) return { outcome: "gone" };
  const context = { dealId, contractId };
  let envelope: DocusignEnvelopeStatus;
  try {
    envelope = await docusignEnvelopeStatus(workspaceId, envelopeId);
  } catch (err) {
    if (docusignDisconnected(err)) return { outcome: "disconnected", error: err };
    if (envelopeOutOfReach(err)) {
      // Reported once: with the contract no longer pointing at it, nothing
      // asks about it again.
      await reportError(err, "The DocuSign envelope sent before isn't on the connected account", context);
      await forgetEnvelope(contractId, envelopeId);
      return { outcome: "gone" };
    }
    await reportError(err, "Checking the DocuSign envelope sent before", context);
    return { outcome: "unchecked" };
  }
  if (envelope.status === "completed") return finalizeSigned(contractId, envelope, context);
  if (envelope.status === "voided" || envelope.status === "declined" || envelope.status === "deleted") {
    await forgetEnvelope(contractId, envelopeId);
    return { outcome: "gone" };
  }
  if (envelope.status !== "sent" && envelope.status !== "delivered") return { outcome: "busy" };
  try {
    await voidDocusignEnvelope(workspaceId, envelopeId, voidReason);
  } catch (err) {
    // DocuSign won't void an envelope the client finished in the meantime.
    const now = await docusignEnvelopeStatus(workspaceId, envelopeId).catch(() => null);
    if (now?.status === "completed") return finalizeSigned(contractId, now, context);
    await reportError(err, "Voiding the DocuSign envelope sent before", context);
    return { outcome: "still_out" };
  }
  await forgetEnvelope(contractId, envelopeId);
  return { outcome: "gone" };
}

// Nothing more can happen to this envelope, or SealMe can't see it anymore:
// the contract stops pointing at it, so DocuSign's event and the daily check
// never read it again (an old decline included). Only while it's still the
// contract's envelope: a send that went out meanwhile wrote its own.
export async function forgetEnvelope(contractId: string, envelopeId: string): Promise<void> {
  await prisma.contract.updateMany({ where: { id: contractId, docusignEnvelopeId: envelopeId }, data: { docusignEnvelopeId: null } });
}

// The client signed, and that's the answer whoever finalizes it: DocuSign's
// event or the daily check running alongside may claim it first, and a
// finalize that fails is reported, not thrown, since the signature is real.
async function finalizeSigned(contractId: string, envelope: DocusignEnvelopeStatus, context: Record<string, string>): Promise<EarlierEnvelope> {
  try {
    await finalizeFromEnvelope(contractId, envelope);
  } catch (err) {
    await reportError(err, "Finalizing a contract signed in DocuSign", context);
  }
  return { outcome: "signed" };
}

// The workspace's DocuSign connection is gone (disconnected in Settings) or
// expired (the token helpers in docusign.ts cleared it).
function docusignDisconnected(err: unknown): err is Error {
  return err instanceof Error && (err.message === DOCUSIGN_EXPIRED || err.message === DOCUSIGN_NOT_CONNECTED);
}

// DocuSign says the envelope doesn't exist, or the account connected now
// can't see it: someone reconnected another DocuSign account or user, or
// SealMe moved from DocuSign's demo to its live site. Whatever happens to
// that envelope, SealMe can never see it again.
function envelopeOutOfReach(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /lookup failed: 404\b/.test(err.message) || /ENVELOPE_DOES_NOT_EXIST|USER_NOT_ENVELOPE_SENDER_OR_RECIPIENT/.test(err.message);
}

// The envelope was declined or voided after the contract's current round
// went out. When DocuSign gives no time, or the contract has no send date,
// it counts as this round's, as it always did.
function closedThisRound(envelope: DocusignEnvelopeStatus, sentAt: Date | null): boolean {
  const decliner = envelope.signers.find((s) => s.status === "declined");
  const closedAt =
    docusignTime(envelope.status === "declined" ? (envelope.declinedDateTime ?? decliner?.declinedDateTime) : envelope.voidedDateTime) ??
    docusignTime(envelope.statusChangedDateTime);
  return !closedAt || !sentAt || closedAt.getTime() >= sentAt.getTime();
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
async function markDocusignExpired(contract: { id: string; dealId: string; workspaceId: string; leadId: string | null }, sentAt: Date | null | undefined): Promise<void> {
  // Guarded so the webhook and the daily check don't both announce it.
  // expiresAt was SealMe's own date, which DocuSign never went by: the
  // contract page says "Sign link expired on" it, so it becomes when
  // DocuSign's expiry was found.
  const now = new Date();
  const moved = await prisma.contract.updateMany({ where: { id: contract.id, status: "sent" }, data: { status: "expired", expiresAt: now } });
  if (moved.count === 0) return;
  await logAudit({ workspaceId: contract.workspaceId, action: "contract.expired", targetType: "Contract", targetId: contract.id, metadata: { via: "docusign" } });
  await dispatchWebhookEvent(contract.workspaceId, "contract.expired", { dealId: contract.dealId, contractId: contract.id, leadId: contract.leadId, sentAt: sentAt?.toISOString() ?? null, expiredAt: now.toISOString() });
  await refreshLeadPipeline(contract.leadId);
}

// A signer declined on DocuSign, or the sender voided the envelope there
// (for any reason other than it expiring, see markDocusignExpired). Either
// way nobody can sign it anymore, so the contract goes back to
// changes_requested, same as a counter-signer's "I can't sign this", and
// the rep can fix it and send again. A void isn't anyone asking for
// changes, so the pages say what happened (docusignVoid below).
async function markDocusignTurnedDown(contract: { id: string; dealId: string; workspaceId: string }, envelope: DocusignEnvelopeStatus): Promise<void> {
  // Guarded so the webhook and the daily check don't both announce it. The
  // void SealMe itself sends when the rep marks a contract not signed comes
  // back here too, and leaves that contract as it is.
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
// And "not_signed", in case the rep's void never reached DocuSign and the
// client signed anyway.
export async function syncPendingDocusignContracts(): Promise<number> {
  const pending = await prisma.contract.findMany({
    where: { status: { in: ["sent", "expired", "not_signed"] }, docusignEnvelopeId: { not: null }, sentAt: { gte: new Date(Date.now() - 60 * 86_400_000) } },
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
export const CHANGES_REQUESTED_ACTIONS = ["contract.approval_rejected", "contract.clause_change_requested", "contract.countersign_declined", "contract.docusign_declined", "contract.docusign_voided"];

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
