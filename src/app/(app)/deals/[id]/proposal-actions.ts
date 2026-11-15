"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { currentUserWithRole } from "@/lib/permissions";
import { announceNewDeal } from "@/lib/api-deals";
import { reportError } from "@/lib/error-report";
import { ADD_CONTRACT_TEMPLATE_FIRST, CALL_STILL_PROCESSING, FINISH_CALL_FIRST, createContractFromProposal } from "@/lib/proposal-contract";

// What the rep can do something about; anything else reads as "try again".
const SHOWN_AS_IS = new Set([ADD_CONTRACT_TEMPLATE_FIRST, FINISH_CALL_FIRST, CALL_STILL_PROCESSING]);

// Create contract from proposal: a contract deal with the proposal's client,
// lead, call and terms, on a contract template. Never sent. A proposal that
// already has its contract opens that one instead.
export async function createContractFromProposalAction(dealId: string, templateId?: string): Promise<{ dealId?: string; hasMissing?: boolean; error?: string }> {
  const currentUser = await currentUserWithRole();
  const { where } = await dealVisibilityFilter(currentUser);
  const workspaceId = await requireWorkspaceId();
  const proposal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, kind: "proposal", trashedAt: null, ...where },
    select: { id: true, leadId: true },
  });
  if (!proposal) return { error: "That proposal isn't available" };

  try {
    const made = await createContractFromProposal(proposal.id, currentUser.id, { templateId: templateId || null });
    // A new contract is announced like any other (webhook, Slack, CRM),
    // after the rep already has it. The one they had before already was.
    if (!made.existed) {
      after(() => announceNewDeal(workspaceId, made.dealId).catch((err) => reportError(err, "Integrations after a contract from a proposal", { dealId: made.dealId })));
    }
    revalidatePath(`/deals/${proposal.id}`);
    revalidatePath(`/deals/${proposal.id}/contract`);
    if (proposal.leadId) revalidatePath(`/leads/${proposal.leadId}`);
    return { dealId: made.dealId, hasMissing: made.hasMissing };
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    // A missing template or a call still going isn't a bug: the rep is told
    // what to do, and nobody is alerted.
    if (SHOWN_AS_IS.has(message)) return { error: message };
    await reportError(err, "Create contract from a proposal", { dealId });
    return { error: "Couldn't make the contract. Try again in a minute." };
  }
}
