"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { canSendContract, performActualSend, notifyStepAssignee, notifyChangesRequested, resolveReviewChain } from "@/lib/review";
import { logAudit } from "@/lib/audit";

type ReviewStepWithAssignee = { id: string; assigneeId: string; contractId: string };

// Shared by decideReviewStep and every checklist/comment mutation: is this
// user allowed to act on this step? Either they're the named assignee
// directly, or someone who IS has actively delegated to them (see
// ApprovalDelegate — "while I'm out, X can review on my behalf"). Returns
// the delegator's id for the audit trail when it's a delegate acting, or
// null when it's the assignee acting directly.
async function checkReviewStepEligibility(reviewStep: ReviewStepWithAssignee, userId: string): Promise<{ eligible: boolean; onBehalfOfUserId: string | null }> {
  if (reviewStep.assigneeId === userId) return { eligible: true, onBehalfOfUserId: null };

  const now = new Date();
  const delegation = await prisma.approvalDelegate.findFirst({
    where: {
      toUserId: userId,
      fromUserId: reviewStep.assigneeId,
      startsAt: { lte: now },
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    },
  });
  if (!delegation) return { eligible: false, onBehalfOfUserId: null };
  return { eligible: true, onBehalfOfUserId: delegation.fromUserId };
}

export type ReviewStepData = {
  id: string;
  order: number;
  status: string;
  assigneeId: string;
  assigneeName: string;
  decidedByName: string | null;
  decidedOnBehalfOfName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  note: string | null;
  priority: string;
  dueAt: Date | null;
  checklistItems: { id: string; label: string; done: boolean }[];
  comments: { id: string; authorName: string; authorEmail: string; body: string; createdAt: string }[];
};

// Polled by ReviewPanel (a client component) every few seconds so that when
// a teammate decides their step from their own device, everyone else
// looking at the same deal sees it update on its own — the mutations above
// already revalidatePath, but that only refreshes the page for whoever just
// acted. This is the read side that makes the state visible live to
// everyone else without them having to reload.
export async function getReviewState(dealId: string): Promise<{
  contractStatus: string;
  dealStatus: string;
  contractCreatedAt: Date;
  contractSentAt: Date | null;
  contractSignedAt: Date | null;
  steps: ReviewStepData[];
} | null> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: {
      contract: {
        include: {
          reviewSteps: {
            include: {
              assignee: true,
              decidedByUser: true,
              decidedOnBehalfOfUser: true,
              checklistItems: { orderBy: { createdAt: "asc" } },
              comments: { orderBy: { createdAt: "asc" } },
            },
            orderBy: { order: "asc" },
          },
        },
      },
    },
  });
  if (!deal || !deal.contract) return null;

  return {
    contractStatus: deal.contract.status,
    dealStatus: deal.status,
    contractCreatedAt: deal.contract.createdAt,
    contractSentAt: deal.contract.sentAt,
    contractSignedAt: deal.contract.signedAt,
    steps: deal.contract.reviewSteps.map((s) => ({
      id: s.id,
      order: s.order,
      status: s.status,
      assigneeId: s.assigneeId,
      assigneeName: s.assignee.name,
      decidedByName: s.decidedByUser?.name ?? null,
      decidedOnBehalfOfName: s.decidedOnBehalfOfUser?.name ?? null,
      decidedAt: s.decidedAt,
      createdAt: s.createdAt,
      note: s.note,
      priority: s.priority,
      dueAt: s.dueAt,
      checklistItems: s.checklistItems.map((i) => ({ id: i.id, label: i.label, done: i.done })),
      comments: s.comments.map((c) => ({ id: c.id, authorName: c.authorName, authorEmail: c.authorEmail, body: c.body, createdAt: c.createdAt.toISOString() })),
    })),
  };
}

// Manual "Send to X" — the informal override sitting alongside the
// automatic ReviewChain: pick anyone, at any time, and the review routes
// to them right now. If a step is already active, this REASSIGNS it
// (keeps order/priority/checklist/comments/history, just changes who's
// responsible) rather than adding a new one — that's what lets it
// redirect mid-chain instead of only working when nothing is in flight.
// If nothing is active (never sent for review, or the chain already
// finished), it starts a fresh step. Open to any workspace member who can
// see the deal, same visibility gate as a deal note/comment — this is
// deliberately informal, not an admin-only action. Handing off the active
// step, though, skips whoever has it now (say Finance, from the chain), so
// only they, their delegate, or an admin can do that; anyone else adds the
// teammate as one more step after it: an extra approval, never one less.
// For the same reason a fresh round from anyone but an admin starts with
// the steps the deal's review chain requires, and the teammate after them.
export async function sendForReviewTo(dealId: string, assigneeId: string): Promise<{ error?: string }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();

  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    include: { contract: true, client: true, template: true, workspace: true },
  });
  if (!deal || !deal.contract) return { error: "Generate a contract for this deal first" };

  const assignee = await prisma.user.findFirst({ where: { id: assigneeId, workspaceId, deactivatedAt: null } });
  if (!assignee) return { error: "Teammate not found" };

  // Otherwise anyone could route a required approval (e.g. Legal) to
  // themselves, approve it, and send the contract.
  const caller = await currentUserWithRole();
  if (assigneeId === caller.id && !caller.role?.canManageWorkspace) {
    return { error: "You can't send a review to yourself. Pick a teammate" };
  }

  // Only a contract in review has an active step. A pending one on any other
  // contract was queued behind a rejection from before rejections cleared
  // them, and a new round replaces it (below).
  const activeStep =
    deal.contract.status === "pending_approval"
      ? await prisma.reviewStep.findFirst({ where: { contractId: deal.contract.id, status: "pending" }, orderBy: { order: "asc" } })
      : null;
  // Approving a new step sends the contract, which is already with the client.
  if (!activeStep && !canSendContract(deal.contract) && deal.contract.status !== "pending_approval") {
    return { error: "This contract was already sent" };
  }
  const startingFreshChain = !activeStep;
  const canHandOff =
    !!activeStep &&
    (activeStep.assigneeId === assigneeId || Boolean(caller.role?.canManageWorkspace) || (await checkReviewStepEligibility(activeStep, caller.id)).eligible);
  // Approving a fresh round sends the contract, so it must not skip the
  // approvals the Send page would ask for (requestOrSendReview), e.g. after
  // Legal asked for changes.
  const requiredAssigneeIds =
    startingFreshChain && !caller.role?.canManageWorkspace ? ((await resolveReviewChain(deal))?.steps.map((s) => s.assigneeId) ?? []) : [];

  // A chain kicked off from the contract page's compose form already has
  // pendingTo/Subject/Message stored (requestOrSendReview), but this manual
  // "Send to" button skips that form entirely — without a fallback here,
  // the LAST step's approval would have nothing to actually email the
  // client with. Generate the same defaults sendViaDocusignNow uses, and
  // validate BEFORE writing anything so a missing client email fails clean
  // instead of leaving an orphaned review step behind.
  const needsPendingEmail = startingFreshChain && !deal.contract.pendingTo && !deal.contract.pendingSubject && !deal.contract.pendingMessage;
  if (needsPendingEmail && !deal.client.email) {
    return { error: "This client has no email on file yet. Add one before sending for review" };
  }

  // The step whose assignee hears about it now. A teammate queued behind the
  // active step or the chain's steps hears from decideReviewStep once it's
  // their turn.
  let notifyStepId: string | null = null;
  let queued = false;
  if (activeStep && canHandOff) {
    await prisma.reviewStep.update({ where: { id: activeStep.id }, data: { assigneeId } });
    notifyStepId = activeStep.id;
  } else {
    if (startingFreshChain) await prisma.reviewStep.deleteMany({ where: { contractId: deal.contract.id, status: "pending" } });
    const maxOrder = await prisma.reviewStep.aggregate({ where: { contractId: deal.contract.id }, _max: { order: true } });
    // In chain order, then the teammate unless the chain already has them.
    const assignees = [...new Set([...requiredAssigneeIds, assigneeId])];
    let firstStepId: string | null = null;
    for (let i = 0; i < assignees.length; i++) {
      const created = await prisma.reviewStep.create({
        data: { contractId: deal.contract.id, assigneeId: assignees[i], order: (maxOrder._max.order ?? 0) + i + 1, status: "pending" },
      });
      firstStepId ??= created.id;
    }
    queued = !startingFreshChain || assignees[0] !== assigneeId;

    if (startingFreshChain) {
      notifyStepId = firstStepId;
      const contractUpdate: { status: string; pendingTo?: string; pendingSubject?: string; pendingMessage?: string } = {
        status: "pending_approval",
      };
      if (needsPendingEmail) {
        contractUpdate.pendingTo = deal.client.email!;
        contractUpdate.pendingSubject = `${deal.template?.name ?? "Contract"} from ${deal.workspace.name}`;
        contractUpdate.pendingMessage = `Hi ${deal.client.name.split(" ")[0]},\n\nHere's the ${(deal.template?.name ?? "contract").toLowerCase()} we just discussed. Take a look and sign whenever you're ready.`;
      }
      await prisma.contract.update({ where: { id: deal.contract.id }, data: contractUpdate });
      await prisma.deal.update({ where: { id: dealId }, data: { status: "pending_approval" } });
    }
  }

  await logAudit({ workspaceId, actorEmail: caller.email, action: "contract.sent_for_review", targetType: "Deal", targetId: dealId, metadata: { assignee: assignee.name, ...(queued ? { queued: true } : {}) } });

  if (notifyStepId) await notifyStepAssignee(dealId, notifyStepId);

  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}

// Invoked from a client component (ReviewPanel) that reads the returned
// `error` field to show inline errors, so this never calls redirect() —
// redirect() throws to signal Next.js, and treating that throw as a
// mutation failure would break navigation. revalidatePath refreshes the
// page in place instead, which is also just a better fit here: the
// decider is already looking at this exact page.
export async function decideReviewStep(dealId: string, reviewStepId: string, decision: "approve" | "reject", formData: FormData): Promise<{ error?: string }> {
  const note = String(formData.get("note") ?? "").trim() || null;
  const workspaceId = await requireWorkspaceId();

  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId }, include: { contract: true } });
  if (!deal || !deal.contract) return { error: "Deal not found" };
  // A decision only counts while the contract is in review: once it's back
  // with the rep (changes requested) or out with the client, approving would
  // send it again and rejecting would pull it back.
  if (deal.contract.status !== "pending_approval") return { error: "This contract isn't waiting on review anymore" };

  const reviewStep = await prisma.reviewStep.findFirst({ where: { id: reviewStepId, contractId: deal.contract.id } });
  if (!reviewStep) return { error: "Review step not found" };
  if (reviewStep.status !== "pending") return { error: "This step was already decided" };

  // Steps must be decided strictly in order: nothing before this one may
  // still be pending. Only "pending" counts because a rejection ends its
  // round (it clears what was queued after it, below), so an earlier
  // rejected step belongs to a round that's over, and "Send to" can start a
  // new one after it.
  const earlierUnresolved = await prisma.reviewStep.count({
    where: { contractId: deal.contract.id, order: { lt: reviewStep.order }, status: "pending" },
  });
  if (earlierUnresolved > 0) return { error: "An earlier step hasn't been approved yet" };

  const user = await currentUserWithRole();
  const { eligible, onBehalfOfUserId } = await checkReviewStepEligibility(reviewStep, user.id);
  if (!eligible) return { error: "You're not eligible to decide this review step" };

  if (decision === "reject") {
    await prisma.reviewStep.update({
      where: { id: reviewStepId },
      data: { status: "rejected", decidedByUserId: user.id, decidedOnBehalfOfUserId: onBehalfOfUserId, decidedAt: new Date(), note },
    });
    // The steps queued after this one never got their turn. Left pending they
    // would sit in their assignees' approvals with no way to decide them, and
    // make "Send to" reassign one of them instead of starting a new round.
    // Removed rather than given a new status, the same way a send rebuilds
    // the chain from scratch (requestOrSendReview).
    await prisma.reviewStep.deleteMany({ where: { contractId: deal.contract.id, order: { gt: reviewStep.order }, status: "pending" } });
    await prisma.contract.update({ where: { id: deal.contract.id }, data: { status: "changes_requested" } });
    await prisma.deal.update({ where: { id: dealId }, data: { status: "changes_requested" } });

    await logAudit({ workspaceId, actorEmail: user.email, action: "contract.approval_rejected", targetType: "Deal", targetId: dealId, metadata: { note } });
    await notifyChangesRequested(dealId, user.name, note);

    revalidatePath(`/deals/${dealId}`);
    revalidatePath(`/deals/${dealId}/contract`);
    return {};
  }

  const nextStep = await prisma.reviewStep.findFirst({
    where: { contractId: deal.contract.id, order: { gt: reviewStep.order }, status: "pending" },
    orderBy: { order: "asc" },
  });

  // For the last step, send FIRST and only mark the step approved once the
  // email actually goes out. If sendContractEmail throws (bad address,
  // Resend outage, whatever), the step stays "pending" so this is simply
  // retryable — the alternative (marking it approved regardless) would
  // strand the contract in pending_approval forever with no pending step
  // left to act on. Caught explicitly (rather than left to throw) so the
  // real reason — not a redacted production error — reaches the reviewer.
  if (!nextStep) {
    try {
      await performActualSend(deal.contract.id);
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Couldn't send the contract to the client" };
    }
  }

  await prisma.reviewStep.update({
    where: { id: reviewStepId },
    data: { status: "approved", decidedByUserId: user.id, decidedOnBehalfOfUserId: onBehalfOfUserId, decidedAt: new Date(), note },
  });
  await logAudit({ workspaceId, actorEmail: user.email, action: "contract.approval_approved", targetType: "Deal", targetId: dealId, metadata: { note } });

  if (nextStep) {
    await notifyStepAssignee(dealId, nextStep.id);
  }

  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}

export async function addChecklistItem(dealId: string, reviewStepId: string, formData: FormData): Promise<{ error?: string }> {
  const label = String(formData.get("label") ?? "").trim();
  if (!label) return { error: "Enter a checklist item" };

  const workspaceId = await requireWorkspaceId();
  const reviewStep = await prisma.reviewStep.findFirst({ where: { id: reviewStepId, contract: { deal: { id: dealId, workspaceId } } } });
  if (!reviewStep) return { error: "Review step not found" };

  const user = await currentUserWithRole();
  const { eligible } = await checkReviewStepEligibility(reviewStep, user.id);
  if (!eligible) return { error: "You're not eligible to edit this review step" };

  await prisma.reviewChecklistItem.create({ data: { reviewStepId, label } });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}

export async function toggleChecklistItem(dealId: string, itemId: string, done: boolean): Promise<{ error?: string }> {
  const workspaceId = await requireWorkspaceId();
  const item = await prisma.reviewChecklistItem.findFirst({
    where: { id: itemId, reviewStep: { contract: { deal: { id: dealId, workspaceId } } } },
    include: { reviewStep: true },
  });
  if (!item) return { error: "Checklist item not found" };

  const user = await currentUserWithRole();
  const { eligible } = await checkReviewStepEligibility(item.reviewStep, user.id);
  if (!eligible) return { error: "You're not eligible to edit this review step" };

  await prisma.reviewChecklistItem.update({ where: { id: itemId }, data: { done, doneAt: done ? new Date() : null } });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}

export async function removeChecklistItem(dealId: string, itemId: string): Promise<{ error?: string }> {
  const workspaceId = await requireWorkspaceId();
  const item = await prisma.reviewChecklistItem.findFirst({
    where: { id: itemId, reviewStep: { contract: { deal: { id: dealId, workspaceId } } } },
    include: { reviewStep: true },
  });
  if (!item) return { error: "Checklist item not found" };

  const user = await currentUserWithRole();
  const { eligible } = await checkReviewStepEligibility(item.reviewStep, user.id);
  if (!eligible) return { error: "You're not eligible to edit this review step" };

  await prisma.reviewChecklistItem.delete({ where: { id: itemId } });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}

// Comments are visible workspace-wide (same as DealNote) — anyone signed
// into the workspace can leave one, not just the step's assignee, since a
// comment is a lighter-weight "hey, noticed this" than the actual decision.
export async function addReviewComment(dealId: string, reviewStepId: string, body: string): Promise<{ error?: string }> {
  const trimmed = body.trim();
  if (!trimmed) return { error: "Comment can't be empty" };

  const workspaceId = await requireWorkspaceId();
  const reviewStep = await prisma.reviewStep.findFirst({ where: { id: reviewStepId, contract: { deal: { id: dealId, workspaceId } } } });
  if (!reviewStep) return { error: "Review step not found" };

  const user = await currentUserWithRole();
  await prisma.reviewComment.create({ data: { reviewStepId, authorEmail: user.email, authorName: user.name, body: trimmed } });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}

export async function deleteReviewComment(dealId: string, commentId: string): Promise<{ error?: string }> {
  const workspaceId = await requireWorkspaceId();
  const comment = await prisma.reviewComment.findFirst({ where: { id: commentId, reviewStep: { contract: { deal: { id: dealId, workspaceId } } } } });
  if (!comment) return { error: "Comment not found" };

  const user = await currentUserWithRole();
  if (comment.authorEmail !== user.email) return { error: "You can only delete your own comments" };

  await prisma.reviewComment.delete({ where: { id: commentId } });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}

// Set or clear a step's due date / priority — either the assignee
// themselves or anyone who can manage the workspace (an admin helping
// triage) can adjust these; they're not part of the approve/reject
// decision itself.
export async function updateReviewStepMeta(dealId: string, reviewStepId: string, formData: FormData): Promise<{ error?: string }> {
  const workspaceId = await requireWorkspaceId();
  const reviewStep = await prisma.reviewStep.findFirst({ where: { id: reviewStepId, contract: { deal: { id: dealId, workspaceId } } } });
  if (!reviewStep) return { error: "Review step not found" };

  const user = await currentUserWithRole();
  const { eligible } = await checkReviewStepEligibility(reviewStep, user.id);
  if (!eligible && !user.role?.canManageWorkspace) return { error: "You're not eligible to edit this review step" };

  const priority = String(formData.get("priority") ?? "normal");
  if (!["low", "normal", "high", "urgent"].includes(priority)) return { error: "Invalid priority" };

  const rawDueAt = String(formData.get("dueAt") ?? "").trim();
  const dueAt = rawDueAt ? new Date(rawDueAt) : null;
  if (rawDueAt && Number.isNaN(dueAt?.getTime())) return { error: "Invalid due date" };

  await prisma.reviewStep.update({ where: { id: reviewStepId }, data: { priority, dueAt, dueReminderSentAt: null } });
  revalidatePath(`/deals/${dealId}`);
  revalidatePath(`/deals/${dealId}/contract`);
  return {};
}
