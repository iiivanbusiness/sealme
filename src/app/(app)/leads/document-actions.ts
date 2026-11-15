"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { buildDealFromCall, type DealKind } from "@/lib/call-deal";
import { reportError } from "@/lib/error-report";
import { docFailed } from "@/lib/call-docs";
import { createContractFromProposalAction } from "@/app/(app)/deals/[id]/proposal-actions";

// "Create proposal" / "Create contract" on a call that's already written up:
// made from the call's whole transcript, as a draft for the rep to check.
// A call that already has one opens it instead of making a second. A
// contract on a call that has a proposal is made from that proposal.
export async function createFromCall(callId: string, kind: DealKind): Promise<{ dealId?: string; error?: string }> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  if (kind !== "proposal" && kind !== "contract") return { error: "Pick a proposal or a contract" };
  const call = await prisma.phoneCall.findFirst({
    where: { id: callId, workspaceId: workspace.id, status: "processed", lead: access.where },
    select: {
      id: true,
      leadId: true,
      transcript: true,
      wantsProposal: true,
      wantsContract: true,
      mode: true,
      processedAt: true,
      extracted: true,
      // Newest first: this kind's own, and the proposal a contract carries on from.
      builtDeals: { where: { trashedAt: null }, select: { id: true, kind: true, status: true }, orderBy: { createdAt: "desc" }, take: 20 },
    },
  });
  if (!call?.leadId) return { error: "That call isn't available" };
  const own = call.builtDeals.find((d) => (kind === "proposal" ? d.kind === "proposal" : d.kind !== "proposal"));
  if (own) return { dealId: own.id };
  // The call asked for this one and SealMe is writing it right after the
  // notes: a second one would be a duplicate. Unless writing it already
  // failed: then nothing is coming, and the rep makes it here.
  const asked = kind === "proposal" ? call.wantsProposal : call.wantsContract || call.mode === "sales";
  if (asked && !docFailed(call.extracted, kind) && call.processedAt && Date.now() - call.processedAt.getTime() < 5 * 60 * 1000) return { error: `SealMe is writing the ${kind} from this call. It shows here in a minute.` };

  // The call has a proposal: the contract carries on from it (its terms,
  // client and template pick, linked back to it), the same way "Create
  // contract" on the proposal's own page makes it. Not from a proposal
  // still being written: its terms aren't settled enough to copy.
  const proposal = kind === "contract" ? call.builtDeals.find((d) => d.kind === "proposal") : undefined;
  if (proposal) {
    if (proposal.status === "processing") return { error: "SealMe is still writing the proposal. Try again in a minute." };
    const made = await createContractFromProposalAction(proposal.id);
    return made.error ? { error: made.error } : { dealId: made.dealId };
  }

  if (!call.transcript?.trim()) return { error: "This call has no transcript to work from" };
  const templates = await prisma.contractTemplate.count({ where: { workspaceId: workspace.id, kind } });
  if (templates === 0) return { error: `Add a ${kind} template first` };

  try {
    const { dealId } = await buildDealFromCall(call.id, kind, { quiet: true, ownerId: access.userId });
    revalidatePath(`/leads/${call.leadId}`);
    return { dealId };
  } catch (err) {
    await reportError(err, `Create ${kind} from a call`, { callId });
    return { error: `Couldn't make the ${kind}. Try again in a minute.` };
  }
}
