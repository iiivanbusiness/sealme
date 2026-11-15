import { randomBytes } from "crypto";
import { refreshLeadPipeline } from "@/lib/lead-pipeline";
import { renderToBuffer } from "@react-pdf/renderer";
import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { sendContractEmail, sendReviewAssignedEmail, sendChangesRequestedEmail } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { logAudit } from "@/lib/audit";
import { getOrMintPortalToken } from "@/lib/client-portal";
import { parseFee } from "@/lib/money";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { notifySlack } from "@/lib/slack";
import { syncDealToHubspot } from "@/lib/hubspot";
import { syncDealToSalesforce } from "@/lib/salesforce";
import { extractPlaceholderKeys } from "@/lib/contract";
import { contractClosed } from "@/lib/contract-status";
import { buildContractSnapshot } from "@/lib/contract-snapshot";
import { ContractPdfDocument } from "@/lib/contract-pdf";
import { sendDocusignEnvelope, type EnvelopeSigner } from "@/lib/docusign";
import { DOCUSIGN_BUSY, forgetEnvelope, retireEarlierEnvelope } from "@/lib/docusign-sync";
import { clientDocumentUrl } from "@/lib/document-links";
import { reportError } from "@/lib/error-report";

export type PendingEmail = { to: string; subject: string; message: string };

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

// A contract can go to the client (or into review) only as a draft, after
// changes were asked for, or once it won't be signed: it expired (including
// a SealMe link past expiresAt that the daily cron hasn't marked yet) or the
// rep marked it not signed. Anything else is already with a reviewer or the
// client, and sending it again would start a second envelope or let a
// signature be overwritten.
export function canSendContract(contract: { status: string; deliveryMethod: string; expiresAt: Date | null }, now = new Date()): boolean {
  return contract.status === "draft" || contract.status === "changes_requested" || contractClosed(contract, now);
}

// The same for any document. A proposal is only read, so one that already
// went out can go again ("Send again", a nudge, or to someone else): there's
// no signature to overwrite and the client gets the same page.
export function canSendDocument(contract: { status: string; deliveryMethod: string; expiresAt: Date | null }, kind: string | null | undefined, now = new Date()): boolean {
  return canSendContract(contract, now) || (kind === "proposal" && contract.status === "sent");
}

type TermField = { fieldKey: string; label: string; value: string | null };

// What a send would leave as a raw "{fee}" in the client's copy: a term
// that's still empty, or a placeholder the deal has no field for. Named the
// way the rep sees them.
export function blankTerms(clausesJson: string, fields: TermField[]): string[] {
  const filled = new Set(fields.filter((f) => f.value?.trim()).map((f) => f.fieldKey));
  const blanks = extractPlaceholderKeys(clausesJson).filter((key) => !filled.has(key));
  return blanks.map((key) => fields.find((f) => f.fieldKey === key)?.label ?? key);
}

// A send must never leave a blank in the client's copy.
export function assertNoBlanks(clausesJson: string, fields: TermField[], kind?: string | null) {
  const labels = blankTerms(clausesJson, fields);
  if (labels.length > 0) {
    throw new Error(`Fill in ${labels.join(", ")} before sending. The ${kind === "proposal" ? "proposal" : "contract"} still has blanks`);
  }
}

type ProposalToMark = {
  id: string;
  template: { name: string; clauses: string };
  deal: Parameters<typeof buildContractSnapshot>[1] & { id: string; leadId: string | null };
};

// A proposal reaching the client, by email or by a copied link: its text is
// frozen as of now, the rep sees Sent, the lead moves to Proposal sent, and
// the client's first open counts as a new view. A proposal is only read,
// so it never expires, gets no automatic reminders (only the rep's Send
// reminder, see deals/[id]/reminder-actions.ts), and has no signature or
// signers to reset. Both ways of sharing one go through here so they can't
// drift. copies: who the Send page copied this time, stored now that it
// went out (absent when sharing a link).
export async function markProposalSent(contract: ProposalToMark, now = new Date(), copies: { ccEmails?: string | null } = {}): Promise<void> {
  const snapshot = buildContractSnapshot(contract.template, contract.deal);
  await prisma.contract.update({
    where: { id: contract.id },
    data: {
      ...copies,
      status: "sent",
      sentAt: now,
      expiresAt: null,
      snapshot,
      deliveryMethod: "sealme",
      reminderSentAt: null,
      docusignEnvelopeId: null,
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
  await prisma.deal.update({ where: { id: contract.deal.id }, data: { status: "sent" } });
  // Going out to the client is the lead's newest activity.
  await refreshLeadPipeline(contract.deal.leadId, { sentNow: true });
  await prisma.clauseComment.updateMany({ where: { contractId: contract.id, resolved: false }, data: { resolved: true } });
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

// What DocuSign shows the signers of an envelope a new version replaced.
const REPLACED_VOID_REASON = "Replaced by a new version of the contract";

// Every new round of a contract starts with one of these clicks: the Send
// page, Send via DocuSign, or "Send to" starting a fresh review (and, as a
// last check, the send itself, see performActualSend). The envelope it went
// out in before is dealt with first (retireEarlierEnvelope): if the client
// finished it, the contract is signed and nothing goes out; one still out is
// voided, so it can't stay signable next to the new round. Anything that
// leaves it possibly signable stops the round, by DocuSign or by SealMe link
// alike: a signature on the old envelope would otherwise be recorded against
// the new version's terms. deliveryMethod is how this round goes out.
export async function retireBeforeSend(
  contract: { id: string; docusignEnvelopeId: string | null },
  deal: { id: string; workspaceId: string },
  deliveryMethod: string
): Promise<void> {
  const envelopeId = contract.docusignEnvelopeId;
  const earlier = await retireEarlierEnvelope({ contractId: contract.id, dealId: deal.id, workspaceId: deal.workspaceId, envelopeId }, REPLACED_VOID_REASON);
  switch (earlier.outcome) {
    case "gone":
      return;
    case "signed":
      throw new Error("The client already signed this in DocuSign, so nothing was sent again. It's marked signed now");
    case "busy":
      throw new Error(DOCUSIGN_BUSY);
    case "still_out":
      throw new Error("Couldn't cancel the DocuSign envelope sent before, so nothing went out. Try again in a minute");
    case "unchecked":
      throw new Error("Couldn't check the DocuSign envelope sent before, so nothing went out. Try again in a minute");
    case "disconnected":
      // The same words a first send by DocuSign gets: reconnect, then send.
      if (deliveryMethod === "docusign") throw earlier.error;
      // A SealMe link needs no DocuSign. SealMe can't see the old envelope
      // while disconnected, and after reconnecting a signature on it would
      // be finalized onto this round's terms, so the contract lets go of it.
      if (envelopeId) await forgetEnvelope(contract.id, envelopeId);
      await reportError(earlier.error, "Sent by SealMe link without checking the DocuSign envelope sent before", { dealId: deal.id, contractId: contract.id });
      return;
  }
}

// How the rep set up this send on the Send page: the delivery, who gets a
// copy (left as it is when absent) and the counter-signers (the whole list,
// left as it is when absent).
export type SendSetup = {
  deliveryMethod: "sealme" | "docusign";
  ccEmails?: string[];
  countersigners?: { name: string; email: string; role: string }[];
};

// A send's setup is stored in the same write as the send itself, or as a
// review starts holding it (the last approval sends with what's stored),
// never before. So a send that's refused, loses to another send or fails
// leaves the contract as its last round went out, and an envelope from that
// round is finalized against the signers it really had.
function setupFields(setup: SendSetup | undefined): { deliveryMethod?: string; ccEmails?: string | null } {
  if (!setup) return {};
  return {
    deliveryMethod: setup.deliveryMethod,
    ...(setup.ccEmails ? { ccEmails: setup.ccEmails.length > 0 ? JSON.stringify(setup.ccEmails) : null } : {}),
  };
}

// The Send page starts from the current signers, so what comes back is the
// whole list: it replaces everyone on an earlier version, including anyone
// who signed or declined it, and an empty list means no counter-signers
// (how a rep takes off one who declined). Each one gets a new link. Writes
// for a transaction alongside the rest of the setup.
function replaceSigners(contractId: string, countersigners: NonNullable<SendSetup["countersigners"]>): Prisma.PrismaPromise<unknown>[] {
  return [
    prisma.contractSigner.deleteMany({ where: { contractId } }),
    ...(countersigners.length > 0
      ? [
          prisma.contractSigner.createMany({
            data: countersigners.map((s, i) => ({ contractId, name: s.name, email: s.email, role: s.role, order: i + 1, token: randomBytes(24).toString("hex") })),
          }),
        ]
      : []),
  ];
}

// Who a contract's email copies, as stored.
function storedCopies(ccEmails: string | null): string[] | undefined {
  try {
    return ccEmails ? (JSON.parse(ccEmails) as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function alreadyOutError(status: string, doc: string): Error {
  return new Error(status === "pending_approval" ? `This ${doc} is already waiting on review` : `This ${doc} was already sent`);
}

// Called anywhere a contract is about to leave the workspace's control: the
// Send page and the deal page's Send via DocuSign both go through here, and
// nothing goes out without one of those clicks. If a chain resolves for this
// deal, the contract is held in "pending_approval" and the composed email is
// stored verbatim until the chain finishes; otherwise it's sent immediately,
// exactly like before this feature existed. In this order: the contract is
// checked as it is now, the envelope from before is dealt with, then the
// send (or the review) holds the contract, and only then is anything of
// this send's setup stored.
export async function requestOrSendReview(
  dealId: string,
  pending: PendingEmail,
  actorEmail?: string | null,
  setup?: SendSetup
): Promise<{ status: "sent" } | { status: "pending_approval"; assigneeName: string }> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { contract: { include: { template: true } }, fields: true } });
  if (!deal || !deal.contract) throw new Error("Deal not found");
  const contract = deal.contract;
  const contractId = contract.id;
  const isProposal = deal.kind === "proposal";
  if (!canSendDocument(contract, deal.kind)) throw alreadyOutError(contract.status, isProposal ? "proposal" : "contract");
  if (contract.template) assertNoBlanks(contract.template.clauses, deal.fields, deal.kind);
  // Before review too, so a chain only starts with nothing else out. By the
  // way this round goes out, not the one stored.
  if (!isProposal) await retireBeforeSend(contract, deal, setup?.deliveryMethod ?? contract.deliveryMethod);

  // A proposal is never reviewed: it isn't signed, the rep can send a new
  // version any time, and a chain's last approval would email the client
  // without the rep clicking Send.
  const chain = isProposal ? null : await resolveReviewChain(deal);

  if (!chain || chain.steps.length === 0) {
    // The send checks the contract again, holds it, and stores the setup
    // together with the send.
    await performActualSend(contractId, pending, actorEmail, setup);
    await logAudit({ workspaceId: deal.workspaceId, actorEmail, action: isProposal ? "proposal.sent" : "contract.sent", targetType: "Deal", targetId: dealId, metadata: { to: pending.to } });
    return { status: "sent" };
  }

  // The review takes the send from here, so it holds the contract the way a
  // send does: of two clicks at once only one starts it, and one that read
  // the contract before the other started it can't start another. The
  // setup is stored as the review starts, in the same write that lets go of
  // the hold (the last approval holds it again to send).
  const holdUntil = await holdForSending(contract);
  let createdSteps: { id: string; order: number }[];
  try {
    // A contract re-entering review after a rejection gets a fresh snapshot:
    // it always mirrors the chain as currently configured (and re-resolved
    // against the deal's current team/value), never a stale one left over
    // from a previous round.
    await prisma.reviewStep.deleteMany({ where: { contractId } });
    createdSteps = await Promise.all(
      chain.steps.map((s) =>
        prisma.reviewStep.create({ data: { contractId, assigneeId: s.assigneeId, order: s.order, status: "pending" } })
      )
    );
    await prisma.$transaction([
      prisma.contract.update({
        where: { id: contractId },
        data: {
          ...setupFields(setup),
          status: "pending_approval",
          pendingTo: pending.to,
          pendingSubject: pending.subject,
          pendingMessage: pending.message,
          reminderSentAt: contract.reminderSentAt,
        },
      }),
      ...(setup?.countersigners ? replaceSigners(contractId, setup.countersigners) : []),
    ]);
  } catch (err) {
    // The contract isn't in review and keeps the setup it had, and the next
    // try (which builds the steps again) isn't turned away.
    await releaseHold(contractId, holdUntil, contract.reminderSentAt);
    await reportError(err, "Start a review", { dealId });
    throw new Error("Couldn't start the review. Try again");
  }
  await prisma.deal.update({ where: { id: dealId }, data: { status: "pending_approval" } });
  // The rep clicked Send: a contract that went unsigned is on its way back
  // to the client, so the lead leaves Not signed now, not once it's approved.
  await refreshLeadPipeline(deal.leadId, { sentNow: true });

  await logAudit({ workspaceId: deal.workspaceId, actorEmail, action: "contract.approval_requested", targetType: "Deal", targetId: dealId, metadata: { chain: chain.name } });

  const firstStep = createdSteps.find((s) => s.order === chain.steps[0].order) ?? createdSteps[0];
  await notifyStepAssignee(dealId, firstStep.id);

  const firstAssignee = await prisma.user.findUnique({ where: { id: chain.steps[0].assigneeId } });
  return { status: "pending_approval", assigneeName: firstAssignee?.name ?? "the reviewer" };
}

// How long a send holds a contract: longer than any request may run, so a
// send whose server was stopped mid-way stops turning the next one away
// after it.
const SEND_HOLD_MS = 5 * 60 * 1000;

const ALREADY_SENDING = "This contract is already being sent";

// Marks the contract as being sent right now, or says another send got there
// first. Contract has no updated-at to compare, so the mark goes in
// reminderSentAt: that only means something while a contract is out with
// the client (the "still unsigned" nudge), and the send this guards resets
// it. The mark is the moment the hold runs out, so it's always ahead of
// now, while a real reminder is always a moment that already passed
// (api/cron/remind): a reminder that just went out never looks like a send
// in progress. Claimed over what the send was checked on: the status, the
// value just read, and sentAt, which every send that goes out moves on. So
// of two sends reading the same row only one gets it, a send reading after
// the mark sees it, and a send that read the contract before another one
// went out can't get it afterwards, even when that send left the status
// and reminderSentAt as they were ("sent", no reminder). Returns the mark,
// for letting go of it.
async function holdForSending(contract: { id: string; status: string; reminderSentAt: Date | null; sentAt: Date | null }): Promise<Date> {
  const now = Date.now();
  if (contract.reminderSentAt && contract.reminderSentAt.getTime() > now) throw new Error(ALREADY_SENDING);
  const holdUntil = new Date(now + SEND_HOLD_MS);
  const held = await prisma.contract.updateMany({
    where: { id: contract.id, status: contract.status, reminderSentAt: contract.reminderSentAt, sentAt: contract.sentAt },
    data: { reminderSentAt: holdUntil },
  });
  if (held.count === 0) throw new Error(ALREADY_SENDING);
  return holdUntil;
}

// Nothing went out, so the next try isn't turned away: reminderSentAt goes
// back to what it was, while the hold is still this send's.
async function releaseHold(contractId: string, holdUntil: Date, reminderSentAt: Date | null): Promise<void> {
  await prisma.contract.updateMany({ where: { id: contractId, reminderSentAt: holdUntil }, data: { reminderSentAt } });
}

// Actually emails the client — either right away (no chain configured) or
// once the last review step has signed off. pendingOverride lets the
// immediate-send path skip a DB round-trip; the review path relies on
// what's already stored on the contract. When the contract's
// deliveryMethod is "docusign", the client never gets a SealMe email at
// all — DocuSign sends its own, this just creates and sends the envelope.
// senderEmail is whoever clicked Send; the client's replies go to them.
// setup is how the rep set up this send on the Send page: it's what goes
// out, and it's stored only in the write that records the send.
// A proposal always goes by SealMe email with a link to read it, and none
// of the contract's signing setup or announcements apply to it.
export async function performActualSend(contractId: string, pendingOverride?: PendingEmail, senderEmail?: string | null, setup?: SendSetup): Promise<void> {
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
  const isProposal = contract.deal.kind === "proposal";
  // A review's last approval passes no email: it sends what the review
  // holds, so only while the contract is still in review. Any other send
  // goes straight out, so only when the contract may go out at all, and
  // never past a review someone started meanwhile. Checked on the contract
  // as its last round left it, since this send's setup isn't stored yet: a
  // SealMe link that ran out still counts as run out when this round goes
  // by DocuSign. The hold below proves nothing changed since.
  if (!pendingOverride) {
    if (contract.status !== "pending_approval") throw new Error("This contract isn't waiting on review anymore");
  } else if (!canSendDocument(contract, contract.deal.kind)) {
    throw alreadyOutError(contract.status, isProposal ? "proposal" : "contract");
  }
  assertNoBlanks(contract.template.clauses, contract.deal.fields, contract.deal.kind);

  const to = pendingOverride?.to ?? contract.pendingTo;
  const subject = pendingOverride?.subject ?? contract.pendingSubject;
  const message = pendingOverride?.message ?? contract.pendingMessage;
  if (!to || !subject || !message) throw new Error("Missing email content to send");

  const { deal } = contract;
  const { workspace } = deal;
  const signLink = clientDocumentUrl(contract.id, deal.kind);
  // What goes out now is what the client sees and signs from here on, however
  // the deal's terms or the template change later.
  const snapshot = buildContractSnapshot(contract.template, deal);
  // This round as the rep set it up on the Send page, else as stored.
  const deliveryMethod = isProposal ? "sealme" : (setup?.deliveryMethod ?? contract.deliveryMethod);
  const countersigners = setup?.countersigners ?? contract.signers;
  const cc = setup?.ccEmails ? (setup.ccEmails.length > 0 ? setup.ccEmails : undefined) : storedCopies(contract.ccEmails);

  // A contract goes out once per round, however many clicks, tabs or
  // approvers get here at the same moment. A proposal can go out again
  // anyway, so it's never held.
  const holdUntil = isProposal ? null : await holdForSending(contract);
  let docusignEnvelopeId: string | undefined;
  try {
    // The envelope from before was dealt with when this round started
    // (retireBeforeSend), which let go of it. One still on the contract is
    // from a review started before that check existed: dealt with now.
    if (!isProposal && contract.docusignEnvelopeId) await retireBeforeSend(contract, deal, deliveryMethod);
    if (deliveryMethod === "docusign") {
      const anchorFor = (i: number) => `[[sig${i}]]`;
      const signers: EnvelopeSigner[] = [
        { name: deal.client.name, email: to, routingOrder: 1, anchor: anchorFor(1) },
        ...countersigners.map((s, i) => ({ name: s.name, email: s.email, routingOrder: i + 2, anchor: anchorFor(i + 2) })),
      ];
      const pdfBuffer = await renderToBuffer(
        <ContractPdfDocument
          templateName={snapshot.templateName}
          agencyName={snapshot.agencyName}
          agencyLogo={workspace.logoImage}
          clientName={snapshot.clientName}
          clauses={snapshot.clauses}
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

      if (isProposal) {
        // Just the proposal: the portal is where the client's agreements are.
        await sendContractEmail({ to, cc, subject, message, signLink, workspaceName: workspace.name, replyTo, verifiedSenderEmail, actionLabel: "View the proposal" });
      } else {
        const portalToken = await getOrMintPortalToken(deal.client.id);
        const portalUrl = `${appUrl()}/portal/${portalToken}`;
        await sendContractEmail({ to, cc, subject, message, signLink, workspaceName: workspace.name, replyTo, verifiedSenderEmail, portalUrl });
      }
    }
  } catch (err) {
    // Nothing went out and nothing of this send's setup was stored.
    if (holdUntil) await releaseHold(contract.id, holdUntil, contract.reminderSentAt);
    throw err;
  }

  // A proposal isn't announced: webhooks, Slack and the CRM hear about
  // contracts (the same rule as src/lib/transcript-deal.ts).
  if (isProposal) {
    await markProposalSent({ id: contract.id, template: contract.template, deal }, new Date(), { ccEmails: setupFields(setup).ccEmails });
    return;
  }

  const sentAt = new Date();
  const expiresAt = workspace.signingExpiryDays ? new Date(sentAt.getTime() + workspace.signingExpiryDays * 24 * 60 * 60 * 1000) : null;

  // Every send starts a fresh signing round: a signature or a decline on an
  // earlier version doesn't carry over, so the client and every counter-signer
  // sign this one (counter-signers with a new link once it's their turn), and
  // the "still unsigned" nudge goes out again for the new link. The setup
  // this round went out with is stored in the same write: a new signer list
  // replaces the old one, else whoever signed, declined or was told it was
  // their turn starts over.
  const signerWrites: Prisma.PrismaPromise<unknown>[] = setup?.countersigners
    ? replaceSigners(contractId, setup.countersigners)
    : contract.signers
        .filter((s) => s.status !== "pending" || s.notifiedAt)
        .map((signer) =>
          prisma.contractSigner.update({
            where: { id: signer.id },
            data: { status: "pending", token: randomBytes(24).toString("hex"), signatureImage: null, signerIp: null, signedAt: null, declinedReason: null, notifiedAt: null },
          })
        );
  await prisma.$transaction([
    prisma.contract.update({
      where: { id: contractId },
      data: {
        ...setupFields(setup),
        status: "sent",
        sentAt,
        expiresAt,
        snapshot,
        reminderSentAt: null,
        // This round's envelope, or none: an earlier one never stays on the
        // contract next to a new round's terms.
        docusignEnvelopeId: docusignEnvelopeId ?? null,
        pendingTo: null,
        pendingSubject: null,
        pendingMessage: null,
        signedAt: null,
        signerName: null,
        signerIp: null,
        signatureImage: null,
        viewedAt: null,
      },
    }),
    ...signerWrites,
  ]);
  await prisma.deal.update({ where: { id: deal.id }, data: { status: "sent" } });
  await refreshLeadPipeline(deal.leadId, { sentNow: true });
  // Resending is how the workspace answers open clause-change requests —
  // whatever they asked for is presumably reflected in this new version.
  await prisma.clauseComment.updateMany({ where: { contractId, resolved: false }, data: { resolved: true } });

  await dispatchWebhookEvent(workspace.id, "contract.sent", {
    dealId: deal.id,
    contractId: contract.id,
    clientName: deal.client.name,
    signLink: deliveryMethod === "docusign" ? undefined : signLink,
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
