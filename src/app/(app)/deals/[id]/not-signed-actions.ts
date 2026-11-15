"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { auth } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { refreshLeadPipeline } from "@/lib/lead-pipeline";
import { contractExpired } from "@/lib/contract-status";
import { DOCUSIGN_BUSY, retireEarlierEnvelope } from "@/lib/docusign-sync";
import { reportError } from "@/lib/error-report";

// What DocuSign shows the signers on the voided envelope.
const VOID_REASON = "Marked as not signed in SealMe";

type MarkableContract = { status: string; deliveryMethod: string; expiresAt: Date | null; sentAt: Date | null };

// A contract the client has and hasn't signed all the way: out for
// signature (counter-signers may still be missing), its link ran out, or
// the client declined or asked for changes (changes_requested with a send
// date; without one a reviewer sent it back before it ever went out).
function markable(contract: MarkableContract): boolean {
  if (contract.status === "sent" || contract.status === "partially_signed" || contractExpired(contract)) return true;
  return contract.status === "changes_requested" && contract.sentAt != null;
}

function notMarkableError(status: string): string {
  if (status === "signed") return "This contract is already signed";
  if (status === "pending_approval") return "This contract is waiting on review, not on the client";
  return "This contract hasn't gone to the client yet";
}

// The rep says the client won't sign: the contract stops taking signatures
// (the SealMe link closes, a DocuSign envelope still out is voided) and the
// lead goes to Not signed, on the Inactive tab. Its send date, expiry and
// any signature stay as the record, and the rep can still send it again.
// The deal's own status stays as it is; pages read the contract's.
export async function markContractNotSigned(dealId: string): Promise<{ error?: string }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    select: {
      id: true,
      kind: true,
      trashedAt: true,
      leadId: true,
      contract: { select: { id: true, status: true, deliveryMethod: true, expiresAt: true, sentAt: true, docusignEnvelopeId: true } },
    },
  });
  if (!deal || !deal.contract) return { error: "Deal not found" };
  if (deal.kind === "proposal") return { error: "A proposal isn't signed, so it can't be marked not signed" };
  if (deal.trashedAt) return { error: "This contract is in the trash. Restore it first" };
  const contract = deal.contract;
  // A second click, or a teammate who got there first.
  if (contract.status === "not_signed") return {};
  if (!markable(contract)) return { error: notMarkableError(contract.status) };

  // Only over the status just read: a signature that landed since wins.
  const claimed = await prisma.contract.updateMany({ where: { id: contract.id, status: contract.status }, data: { status: "not_signed" } });
  if (claimed.count === 0) return { error: "This contract changed in the meantime. Refresh the page to see where it stands" };

  // The envelope the client has is voided too, so nothing is left to sign.
  // What DocuSign says about it decides, not who gets to finalize it: a
  // client who already finished it (DocuSign's event never reached SealMe,
  // or is being handled right now) has signed, and a real signature always
  // wins. Then nothing announces Not signed, and no page is refreshed, so
  // the rep reads this instead of the button vanishing. An envelope that
  // can't be voided or checked is reported and the contract stays not
  // signed, still pointing at it: the daily DocuSign check finalizes it if
  // the client signs, and its text is still what that envelope carried.
  const earlier = await retireEarlierEnvelope(
    { contractId: contract.id, dealId: deal.id, workspaceId, envelopeId: contract.docusignEnvelopeId },
    VOID_REASON
  );
  if (earlier.outcome === "signed") return { error: "The client already signed this in DocuSign. It's marked signed now" };
  if (earlier.outcome === "busy") {
    // The envelope may be signed any moment (everyone signed and DocuSign
    // is still finishing it), so Not signed could be wrong in a moment: the
    // contract goes back to where it was, unless that signature already
    // moved it on.
    await prisma.contract.updateMany({ where: { id: contract.id, status: "not_signed" }, data: { status: contract.status } });
    return { error: DOCUSIGN_BUSY };
  }
  if (earlier.outcome === "disconnected") {
    await reportError(earlier.error, "Voiding the DocuSign envelope sent before", { dealId: deal.id, contractId: contract.id });
  }

  const session = await auth();
  const markedBy = session?.user?.email ?? null;
  const markedAt = new Date();
  await logAudit({
    workspaceId,
    actorEmail: markedBy,
    action: "contract.marked_not_signed",
    targetType: "Contract",
    targetId: contract.id,
    metadata: { previousStatus: contract.status },
  });
  await dispatchWebhookEvent(workspaceId, "contract.not_signed", {
    dealId: deal.id,
    contractId: contract.id,
    leadId: deal.leadId,
    sentAt: contract.sentAt?.toISOString() ?? null,
    markedAt: markedAt.toISOString(),
    markedBy,
  });
  await refreshLeadPipeline(deal.leadId, { unsignedNow: true });

  revalidatePath(`/deals/${deal.id}`);
  revalidatePath(`/deals/${deal.id}/contract`);
  revalidatePath("/leads");
  if (deal.leadId) revalidatePath(`/leads/${deal.leadId}`);
  return {};
}
