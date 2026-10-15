import { notFound } from "next/navigation";
import LiveDealView from "@/components/LiveDealView";
import { prisma } from "@/lib/db";
import { requireWorkspaceId, requireWorkspace } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import {
  addDealNote,
  applyVoiceFieldCorrection,
  deleteDealNote,
  fillMissingFields,
  generateContract,
  getLiveDealState,
  retryExtraction,
  sendViaDocusignNow,
  toggleActionItem,
  updateFieldValues,
} from "./actions";
import {
  getReviewState,
  sendForReviewTo,
  decideReviewStep,
  addChecklistItem,
  toggleChecklistItem,
  removeChecklistItem,
  addReviewComment,
  deleteReviewComment,
  updateReviewStepMeta,
} from "./review-actions";

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await requireWorkspaceId();
  const currentUser = await currentUserWithRole();
  const { where: visibility } = await dealVisibilityFilter(currentUser);
  const [deal, workspace, teammates, activeDelegationsToMe] = await Promise.all([
    prisma.deal.findFirst({
      where: { id, workspaceId, ...visibility },
      include: {
        client: true,
        fields: { orderBy: { orderIndex: "asc" } },
        template: true,
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
        calls: { orderBy: { startedAt: "asc" } },
        fieldChanges: { orderBy: { changedAt: "asc" } },
        actionItems: { orderBy: { createdAt: "asc" } },
        callHighlights: { orderBy: { createdAt: "asc" } },
        notes: { orderBy: { createdAt: "desc" } },
      },
    }),
    requireWorkspace(),
    prisma.user.findMany({
      where: {
        workspaceId,
        deactivatedAt: null,
        ...(currentUser.role?.canManageWorkspace ? {} : { id: { not: currentUser.id } }),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    prisma.approvalDelegate.findMany({
      where: { toUserId: currentUser.id, startsAt: { lte: new Date() }, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
    }),
  ]);
  if (!deal) notFound();

  const delegatedAssigneeIds = [...new Set(activeDelegationsToMe.map((d) => d.fromUserId))];

  const historyByKey = new Map<string, typeof deal.fieldChanges>();
  for (const change of deal.fieldChanges) {
    if (!historyByKey.has(change.fieldKey)) historyByKey.set(change.fieldKey, []);
    historyByKey.get(change.fieldKey)!.push(change);
  }

  return (
    <LiveDealView
      dealId={deal.id}
      clientName={deal.client.name}
      service={deal.service}
      callLength={deal.callLength}
      contractViewedAt={deal.contract?.viewedAt ?? null}
      templateName={deal.template?.name ?? null}
      templateClauses={deal.template?.clauses ?? null}
      hasContract={Boolean(deal.contract)}
      initialStatus={deal.status}
      initialSummary={deal.summary}
      initialFields={deal.fields.map((f) => ({
        id: f.id,
        fieldKey: f.fieldKey,
        groupLabel: f.groupLabel,
        label: f.label,
        value: f.value,
        status: f.status,
        sourceQuote: f.sourceQuote,
        history: historyByKey.get(f.fieldKey) ?? [],
      }))}
      initialCalls={deal.calls}
      initialActionItems={deal.actionItems}
      initialCallHighlights={deal.callHighlights}
      getLiveDealStateAction={getLiveDealState}
      updateFieldsAction={updateFieldValues.bind(null, deal.id)}
      retryExtractionAction={retryExtraction.bind(null, deal.id)}
      fillMissingFieldsAction={fillMissingFields.bind(null, deal.id)}
      generateContractAction={generateContract.bind(null, deal.id)}
      toggleActionItemAction={toggleActionItem}
      notes={deal.notes.map((n) => ({ id: n.id, authorName: n.authorName, authorEmail: n.authorEmail, body: n.body, createdAt: n.createdAt.toISOString() }))}
      currentUserEmail={currentUser.email}
      currentUserName={currentUser.name}
      addNoteAction={addDealNote}
      deleteNoteAction={deleteDealNote}
      applyVoiceFieldCorrectionAction={applyVoiceFieldCorrection}
      sendForReviewToAction={sendForReviewTo}
      docusignEnabled={Boolean(workspace?.docusignEnabled)}
      contractIsDraft={deal.contract?.status === "draft"}
      clientHasEmail={Boolean(deal.client.email)}
      sendViaDocusignNowAction={sendViaDocusignNow}
      reviewPanel={
        deal.contract
          ? {
              initialContractStatus: deal.contract.status,
              initialContractCreatedAt: deal.contract.createdAt,
              initialContractSentAt: deal.contract.sentAt,
              initialContractSignedAt: deal.contract.signedAt,
              initialSteps: deal.contract.reviewSteps.map((s) => ({
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
              teammates,
              currentUserId: currentUser.id,
              delegatedAssigneeIds,
              currentUserCanManageWorkspace: Boolean(currentUser.role?.canManageWorkspace),
              getReviewStateAction: getReviewState,
              decideAction: decideReviewStep,
              addChecklistItemAction: addChecklistItem,
              toggleChecklistItemAction: toggleChecklistItem,
              removeChecklistItemAction: removeChecklistItem,
              addCommentAction: addReviewComment,
              deleteCommentAction: deleteReviewComment,
              updateStepMetaAction: updateReviewStepMeta,
            }
          : null
      }
    />
  );
}
