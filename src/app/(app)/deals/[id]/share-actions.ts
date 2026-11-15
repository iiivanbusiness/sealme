"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { logAudit } from "@/lib/audit";
import { blankTerms, canSendContract, markProposalSent } from "@/lib/review";
import { buildContractSnapshot, snapshotDiffers } from "@/lib/contract-snapshot";

// Already with the client: the link is the one they have, so copying it
// again doesn't send it again.
const ALREADY_OUT = new Set(["sent", "partially_signed", "signed"]);

// Copy link on a proposal. The browser copies the link first (in the click
// itself, so the clipboard write isn't refused), then this marks a draft
// proposal as sent: its text is frozen for the client, the lead moves to
// Proposal sent, and the page starts recording when it's opened. Nothing is
// emailed. A proposal that already went out only gets its text updated, when
// the rep changed it since.
export async function shareProposalLink(dealId: string): Promise<{ error?: string }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: { client: true, workspace: true, fields: true, contract: { include: { template: true } } },
  });
  if (!deal || deal.kind !== "proposal") return { error: "Proposal not found" };
  if (deal.trashedAt) return { error: "This proposal is in the trash. Restore it first" };
  const { contract } = deal;
  if (!contract) return { error: "Fill in the missing details to make the proposal first" };
  if (ALREADY_OUT.has(contract.status)) {
    // A proposal's terms stay editable after it went out. Copying the link
    // again shares what it says now: the text the client sees is updated,
    // nothing else changes (when it was sent, whether they opened it).
    if (contract.status !== "sent" || !contract.template) return {};
    const live = buildContractSnapshot(contract.template, deal);
    if (!snapshotDiffers(contract.snapshot, live)) return {};
    const blanks = blankTerms(contract.template.clauses, deal.fields);
    if (blanks.length > 0) return { error: `Fill in ${blanks.join(", ")} first` };
    await prisma.contract.update({ where: { id: contract.id }, data: { snapshot: live } });
    const session = await auth();
    await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "proposal.link_updated", targetType: "Deal", targetId: dealId });
    revalidatePath(`/deals/${dealId}`);
    revalidatePath(`/deals/${dealId}/contract`);
    return {};
  }
  if (contract.status === "pending_approval") return { error: "This proposal is waiting on review" };
  if (!canSendContract(contract)) return { error: "This proposal can't be shared right now. Refresh the page" };
  if (!contract.template) return { error: "This proposal's template was deleted. Pick another one first" };

  // The client must never see a raw "{fee}".
  const blanks = blankTerms(contract.template.clauses, deal.fields);
  if (blanks.length > 0) return { error: `Fill in ${blanks.join(", ")} first` };

  await markProposalSent({ id: contract.id, template: contract.template, deal }, new Date());

  const session = await auth();
  await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "proposal.link_shared", targetType: "Deal", targetId: dealId });

  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  if (deal.leadId) revalidatePath(`/leads/${deal.leadId}`);
  return {};
}
