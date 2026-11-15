"use client";

import { useState } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import Link from "next/link";
import ContractPreview from "./ContractPreview";
import NothingHeardYet from "./NothingHeardYet";
import MicSilentWarning from "./MicSilentWarning";
import DealTermsCard from "./DealTermsCard";
import ContinueCallButton from "./ContinueCallButton";
import ActionItemsCard from "./ActionItemsCard";
import CallHighlightsOverlay from "./CallHighlightsOverlay";
import SendToDocusignButton from "./SendToDocusignButton";
import VoiceCorrectionButton from "./VoiceCorrectionButton";
import DealNotes from "./DealNotes";
import ClientText from "./ClientText";
import ReviewPanel from "./ReviewPanel";
import ProposalActions from "./ProposalActions";
import MarkNotSignedButton from "./MarkNotSignedButton";
import RestoreFromTrashButton from "./RestoreFromTrashButton";
import { documentLocksTerms } from "@/lib/contract-status";
import { canMarkNotSigned, dealStatusChip, dealStatusLabel } from "@/lib/deal-status";

const POLL_INTERVAL_MS = 4000;

type FieldChange = { oldValue: string | null; newValue: string | null; changedBy: string; changedAt: Date };
type FieldItem = { id: string; fieldKey: string; groupLabel: string; label: string; value: string | null; status: string; sourceQuote: string | null; history: FieldChange[] };
type CallItem = { id: string; source: string; startedAt: Date; endedAt: Date | null; transcript: string };
type ActionItemT = { id: string; description: string; ownerType: string; dueDate: Date | null; status: string; sourceQuote: string | null };
type CallHighlightItem = { id: string; type: string; body: string; sourceQuote: string | null };
// secondary sits under the main button, for a less common way out.
type NextStep = { title: string; detail: string; action?: React.ReactNode; secondary?: React.ReactNode };
// Who put the contract in changes_requested, from the audit trail.
export type ChangesRequestedBy = { by: "reviewer" | "client" | "signer"; name: string | null };

type LiveDealState = {
  status: string;
  summary: string | null;
  fields: FieldItem[];
  calls: CallItem[];
  actionItems: ActionItemT[];
  callHighlights: CallHighlightItem[];
};

type ReviewStepItem = {
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
type TeammateOption = { id: string; name: string };
type NoteItem = { id: string; authorName: string; authorEmail: string; body: string; createdAt: string };

const CALL_SOURCE_LABEL: Record<string, string> = {
  local: "Recorded locally",
  upload: "Pasted transcript",
  recording: "Uploaded recording",
  phone: "Phone call",
  api: "Sent through the API",
};

function callPreview(transcript: string): string {
  const clean = transcript.trim().replace(/\s+/g, " ");
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean || "No transcript captured.";
}

// A local recording's transcript is two channels merged into "Speaker: ..."
// lines (system audio = "Client", mic = "You" — see deepgram.ts). Neither
// the native capture nor the transcription pipeline has any amplitude/
// silence check, so if the system-audio channel goes dead for the whole
// call (a known real-world failure mode with some headset/output setups),
// nothing errors anywhere — it looks exactly like a call where the client
// just didn't say anything. This is the one place that distinction becomes
// visible to the person who recorded it.
function channelHasWords(transcript: string, label: string): boolean {
  return transcript
    .split("\n")
    .some((line) => line.startsWith(`${label}:`) && line.slice(label.length + 1).trim().length > 0);
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// A call still being recorded (local capture or a live Recall bot) writes
// new extracted terms/summary/action items to the DB every ~minute in the
// background — see src/app/api/local-capture/transcribe/route.ts. Server
// components only render once per navigation, so without this, the page a
// rep is actually watching mid-call would just sit there showing the state
// from whenever it first loaded, no matter how much the AI has extracted
// since — the rep would have to leave and re-enter to see anything new.
// This polls a lean snapshot of just the live-relevant fields (same
// pattern as ReviewPanel's review-state polling) and stops once the call
// is over and the deal has left "processing".
export default function LiveDealView({
  dealId,
  leadId,
  clientName,
  service,
  callLength,
  contractViewedAt,
  templateName,
  templateClauses,
  hasContract,
  initialStatus,
  initialSummary,
  initialFields,
  initialCalls,
  initialActionItems,
  initialCallHighlights,
  getLiveDealStateAction,
  updateFieldsAction,
  retryExtractionAction,
  fillMissingFieldsAction,
  generateContractAction,
  toggleActionItemAction,
  notes,
  currentUserEmail,
  currentUserName,
  addNoteAction,
  deleteNoteAction,
  applyVoiceFieldCorrectionAction,
  sendForReviewToAction,
  docusignEnabled,
  contractStatus: initialContractStatus,
  contractSentAt = null,
  trashed = false,
  contractExpired: initialContractExpired,
  docusignVoid,
  changesRequestedBy,
  clientHasEmail,
  sendViaDocusignNowAction,
  reviewPanel,
  kind = "contract",
  contractId = null,
  derivedContractId = null,
  contractTemplates = [],
  sourceDealId = null,
  changedSinceSent = false,
  today,
}: {
  dealId: string;
  // The lead the deal is on, for the way back; null when the viewer can't open it.
  leadId: string | null;
  clientName: string;
  service: string;
  callLength: string | null;
  contractViewedAt: Date | null;
  templateName: string | null;
  // The template's clauses (JSON), for the contract preview before there's a contract.
  templateClauses: string | null;
  hasContract: boolean;
  initialStatus: string;
  initialSummary: string | null;
  initialFields: FieldItem[];
  initialCalls: CallItem[];
  initialActionItems: ActionItemT[];
  initialCallHighlights: CallHighlightItem[];
  getLiveDealStateAction: (dealId: string) => Promise<LiveDealState | null>;
  updateFieldsAction: (formData: FormData) => void;
  retryExtractionAction: () => void;
  fillMissingFieldsAction: (formData: FormData) => void;
  generateContractAction: () => void;
  toggleActionItemAction: (dealId: string, itemId: string) => Promise<{ error?: string }>;
  notes: NoteItem[];
  currentUserEmail: string;
  currentUserName: string;
  addNoteAction: (dealId: string, body: string) => Promise<{ error?: string }>;
  deleteNoteAction: (dealId: string, noteId: string) => Promise<{ error?: string }>;
  applyVoiceFieldCorrectionAction: (dealId: string, fieldKey: string, newValue: string) => Promise<{ error?: string }>;
  sendForReviewToAction: (dealId: string, assigneeId: string) => Promise<{ error?: string }>;
  docusignEnabled: boolean;
  contractStatus: string | null;
  // When the contract went to the client, if it did: changes asked for
  // after that can still be marked not signed (canMarkNotSigned).
  contractSentAt?: Date | null;
  // In the trash: nothing goes out from it until it's restored.
  trashed?: boolean;
  // The SealMe sign link ran out (contractExpired in contract-status.ts),
  // worked out on the server, which knows expiresAt.
  contractExpired: boolean;
  // Set when a DocuSign envelope was voided rather than anyone asking for
  // changes; reason is DocuSign's, when it gave one.
  docusignVoid?: { reason: string | null };
  // Who asked for the changes, when the contract is in changes_requested
  // and the audit trail says (a reviewer, the client, or a signer who
  // declined, with their name).
  changesRequestedBy?: ChangesRequestedBy;
  clientHasEmail: boolean;
  sendViaDocusignNowAction: (dealId: string) => Promise<{ error?: string; heldForReviewBy?: string }>;
  reviewPanel: {
    initialContractStatus: string;
    initialContractCreatedAt: Date;
    initialContractSentAt: Date | null;
    initialContractSignedAt: Date | null;
    initialSteps: ReviewStepItem[];
    teammates: TeammateOption[];
    currentUserId: string;
    delegatedAssigneeIds: string[];
    currentUserCanManageWorkspace: boolean;
    getReviewStateAction: (dealId: string) => Promise<{
      contractStatus: string;
      dealStatus: string;
      contractCreatedAt: Date;
      contractSentAt: Date | null;
      contractSignedAt: Date | null;
      steps: ReviewStepItem[];
    } | null>;
    decideAction: (dealId: string, reviewStepId: string, decision: "approve" | "reject", formData: FormData) => Promise<{ error?: string }>;
    addChecklistItemAction: (dealId: string, reviewStepId: string, formData: FormData) => Promise<{ error?: string }>;
    toggleChecklistItemAction: (dealId: string, itemId: string, done: boolean) => Promise<{ error?: string }>;
    removeChecklistItemAction: (dealId: string, itemId: string) => Promise<{ error?: string }>;
    addCommentAction: (dealId: string, reviewStepId: string, body: string) => Promise<{ error?: string }>;
    deleteCommentAction: (dealId: string, commentId: string) => Promise<{ error?: string }>;
    updateStepMetaAction: (dealId: string, reviewStepId: string, formData: FormData) => Promise<{ error?: string }>;
  } | null;
  // "proposal" or "contract" (anything else counts as a contract). A
  // proposal is only sent and read: no signing, DocuSign or review.
  kind?: string;
  // The Contract row, which holds the document (a proposal's too).
  contractId?: string | null;
  // A proposal's contract, once one was made from it.
  derivedContractId?: string | null;
  // The workspace's contract templates, for making a proposal's contract.
  contractTemplates?: { id: string; name: string }[];
  // The proposal a contract was made from.
  sourceDealId?: string | null;
  // A sent proposal whose terms changed after it went out.
  changedSinceSent?: boolean;
  // The viewer's current day (YYYY-MM-DD), for overdue action items.
  today: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [summary, setSummary] = useState(initialSummary);
  const [fields, setFields] = useState(initialFields);
  const [calls, setCalls] = useState(initialCalls);
  const [actionItems, setActionItems] = useState(initialActionItems);
  const [callHighlights, setCallHighlights] = useState(initialCallHighlights);
  const [contractStatus, setContractStatus] = useState(initialContractStatus);
  const [contractExpired, setContractExpired] = useState(initialContractExpired);
  const [live, setLive] = useState(() => isLive(initialStatus, initialCalls));
  const [docusignNowStarted, setDocusignNowStarted] = useState(false);

  // Next keeps this component mounted when a server action redirects back
  // to this same page (Save & continue, Save changes), so the fresh props it
  // renders with would never reach the state above on their own. Every
  // server render sends new arrays, which is how fresh props are told apart.
  // serverRender also closes the Deal terms editor once a save comes back.
  const [propsFields, setPropsFields] = useState(initialFields);
  const [serverRender, setServerRender] = useState(0);
  if (initialFields !== propsFields) {
    setPropsFields(initialFields);
    setServerRender(serverRender + 1);
    setStatus(initialStatus);
    setSummary(initialSummary);
    setFields(initialFields);
    setCalls(initialCalls);
    setActionItems(initialActionItems);
    setCallHighlights(initialCallHighlights);
    setContractStatus(initialContractStatus);
    setContractExpired(initialContractExpired);
    setLive(isLive(initialStatus, initialCalls));
  }

  // ReviewPanel polls its own review state independently (contractStatus/
  // dealStatus), but the call-progress poll above only runs while a call is
  // actually live — once it's over (the normal case for reviewing/sending a
  // contract), it never fires again, so this page's own `status` (the top
  // badge, the generate/send-to-docusign gating) would otherwise stay frozen
  // at whatever it was on page load even as the review moves through its
  // whole lifecycle. ReviewPanel calls this on every one of its own polls so
  // this page's status tracks the review's without needing a second timer.
  function handleReviewSync(nextContractStatus: string, dealStatus: string) {
    setStatus(dealStatus);
    // A new contract status means it moved on (the cron marked the link
    // expired, or it went out again), so that status alone settles it.
    if (nextContractStatus !== contractStatus) setContractExpired(nextContractStatus === "expired");
    setContractStatus(nextContractStatus);
  }

  function isLive(s: string, callList: CallItem[]): boolean {
    if (s === "processing") return true;
    const last = callList[callList.length - 1];
    if (!last) return false;
    if (!last.endedAt) return true;
    // Action items and highlights are extracted in the background right
    // after a call ends, so keep polling briefly until they land.
    return Date.now() - new Date(last.endedAt).getTime() < 2 * 60 * 1000;
  }

  useVisibleInterval(
    async () => {
      const data = await getLiveDealStateAction(dealId);
      if (!data) return;
      setStatus(data.status);
      setSummary(data.summary);
      setFields(data.fields);
      setCalls(data.calls);
      setActionItems(data.actionItems);
      setCallHighlights(data.callHighlights);
      setLive(isLive(data.status, data.calls));
    },
    POLL_INTERVAL_MS,
    live
  );

  const groups = new Map<string, FieldItem[]>();
  for (const field of fields) {
    if (!groups.has(field.groupLabel)) groups.set(field.groupLabel, []);
    groups.get(field.groupLabel)!.push(field);
  }
  const missing = fields.filter((f) => f.status === "missing");
  const isProposal = kind === "proposal";
  const canSendToDocusignNow = !trashed && !isProposal && docusignEnabled && status === "ready" && contractStatus === "draft" && clientHasEmail;
  // The same rule the server actions enforce: the terms are what a reviewer
  // or the client is looking at, so they can't be edited, unless the sign
  // link expired or the rep marked it not signed (a status that never locks)
  // and the contract has to go out again anyway.
  const termsLocked = !contractExpired && documentLocksTerms(contractStatus, kind);
  const firstName = clientName.split(/\s+/)[0] || clientName;
  // Wherever the contract screen offers it too: still out, past its link,
  // or changes asked for after it went out. Not from the trash, which the
  // server refuses.
  const markNotSigned = !trashed && canMarkNotSigned(contractStatus ? { status: contractStatus, sentAt: contractSentAt } : null, kind)
    ? <MarkNotSignedButton dealId={dealId} clientName={clientName} inverted />
    : undefined;
  // Every send refuses the trash, so the next step is getting it back out.
  const trashedNextStep: NextStep = {
    title: "In the trash",
    detail: `Nothing goes to ${firstName} from the trash. Restore it to carry on.`,
    action: <RestoreFromTrashButton dealId={dealId} inverted />,
  };

  // A proposal goes Draft, Sent, Viewed, then on to its contract. It's never
  // signed, reviewed or expired, so none of the contract's steps apply.
  function proposalNextStep(): NextStep {
    if (status === "processing") return { title: "SealMe is reading the call", detail: "The terms fill in by themselves in a moment." };
    if (status === "extraction_failed") return { title: "Reading the call failed", detail: "Try again; nothing is lost.", action: <form action={retryExtractionAction}><NextButton>Try again</NextButton></form> };
    if (missing.length > 0) {
      return {
        title: missing.length === 1 ? `Fill in ${missing[0].label.toLowerCase()}` : `Fill in ${missing.length} details`,
        detail: "The call didn't cover them. Then the proposal is ready to send.",
        action: <a href="#missing" className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Fill them in</a>,
      };
    }
    if (!hasContract) return { title: "Make the proposal", detail: `Everything's in. SealMe drafts it on the ${templateName ?? "default"} template.`, action: <form action={generateContractAction}><NextButton>Make the proposal</NextButton></form> };
    if (derivedContractId) return { title: "Contract made", detail: "Carry on from the contract.", action: <Link href={`/deals/${derivedContractId}`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Open contract</Link> };
    if (contractStatus === "sent") {
      return contractViewedAt
        ? { title: `${firstName} opened it ${timeAgo(contractViewedAt)}`, detail: "Make the contract when they're ready to go ahead." }
        : { title: `Sent to ${firstName}`, detail: "They haven't opened it yet." };
    }
    return { title: "Check the proposal and send it", detail: "Send it by email or copy the link. Nothing goes out until you do.", action: <Link href={`/deals/${dealId}/contract`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Review and send</Link> };
  }

  // Not from contractSentAt: it stays set from an earlier round when a new
  // one goes to review, so a reviewer's or counter-signer's no would read as
  // the client's.
  function changesRequestedStep(): NextStep {
    const action = <Link href={`/deals/${dealId}/contract`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Open the contract</Link>;
    if (changesRequestedBy?.by === "signer") {
      return { title: "Declined to sign", detail: `${changesRequestedBy.name ?? "A signer"} declined to sign. Make any changes, then send it again.`, action };
    }
    const detail =
      changesRequestedBy?.by === "client"
        ? `${firstName} asked for changes. Make them, then send it again.`
        : changesRequestedBy?.by === "reviewer"
          ? "A reviewer asked for changes before it goes out."
          : "Changes were asked for. Make them, then send it again.";
    return { title: "Make the requested changes", detail, action };
  }

  // The one thing this deal needs next, said at the top so nobody has to
  // hunt for the button.
  const stepNow: NextStep = trashed
    ? trashedNextStep
    : isProposal
    ? proposalNextStep()
    : status === "processing"
      ? { title: "SealMe is reading the call", detail: "The terms fill in by themselves in a moment." }
      : status === "extraction_failed"
        ? { title: "Reading the call failed", detail: "Try again; nothing is lost.", action: <form action={retryExtractionAction}><NextButton>Try again</NextButton></form> }
        : missing.length > 0
          ? {
              title: missing.length === 1 ? `Fill in ${missing[0].label.toLowerCase()}` : `Fill in ${missing.length} details`,
              detail: "The call didn't cover them. Then the contract is ready to send.",
              action: <a href="#missing" className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Fill them in</a>,
            }
          : !hasContract
            ? { title: "Make the contract", detail: `Everything's in. SealMe drafts it on the ${templateName ?? "default"} template.`, action: <form action={generateContractAction}><NextButton>Make the contract</NextButton></form> }
            // Checked on the contract: marking it leaves the deal at "sent".
            : contractStatus === "not_signed"
              ? { title: "Not signed", detail: `${firstName} didn't sign it. Send it again whenever they're ready.`, action: <Link href={`/deals/${dealId}/send`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Send again</Link> }
            : status === "pending_approval"
              ? { title: "Waiting for approval", detail: "It goes to the client as soon as it's approved.", action: <Link href={`/deals/${dealId}/contract`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Open the contract</Link> }
              : status === "changes_requested"
                ? docusignVoid
                  ? { title: "Voided in DocuSign", detail: `${docusignVoid.reason ? `${docusignVoid.reason}. ` : ""}Make any changes, then send it again.`, action: <Link href={`/deals/${dealId}/contract`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Open the contract</Link> }
                  : changesRequestedStep()
                : status === "sent" && contractExpired
                  ? { title: "Sign link expired", detail: `${firstName} can't sign it anymore. Send it again for a new link.`, action: <Link href={`/deals/${dealId}/send`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Send again</Link> }
                  : status === "sent"
                    ? { title: `Waiting for ${firstName} to sign`, detail: contractViewedAt ? `They opened it ${timeAgo(contractViewedAt)}.` : "They haven't opened it yet." }
                    : status === "signed"
                      ? { title: "Signed", detail: "Nothing left to do on this deal." }
                      : { title: "Check the contract and send it", detail: `${firstName} gets it to sign as soon as you send.`, action: <Link href={`/deals/${dealId}/contract`} className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>Review and send</Link> };
  // Mark as not signed rides along whatever the step says, wherever
  // canMarkNotSigned allows it (still out, past its link, changes asked for
  // after it went out, or a sent one still missing a detail), the same as
  // on the contract screen.
  const next: NextStep = markNotSigned && !stepNow.secondary ? { ...stepNow, secondary: markNotSigned } : stepNow;

  return (
    <>
      <Link href={leadId ? `/leads/${leadId}` : "/leads"} className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
        ← {leadId ? clientName : "Leads"}
      </Link>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[23px] font-medium" style={{ letterSpacing: "-0.6px" }}>{clientName}</h1>
          <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
            {service}
            {callLength ? ` · from a ${callLength}` : ""}
          </div>
          {!isProposal && sourceDealId && (
            <Link href={`/deals/${sourceDealId}`} className="mt-1 inline-block text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
              Made from a proposal →
            </Link>
          )}
        </div>
        <div className="flex flex-none flex-col items-end gap-1.5">
          <span className={`chip ${dealStatusChip(status, contractExpired, kind, contractStatus)}`}>
            <span className="chip-dot" />
            {dealStatusLabel(status, contractExpired, kind, contractStatus)}
          </span>
          {contractViewedAt && (
            <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
              👁 Viewed <ClientText text={() => timeAgo(contractViewedAt)} />
            </span>
          )}
        </div>
      </div>

      <section className="mb-[18px] flex flex-col gap-3 rounded-[20px] p-5 sm:flex-row sm:items-center sm:justify-between" style={{ background: "var(--surface-inverted)", color: "var(--on-surface-inverted)" }}>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-semibold" style={{ letterSpacing: "1px", color: "var(--on-surface-inverted-muted)" }}>NEXT STEP</span>
          {/* The title and detail can say "opened it 5m ago", and the clock moves
              between the server render and the browser's, so the browser's text wins. */}
          <h2 className="break-words text-[19px] font-semibold" style={{ letterSpacing: "-0.3px" }} suppressHydrationWarning>{next.title}</h2>
          <div className="text-[13px]" style={{ color: "var(--on-surface-inverted-muted)" }} suppressHydrationWarning>{next.detail}</div>
        </div>
        {(next.action || next.secondary) && (
          <div className="flex w-full flex-none flex-col gap-2 sm:w-[220px]">
            {next.action}
            {next.secondary}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1fr_300px]">
        <div className="flex flex-col gap-[18px]">
          {summary && (
            <div className="card p-5">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
                  Call summary
                </h2>
                {callHighlights.length > 0 && <CallHighlightsOverlay items={callHighlights} />}
              </div>
              <p className="text-[13.5px] leading-relaxed">{summary}</p>
            </div>
          )}
          <DealTermsCard
            key={serverRender}
            groups={[...groups.entries()].filter(([label]) => label !== "Missing")}
            updateAction={updateFieldsAction}
            listening={status === "processing"}
            locked={termsLocked}
          />

          {!hasContract && templateClauses && fields.length > 0 && (
            <ContractPreview templateName={templateName} clausesJson={templateClauses} fields={fields} live={status === "processing"} kind={kind} />
          )}

          {calls.length > 0 && (
            <div className="card p-5">
              <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
                Negotiation timeline
              </h2>
              <div className="flex flex-col gap-3">
                {calls.map((call, i) => (
                  <div key={call.id} className="border-b pb-3 last:border-b-0 last:pb-0" style={{ borderColor: "var(--hairline-soft)" }}>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[13px] font-medium">Call {i + 1} - {CALL_SOURCE_LABEL[call.source] ?? call.source}</span>
                      <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
                        <ClientText text={() => new Date(call.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
                        {!call.endedAt && call.id === calls[calls.length - 1].id ? " · in progress" : ""}
                      </span>
                    </div>
                    <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                      {callPreview(call.transcript)}
                    </p>
                    {call.source === "local" && !call.endedAt && !call.transcript.trim() && <NothingHeardYet startedAt={call.startedAt} />}
                    {call.source === "local" && channelHasWords(call.transcript, "Client") && !channelHasWords(call.transcript, "You") && (
                      <MicSilentWarning startedAt={call.startedAt} endedAt={call.endedAt} />
                    )}
                    {call.source === "local" && call.endedAt && channelHasWords(call.transcript, "You") && !channelHasWords(call.transcript, "Client") && (
                      <div className="mt-2 rounded-[8px] px-3 py-2 text-[12px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
                        We didn&apos;t pick up anything from the other side of this call. Only your own mic came through. If you were on headphones or an external mic, try switching back to your Mac&apos;s built-in speakers and microphone and recording again.
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <ActionItemsCard dealId={dealId} items={actionItems} today={today} toggleAction={toggleActionItemAction} />

          <DealNotes
            dealId={dealId}
            notes={notes}
            currentUserEmail={currentUserEmail}
            currentUserName={currentUserName}
            addAction={addNoteAction}
            deleteAction={deleteNoteAction}
          />
        </div>

        <div className="flex flex-col gap-4">
          {status !== "signed" && <ContinueCallButton dealId={dealId} />}

          {/* Its changes would be refused while the terms are locked. */}
          {!termsLocked && fields.some((f) => f.status !== "missing") && (
            <VoiceCorrectionButton dealId={dealId} applyAction={applyVoiceFieldCorrectionAction} reviewAction={isProposal ? refuseProposalReview : sendForReviewToAction} />
          )}

          {reviewPanel && !isProposal && (
            <ReviewPanel
              dealId={dealId}
              clientName={clientName}
              initialContractStatus={reviewPanel.initialContractStatus}
              initialDealStatus={status}
              initialContractCreatedAt={reviewPanel.initialContractCreatedAt}
              initialContractSentAt={reviewPanel.initialContractSentAt}
              initialContractSignedAt={reviewPanel.initialContractSignedAt}
              initialSteps={reviewPanel.initialSteps}
              teammates={reviewPanel.teammates}
              currentUserId={reviewPanel.currentUserId}
              currentUserEmail={currentUserEmail}
              currentUserName={currentUserName}
              delegatedAssigneeIds={reviewPanel.delegatedAssigneeIds}
              currentUserCanManageWorkspace={reviewPanel.currentUserCanManageWorkspace}
              getReviewStateAction={reviewPanel.getReviewStateAction}
              sendToAction={sendForReviewToAction}
              decideAction={reviewPanel.decideAction}
              addChecklistItemAction={reviewPanel.addChecklistItemAction}
              toggleChecklistItemAction={reviewPanel.toggleChecklistItemAction}
              removeChecklistItemAction={reviewPanel.removeChecklistItemAction}
              addCommentAction={reviewPanel.addCommentAction}
              deleteCommentAction={reviewPanel.deleteCommentAction}
              updateStepMetaAction={reviewPanel.updateStepMetaAction}
              onSync={handleReviewSync}
            />
          )}

          {status === "processing" ? (
            <div className="card flex items-center gap-2.5 px-5 py-4 text-[13.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
              <span className="chip-dot h-1.5 w-1.5 rounded-full" style={{ background: "var(--ink-muted)" }} />
              Analyzing the call. Terms appear here live as they&apos;re mentioned.
            </div>
          ) : status === "extraction_failed" ? (
            <div className="card" style={{ borderColor: "rgba(245,185,77,.28)" }}>
              <div className="rounded-t-[20px] border-b px-5 py-4" style={{ background: "var(--warn-soft)", borderColor: "rgba(245,185,77,.2)" }}>
                <h2 className="text-[15px] font-medium" style={{ color: "var(--warn)" }}>Couldn&apos;t process this call</h2>
              </div>
              <div className="px-5 py-4">
                <p className="mb-3 text-[13px]" style={{ color: "var(--ink-muted)" }}>
                  Something went wrong while extracting deal terms. Check your AI extraction setup (e.g. Anthropic billing) and try again.
                </p>
                <form action={retryExtractionAction}>
                  <button type="submit" className="btn btn-primary w-full justify-center">
                    Try again
                  </button>
                </form>
              </div>
            </div>
          ) : missing.length > 0 ? (
            <div id="missing" className="card scroll-mt-24" style={{ borderColor: "rgba(245,185,77,.28)" }}>
              <div className="rounded-t-[20px] border-b px-5 py-4" style={{ background: "var(--warn-soft)", borderColor: "rgba(245,185,77,.2)" }}>
                <h2 className="text-[15px] font-medium" style={{ color: "var(--warn)" }}>Missing information</h2>
              </div>
              <form action={fillMissingFieldsAction} className="px-5 py-3">
                {missing.map((m) => (
                  <div key={m.id} className="border-b py-3 last:border-b-0" style={{ borderColor: "var(--hairline-soft)" }}>
                    <label className="text-[13px] font-medium" htmlFor={m.id}>{m.label}</label>
                    <div className="mb-2 mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>Not mentioned in the call. Add it below.</div>
                    <input id={m.id} name={m.id} required placeholder={`Add ${m.label.toLowerCase()}…`} className="input w-full" style={{ fontSize: "13px", padding: "8px 11px" }} />
                  </div>
                ))}
                <button type="submit" className="btn btn-primary mt-3 w-full justify-center">
                  Save &amp; continue
                </button>
              </form>
            </div>
          ) : (
            <div className="card flex items-center gap-2 px-5 py-4 text-[13.5px] font-medium" style={{ color: "var(--success)" }}>
              ✓ All required information captured
            </div>
          )}

          {trashed ? (
            <div className="card flex flex-col gap-2.5 p-5">
              <div className="rounded-[10px] px-3 py-2.5 text-[12.5px]" style={{ border: "1px solid var(--hairline)", background: "var(--canvas)", color: "var(--ink-muted)" }}>
                In the trash. Restore it to send it.
              </div>
              {hasContract && (
                <Link href={`/deals/${dealId}/contract`} className="btn btn-secondary w-full justify-center">
                  {isProposal ? "View proposal" : "View contract"}
                </Link>
              )}
            </div>
          ) : isProposal ? (
            <ProposalActions
              dealId={dealId}
              contractId={contractId}
              contractStatus={contractStatus}
              ready={hasContract && Boolean(contractId) && missing.length === 0 && status !== "processing" && status !== "extraction_failed"}
              notReadyHint={
                status === "processing" || status === "extraction_failed"
                  ? "Ready once SealMe has read the call."
                  : missing.length > 0
                    ? "Fill in the missing details first."
                    : "Make the proposal first."
              }
              viewedAt={contractViewedAt ? new Date(contractViewedAt).toISOString() : null}
              derivedContractId={derivedContractId}
              contractTemplates={contractTemplates}
              changedSinceSent={changedSinceSent}
              createDisabled={status === "processing"}
            />
          ) : (
          <div className="card flex flex-col gap-2.5 p-5">
            {hasContract ? (
              <Link href={`/deals/${dealId}/contract`} className="btn btn-primary w-full justify-center">
                View contract
              </Link>
            ) : (
              <form action={generateContractAction}>
                <button type="submit" disabled={missing.length > 0 || status === "processing" || status === "extraction_failed"} className="btn btn-primary w-full justify-center">
                  Generate contract
                </button>
              </form>
            )}
            <span className="text-center text-[12px]" style={{ color: "var(--ink-muted)" }}>
              Uses the {templateName ?? "default"} template
            </span>
          </div>
          )}

          {(canSendToDocusignNow || docusignNowStarted) && (
            <SendToDocusignButton dealId={dealId} sendAction={sendViaDocusignNowAction} onStart={() => setDocusignNowStarted(true)} />
          )}
        </div>
      </div>
    </>
  );
}

// A proposal never goes through review, so the voice "send it to X for
// review" ask is turned down instead of starting a chain.
async function refuseProposalReview(): Promise<{ error?: string }> {
  return { error: "A proposal doesn't go through review. Send it by email or copy the link." };
}

const NEXT_BUTTON_STYLE: React.CSSProperties = { height: 46, fontSize: 15, background: "var(--on-surface-inverted)", color: "var(--surface-inverted)" };

function NextButton({ children }: { children: React.ReactNode }) {
  return (
    <button type="submit" className="btn w-full justify-center" style={NEXT_BUTTON_STYLE}>
      {children}
    </button>
  );
}
