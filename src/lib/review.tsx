import { randomBytes } from "crypto";
import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import { sendContractEmail, sendReviewAssignedEmail, sendChangesRequestedEmail } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { getOrMintPortalToken } from "@/lib/client-portal";
import { parseFee } from "@/lib/money";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { notifySlack } from "@/lib/slack";
import { syncDealToHubspot } from "@/lib/hubspot";
import { syncDealToSalesforce } from "@/lib/salesforce";
import { contractParty, extractPlaceholderKeys, fillClauses } from "@/lib/contract";
import { contractExpired } from "@/lib/contract-status";
import { ContractPdfDocument } from "@/lib/contract-pdf";
import { sendDocusignEnvelope, type EnvelopeSigner } from "@/lib/docusign";

export type PendingEmail = { to: string; subject: string; message: string };

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

// A contract can go to the client (or into review) only as a draft, after
// changes were asked for, or once it expired (including a SealMe link past
// expiresAt that the daily cron hasn't marked yet). Anything else is already
// with a reviewer or the client, and sending it again would start a second
// envelope or let a signature be overwritten.
export function canSendContract(contract: { status: string; deliveryMethod: string; expiresAt: Date | null }, now = new Date()): boolean {
  return contract.status === "draft" || contract.status === "changes_requested" || contractExpired(contract, now);
}

// A send must never leave a raw "{fee}" in the client's copy: a term that's
// still empty, or a placeholder the deal has no field for.
function assertNoBlanks(clausesJson: string, fields: { fieldKey: string; label: string; value: string | null }[]) {
  const filled = new Set(fields.filter((f) => f.value?.trim()).map((f) => f.fieldKey));
  const blanks = extractPlaceholderKeys(clausesJson).filter((key) => !filled.has(key));
  if (blanks.length > 0) {
    const labels = blanks.map((key) => fields.find((f) => f.fieldKey === key)?.label ?? key);
    throw new Error(`Fill in ${labels.join(", ")} before sending. The contract still has blanks`);
  }
}

// Picks which of the workspace's ReviewChains applies to this deal. Chains
// are checked in `order` (lower first); the first one whose
// teamId/minDealValue conditions both match wins. A chain with no
// conditions at all matches everything, so it's meant to sit last as a
// catch-all — see the doc comment on the ReviewChain model. Returns null
// when the workspace has no chains configured (send immediately, same as
// before per-chain conditions existed).
export async function resolveReviewChain(deal: { workspaceId: string; teamId: string | null; feeDisplay: string }) {
  const chains = await prisma.reviewChain.findMany({
    where: { workspaceId: deal.workspaceId },
    orderBy: { order: "asc" },
    include: { steps: { orderBy: { order: "asc" } } },
  });
  if (chains.length === 0) return null;

  const dealValue = parseFee(deal.feeDisplay);
  return chains.find((chain) => {
    const teamMatches = !chain.teamId || chain.teamId === deal.teamId;
    const valueMatches = chain.minDealValue == null || dealValue >= chain.minDealValue;
    return teamMatches && valueMatches;
  }) ?? null;
}

// Called anywhere a contract is about to leave the workspace's control —
// the manual Send page and the "no review needed" auto-send path both go
// through here. If a chain resolves for this deal, the contract is held in
// "pending_approval" and the composed email is stored verbatim until the
// chain finishes; otherwise it's sent immediately, exactly like before this
// feature existed.
export async function requestOrSendReview(
  dealId: string,
  pending: PendingEmail,
  actorEmail?: string | null
): Promise<{ status: "sent" } | { status: "pending_approval"; assigneeName: string }> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { contract: { include: { template: true } }, fields: true } });
  if (!deal || !deal.contract) throw new Error("Deal not found");
  const contractId = deal.contract.id;
  if (!canSendContract(deal.contract)) {
    throw new Error(deal.contract.status === "pending_approval" ? "This contract is already waiting on review" : "This contract was already sent");
  }
  if (deal.contract.template) assertNoBlanks(deal.contract.template.clauses, deal.fields);

  const chain = await resolveReviewChain(deal);

  if (!chain || chain.steps.length === 0) {
    await performActualSend(contractId, pending, actorEmail);
    await logAudit({ workspaceId: deal.workspaceId, actorEmail, action: "contract.sent", targetType: "Deal", targetId: dealId, metadata: { to: pending.to } });
    return { status: "sent" };
  }

  // A contract re-entering review after a rejection gets a fresh snapshot —
  // always mirrors the chain as currently configured (and re-resolved
  // against the deal's current team/value), never a stale one left over
  // from a previous round.
  await prisma.reviewStep.deleteMany({ where: { contractId } });
  const createdSteps = await Promise.all(
    chain.steps.map((s) =>
      prisma.reviewStep.create({ data: { contractId, assigneeId: s.assigneeId, order: s.order, status: "pending" } })
    )
  );
  await prisma.contract.update({
    where: { id: contractId },
    data: {
      status: "pending_approval",
      pendingTo: pending.to,
      pendingSubject: pending.subject,
      pendingMessage: pending.message,
    },
  });
  await prisma.deal.update({ where: { id: dealId }, data: { status: "pending_approval" } });

  await logAudit({ workspaceId: deal.workspaceId, actorEmail, action: "contract.approval_requested", targetType: "Deal", targetId: dealId, metadata: { chain: chain.name } });

  const firstStep = createdSteps.find((s) => s.order === chain.steps[0].order) ?? createdSteps[0];
  await notifyStepAssignee(dealId, firstStep.id);

  const firstAssignee = await prisma.user.findUnique({ where: { id: chain.steps[0].assigneeId } });
  return { status: "pending_approval", assigneeName: firstAssignee?.name ?? "the reviewer" };
}

// Actually emails the client — either right away (no chain configured) or
// once the last review step has signed off. pendingOverride lets the
// immediate-send path skip a DB round-trip; the review path relies on
// what's already stored on the contract. When the contract's
// deliveryMethod is "docusign", the client never gets a SealMe email at
// all — DocuSign sends its own, this just creates and sends the envelope.
// senderEmail is whoever clicked Send; the client's replies go to them.
export async function performActualSend(contractId: string, pendingOverride?: PendingEmail, senderEmail?: string | null): Promise<void> {
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    include: {
      deal: {
        include: {
          client: true,
          owner: true,
          workspace: { include: { users: { where: { deactivatedAt: null }, include: { role: true }, orderBy: { createdAt: "asc" } } } },
          fields: true,
        },
      },
      template: true,
      signers: { orderBy: { order: "asc" } },
    },
  });
  if (!contract || !contract.template) throw new Error("Contract not found");
  if (!canSendContract(contract) && contract.status !== "pending_approval") throw new Error("This contract was already sent");
  assertNoBlanks(contract.template.clauses, contract.deal.fields);

  const to = pendingOverride?.to ?? contract.pendingTo;
  const subject = pendingOverride?.subject ?? contract.pendingSubject;
  const message = pendingOverride?.message ?? contract.pendingMessage;
  if (!to || !subject || !message) throw new Error("Missing email content to send");

  const { deal } = contract;
  const { workspace } = deal;
  const signLink = `${appUrl()}/sign/${contract.id}`;

  let docusignEnvelopeId: string | undefined;
  if (contract.deliveryMethod === "docusign") {
    const anchorFor = (i: number) => `[[sig${i}]]`;
    const signers: EnvelopeSigner[] = [
      { name: deal.client.name, email: to, routingOrder: 1, anchor: anchorFor(1) },
      ...contract.signers.map((s, i) => ({ name: s.name, email: s.email, routingOrder: i + 2, anchor: anchorFor(i + 2) })),
    ];
    const clauses = fillClauses(contract.template.clauses, deal.fields);
    const pdfBuffer = await renderToBuffer(
      <ContractPdfDocument
        templateName={contract.template.name}
        agencyName={workspace.name}
        agencyLogo={workspace.logoImage}
        clientName={contractParty(deal.fields, deal.client)}
        clauses={clauses}
        docusignAnchors={signers.map((s) => ({ label: `${s.name} (${s.routingOrder === 1 ? "Client" : "Signer " + s.routingOrder})`, anchor: s.anchor }))}
      />
    );
    docusignEnvelopeId = await sendDocusignEnvelope(workspace.id, { pdfBuffer, emailSubject: subject, emailBlurb: message, signers });
  } else {
    // Whoever sent it, else the deal's owner, else an admin. Never someone
    // who has been offboarded.
    const activeEmails = new Set(workspace.users.map((u) => u.email));
    const replyTo =
      [senderEmail, deal.owner?.email].find((e): e is string => !!e && activeEmails.has(e)) ??
      workspace.users.find((u) => u.role?.canManageWorkspace)?.email ??
      workspace.users[0]?.email ??
      null;
    const verifiedSenderEmail = workspace.senderDomainStatus === "verified" ? workspace.senderEmail : null;

    const portalToken = await getOrMintPortalToken(deal.client.id);
    const portalUrl = `${appUrl()}/portal/${portalToken}`;

    let cc: string[] | undefined;
    try {
      cc = contract.ccEmails ? (JSON.parse(contract.ccEmails) as string[]) : undefined;
    } catch {
      cc = undefined;
    }

    await sendContractEmail({ to, cc, subject, message, signLink, workspaceName: workspace.name, replyTo, verifiedSenderEmail, portalUrl });
  }

  const sentAt = new Date();
  const expiresAt = workspace.signingExpiryDays ? new Date(sentAt.getTime() + workspace.signingExpiryDays * 24 * 60 * 60 * 1000) : null;

  // Every send starts a fresh signing round: a signature or a decline on an
  // earlier version doesn't carry over, so the client and every counter-signer
  // sign this one (counter-signers with a new link once it's their turn), and
  // the "still unsigned" nudge goes out again for the new link.
  await prisma.contract.update({
    where: { id: contractId },
    data: {
      status: "sent",
      sentAt,
      expiresAt,
      reminderSentAt: null,
      docusignEnvelopeId,
      pendingTo: null,
      pendingSubject: null,
      pendingMessage: null,
      signedAt: null,
      signerName: null,
      signerIp: null,
      signatureImage: null,
      viewedAt: null,
    },
  });
  for (const signer of contract.signers.filter((s) => s.status !== "pending" || s.notifiedAt)) {
    await prisma.contractSigner.update({
      where: { id: signer.id },
      data: { status: "pending", token: randomBytes(24).toString("hex"), signatureImage: null, signerIp: null, signedAt: null, declinedReason: null, notifiedAt: null },
    });
  }
  await prisma.deal.update({ where: { id: deal.id }, data: { status: "sent" } });
  // Resending is how the workspace answers open clause-change requests —
  // whatever they asked for is presumably reflected in this new version.
  await prisma.clauseComment.updateMany({ where: { contractId, resolved: false }, data: { resolved: true } });

  await dispatchWebhookEvent(workspace.id, "contract.sent", {
    dealId: deal.id,
    contractId: contract.id,
    clientName: deal.client.name,
    signLink: contract.deliveryMethod === "docusign" ? undefined : signLink,
  });
  await notifySlack(workspace.id, { type: "contract.sent", dealId: deal.id, clientName: deal.client.name });
  await syncDealToHubspot(workspace.id, deal.id);
  await syncDealToSalesforce(workspace.id, deal.id);
}

// Notifies the named assignee that a contract needs their review — the
// "jako je bitno" hook: fires the instant a contract reaches someone,
// either because the chain just started or because the person before them
// just finished their step. Both channels (email, in-app) are independent
// try/catches so one failing never silently drops the other, and neither
// blocks the state change that already happened — this is a nudge, not a
// gate.
export async function notifyStepAssignee(dealId: string, reviewStepId: string): Promise<void> {
  const [deal, reviewStep] = await Promise.all([
    prisma.deal.findUnique({ where: { id: dealId }, include: { client: true, template: true } }),
    prisma.reviewStep.findUnique({ where: { id: reviewStepId }, include: { assignee: true } }),
  ]);
  if (!deal || !reviewStep) return;
  const dealUrl = `${appUrl()}/deals/${dealId}`;

  try {
    await sendReviewAssignedEmail({
      to: reviewStep.assignee.email,
      clientName: deal.client.name,
      templateName: deal.template?.name ?? "contract",
      dealUrl,
    });
  } catch (err) {
    console.error("Failed to send review-assigned email", err);
  }

  try {
    await createNotification({
      workspaceId: deal.workspaceId,
      userId: reviewStep.assigneeId,
      type: "review.assigned",
      title: `Review needed: ${deal.client.name}`,
      body: `${deal.template?.name ?? "A contract"} is waiting on your review.`,
      linkUrl: dealUrl,
    });
  } catch (err) {
    console.error("Failed to create in-app notification", err);
  }

  try {
    await notifySlack(deal.workspaceId, { type: "review.assigned", dealId, clientName: deal.client.name, assigneeName: reviewStep.assignee.name });
  } catch (err) {
    console.error("Failed to send Slack review-assigned notification", err);
  }
}

// No per-deal owner is tracked, so a rejection notifies the whole team —
// same audience the "email me when a contract is signed" toggle already
// reaches. Offboarded teammates are left out.
export async function notifyChangesRequested(dealId: string, decidedByName: string, note: string | null): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { client: true, template: true, workspace: { include: { users: { where: { deactivatedAt: null } } } } },
  });
  if (!deal || deal.workspace.users.length === 0) return;

  try {
    await sendChangesRequestedEmail({
      to: deal.workspace.users.map((u) => u.email),
      clientName: deal.client.name,
      templateName: deal.template?.name ?? "contract",
      dealUrl: `${appUrl()}/deals/${dealId}`,
      decidedByName,
      note,
    });
  } catch (err) {
    console.error("Failed to send changes-requested email", err);
  }
}
