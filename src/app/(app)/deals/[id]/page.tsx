import { notFound } from "next/navigation";
import { buildContractSnapshot, snapshotDiffers } from "@/lib/contract-snapshot";
import LiveDealView, { type ChangesRequestedBy } from "@/components/LiveDealView";
import { prisma } from "@/lib/db";
import { requireWorkspaceId, requireWorkspace } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { leadAccess } from "@/lib/lead-visibility";
import { cookieTimeZone, dayInZone } from "@/lib/viewer-time";
import { contractExpired } from "@/lib/contract-status";
// CHANGES_REQUESTED_ACTIONS: the audit entries that put a contract in
// changes_requested (the approval rejection is logged against the deal).
import { CHANGES_REQUESTED_ACTIONS, docusignVoid } from "@/lib/docusign-sync";
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


// Who put the contract in changes_requested: nothing on Contract says, the
// latest of the entries above does. Undefined for a DocuSign void (the
// docusignVoid prop covers it) or when there's no entry.
async function changesRequestedBy(contract: { id: string; dealId: string; status: string }, workspaceId: string): Promise<ChangesRequestedBy | undefined> {
  if (contract.status !== "changes_requested") return undefined;
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
  if (latest?.action === "contract.approval_rejected") return { by: "reviewer", name: null };
  if (latest?.action === "contract.clause_change_requested") return { by: "client", name: null };
  if (latest?.action === "contract.countersign_declined" || latest?.action === "contract.docusign_declined") {
    let name: string | null = null;
    try {
      const metadata = latest.metadata ? (JSON.parse(latest.metadata) as { signerName?: unknown }) : null;
      if (typeof metadata?.signerName === "string" && metadata.signerName.trim()) name = metadata.signerName.trim();
    } catch {
      // Unreadable metadata: still a decline, just without the name.
    }
    return { by: "signer", name };
  }
  return undefined;
}

export default async function DealDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await requireWorkspaceId();
  const currentUser = await currentUserWithRole();
  const { where: visibility } = await dealVisibilityFilter(currentUser);
  const [deal, workspace, teammates, activeDelegationsToMe, timeZone] = await Promise.all([
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
        // A proposal's contract, once one was made from it ("Open contract"),
        // and the proposal a contract was made from.
        derivedDeals: { where: { trashedAt: null, kind: { not: "proposal" } }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 1 },
        sourceDeal: { select: { id: true } },
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
    cookieTimeZone(),
  ]);
  if (!deal) notFound();

  // The way back goes to the lead only when this viewer can open it: a
  // reviewer can see a deal on a lead that isn't theirs.
  const access = await leadAccess(currentUser);
  const [leadVisible, changesRequested] = await Promise.all([
    deal.leadId && !access.canViewAll
      ? prisma.lead.findFirst({ where: { id: deal.leadId, workspaceId, ...access.where }, select: { id: true } }).then(Boolean)
      : Boolean(deal.leadId),
    deal.contract ? changesRequestedBy({ id: deal.contract.id, dealId: deal.id, status: deal.contract.status }, workspaceId) : undefined,
  ]);

  const delegatedAssigneeIds = [...new Set(activeDelegationsToMe.map((d) => d.fromUserId))];
  // A proposal is never reviewed, signed or sent through DocuSign; it can
  // only lead to a contract, made on one of these templates.
  const isProposal = deal.kind === "proposal";
  const contractTemplates = isProposal
    ? await prisma.contractTemplate.findMany({ where: { workspaceId, kind: { not: "proposal" } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];
  // A proposal stays editable after it went out; this says the client still
  // has the earlier version.
  const changedSinceSent =
    isProposal && deal.contract?.status === "sent" && deal.template
      ? snapshotDiffers(deal.contract.snapshot, buildContractSnapshot(deal.template, { fields: deal.fields, client: deal.client, workspace }))
      : false;

  const historyByKey = new Map<string, typeof deal.fieldChanges>();
  for (const change of deal.fieldChanges) {
    if (!historyByKey.has(change.fieldKey)) historyByKey.set(change.fieldKey, []);
    historyByKey.get(change.fieldKey)!.push(change);
  }

  return (
    <LiveDealView
      dealId={deal.id}
      leadId={leadVisible ? deal.leadId : null}
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
      contractStatus={deal.contract?.status ?? null}
      contractSentAt={deal.contract?.sentAt ?? null}
      trashed={Boolean(deal.trashedAt)}
      contractExpired={contractExpired(deal.contract)}
      docusignVoid={deal.contract ? await docusignVoid({ id: deal.contract.id, dealId: deal.id, status: deal.contract.status, deliveryMethod: deal.contract.deliveryMethod }, workspaceId) : undefined}
      changesRequestedBy={changesRequested}
      clientHasEmail={Boolean(deal.client.email)}
      sendViaDocusignNowAction={sendViaDocusignNow}
      kind={deal.kind}
      contractId={deal.contract?.id ?? null}
      derivedContractId={deal.derivedDeals[0]?.id ?? null}
      contractTemplates={contractTemplates}
      sourceDealId={deal.sourceDeal?.id ?? null}
      changedSinceSent={changedSinceSent}
      today={dayInZone(new Date(), timeZone)}
      reviewPanel={
        deal.contract && !isProposal
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
              // No one to pick means no "Send to": a review ends in a send,
              // and nothing goes out from the trash (sendForReviewTo refuses).
              teammates: deal.trashedAt ? [] : teammates,
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
