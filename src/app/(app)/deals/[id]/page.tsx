import { notFound } from "next/navigation";
import { buildContractSnapshot, parseContractSnapshot, showsLiveTerms, showsSignatures, snapshotDiffers } from "@/lib/contract-snapshot";
import LiveDealView, { type ChangesRequestedBy } from "@/components/LiveDealView";
import { prisma } from "@/lib/db";
import { requireWorkspaceId, requireWorkspace } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { leadAccess } from "@/lib/lead-visibility";
import { cookieTimeZone, dayInZone } from "@/lib/viewer-time";
import { templateVersion } from "@/lib/deal-live-state";
import { contractExpired, documentLocksTerms } from "@/lib/contract-status";
import { NEW_LEAD_NAME, PLACEHOLDER_CLIENT } from "@/lib/cold-call";
// CHANGES_REQUESTED_ACTIONS: the audit entries that put a contract in
// changes_requested (the approval rejection is logged against the deal).
import { CHANGES_REQUESTED_ACTIONS, docusignVoid } from "@/lib/docusign-sync";
import {
  addDealNote,
  applyVoiceFieldCorrection,
  deleteDealNote,
  generateContractAndSend,
  getLiveDealState,
  makeDocumentDraft,
  retryExtraction,
  sendViaDocusignNow,
  setDealField,
  startRenewal,
  toggleActionItem,
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
            // What a send uses: the contract's own template once there is one.
            template: { select: { id: true, name: true, clauses: true } },
            // What the client asked to change, shown under each clause until
            // the next send answers it (review.tsx resolves them).
            clauseComments: {
              where: { resolved: false },
              orderBy: { createdAt: "asc" },
              select: { id: true, clauseTitle: true, comment: true, fromName: true, createdAt: true },
            },
            // Who still has to sign once the client did (partially signed).
            signers: { where: { status: "pending" }, orderBy: { order: "asc" }, select: { name: true, role: true } },
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
        // The call the deal was made on (Start a call): whether it's still
        // on, who it's with, and what's been said so far.
        phoneCall: {
          select: {
            id: true,
            status: true,
            source: true,
            startedAt: true,
            endedAt: true,
            transcript: true,
            lead: { select: { name: true, title: true, company: true } },
          },
        },
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
  const [leadVisible, changesRequested, markedNotSigned] = await Promise.all([
    deal.leadId && !access.canViewAll
      ? prisma.lead.findFirst({ where: { id: deal.leadId, workspaceId, ...access.where }, select: { id: true } }).then(Boolean)
      : Boolean(deal.leadId),
    deal.contract ? changesRequestedBy({ id: deal.contract.id, dealId: deal.id, status: deal.contract.status }, workspaceId) : undefined,
    // When the rep marked it not signed: Contract keeps no updatedAt, so it
    // comes from the audit log.
    deal.contract?.status === "not_signed" && deal.kind !== "proposal"
      ? prisma.auditLog.findFirst({
          where: { workspaceId, action: "contract.marked_not_signed", targetId: { in: [deal.contract.id, deal.id] } },
          select: { createdAt: true },
          orderBy: { createdAt: "desc" },
        })
      : null,
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
  const template = deal.contract?.template ?? deal.template;
  const changedSinceSent =
    isProposal && deal.contract?.status === "sent" && template
      ? snapshotDiffers(deal.contract.snapshot, buildContractSnapshot(template, { fields: deal.fields, client: deal.client, workspace }))
      : false;

  const historyByKey = new Map<string, typeof deal.fieldChanges>();
  for (const change of deal.fieldChanges) {
    if (!historyByKey.has(change.fieldKey)) historyByKey.set(change.fieldKey, []);
    historyByKey.get(change.fieldKey)!.push(change);
  }

  // The text the paper is drawn from. A contract that's with a reviewer or
  // the client is read-only. While it's with a reviewer it shows the terms
  // they're approving (the live ones; a snapshot from an earlier send is
  // stale by then), the same rule as the contract page (showsLiveTerms).
  // Once it's out with the client it shows what they got, drawn with its
  // terms marked when that's still the template with today's terms, else as
  // the plain text that was sent.
  const termsLocked = documentLocksTerms(deal.contract, deal.kind);
  const liveText = template ? buildContractSnapshot(template, { fields: deal.fields, client: deal.client, workspace }) : null;
  const sentText = termsLocked && deal.contract && !showsLiveTerms(deal.contract) ? parseContractSnapshot(deal.contract.snapshot) : null;
  const plainText = sentText && (!liveText || snapshotDiffers(sentText, liveText)) ? sentText : null;
  // A signature only sits under the terms that were signed (showsSignatures).
  const signature =
    deal.contract && !isProposal && (deal.contract.signedAt || deal.contract.signerName) && showsSignatures({ ...deal.contract, template }, { asTeam: true })
      ? { signerName: deal.contract.signerName, signedAt: deal.contract.signedAt?.toISOString() ?? null, image: deal.contract.signatureImage }
      : null;
  const call = deal.phoneCall;
  const person = call?.lead && call.lead.name !== NEW_LEAD_NAME ? call.lead : null;
  // A document made during a cold call goes to a stand-in client until the
  // call says who it was with.
  const clientNameKnown = deal.client.name !== PLACEHOLDER_CLIENT && deal.client.name !== NEW_LEAD_NAME;
  // A signed contract with a term that ends or renews (set when it was
  // signed): when, and the way to start the next one.
  const renewal =
    deal.contract && !isProposal && deal.contract.status === "signed" && deal.contract.renewalDate
      ? { date: deal.contract.renewalDate.toISOString(), autoRenews: deal.contract.autoRenews, note: deal.contract.renewalNote }
      : null;

  return (
    <LiveDealView
      dealId={deal.id}
      leadId={leadVisible ? deal.leadId : null}
      clientName={deal.client.name}
      clientNameKnown={clientNameKnown}
      client={{ name: deal.client.name, company: deal.client.company }}
      agencyName={workspace.name}
      contractViewedAt={deal.contract?.viewedAt?.toISOString() ?? null}
      template={template ? { id: template.id, version: templateVersion(template), name: template.name, clauses: template.clauses } : null}
      plainText={plainText}
      signature={signature}
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
        history: (historyByKey.get(f.fieldKey) ?? []).map((h) => ({ oldValue: h.oldValue, newValue: h.newValue, changedBy: h.changedBy, changedAt: h.changedAt })),
      }))}
      initialCalls={deal.calls.map((c) => ({ id: c.id, source: c.source, startedAt: c.startedAt, endedAt: c.endedAt, transcript: c.transcript }))}
      initialActionItems={deal.actionItems.map((a) => ({ id: a.id, description: a.description, ownerType: a.ownerType, dueDate: a.dueDate, status: a.status, sourceQuote: a.sourceQuote }))}
      initialCallHighlights={deal.callHighlights.map((h) => ({ id: h.id, type: h.type, body: h.body, sourceQuote: h.sourceQuote }))}
      phoneCall={
        call
          ? {
              id: call.id,
              status: call.status,
              source: call.source,
              startedAt: call.startedAt.toISOString(),
              endedAt: call.endedAt?.toISOString() ?? null,
              transcript: call.transcript ?? "",
              personName: person?.name ?? null,
              personSub: person?.title?.trim() || person?.company?.trim() || null,
            }
          : null
      }
      getLiveDealStateAction={getLiveDealState}
      setFieldAction={setDealField.bind(null, deal.id)}
      generateAndSendAction={generateContractAndSend.bind(null, deal.id)}
      makeDraftAction={makeDocumentDraft.bind(null, deal.id)}
      retryExtractionAction={retryExtraction.bind(null, deal.id)}
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
      contractSentAt={deal.contract?.sentAt?.toISOString() ?? null}
      contractSignedAt={deal.contract?.signedAt?.toISOString() ?? null}
      contractSignerName={deal.contract?.signerName ?? null}
      contractExpiresAt={deal.contract?.expiresAt?.toISOString() ?? null}
      contractDeliveryMethod={deal.contract?.deliveryMethod ?? null}
      markedNotSignedAt={markedNotSigned?.createdAt.toISOString() ?? null}
      pendingSigners={isProposal ? [] : (deal.contract?.signers ?? []).map((s) => ({ name: s.name, role: s.role }))}
      clauseComments={
        isProposal
          ? []
          : (deal.contract?.clauseComments ?? []).map((c) => ({ id: c.id, clauseTitle: c.clauseTitle, comment: c.comment, fromName: c.fromName, createdAt: c.createdAt.toISOString() }))
      }
      renewal={renewal}
      startRenewalAction={renewal ? startRenewal.bind(null, deal.id) : undefined}
      // The audit trail holds review decisions and signer IPs, so only
      // workspace admins export it (the route checks the same).
      canExportAuditTrail={Boolean(currentUser.role?.canManageWorkspace) && Boolean(deal.contract)}
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
