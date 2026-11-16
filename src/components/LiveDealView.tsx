"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { documentLocksTerms } from "@/lib/contract-status";
import { canMarkNotSigned, dealStatusChip, dealStatusLabel } from "@/lib/deal-status";
import { contractParty, contractTerms, type Clause, type ContractTerm } from "@/lib/contract";
import { fieldMeta, fieldQuestion } from "@/lib/field-meta";
import { parseTranscript } from "@/lib/transcript-lines";
import { callInProgress, callIsRecent, dealIsLive, dealTranscript, justHeard } from "@/lib/deal-live-state";
import { discardCapture, showCaptureOnPage, stopCapture, useCaptureSession } from "@/lib/live-capture-client";
import { useInDesktopApp } from "@/lib/native-shell";
import { filenameFromDisposition } from "@/lib/download-filename";
import { clientDocumentUrl } from "@/lib/document-links";
import { restoreDeal } from "@/app/(app)/deals/bulk-actions";
import type { LiveDealState, LiveField, LiveTemplate } from "@/app/(app)/deals/[id]/actions";
import NothingHeardYet from "./NothingHeardYet";
import MicSilentWarning from "./MicSilentWarning";
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
import AuditTrailButton from "./AuditTrailButton";
import ContractPaper, { revealField, type PaperComment, type PaperSignature, type PlainClause } from "./contract/ContractPaper";
import TermsCard from "./contract/TermsCard";
import NextCard, { CardButton, WaitingDots } from "./contract/NextCard";
import TranscriptCard from "./contract/TranscriptCard";
import CallPill from "./contract/CallPill";
import ActionBar, { ActionBarSpacer, BarButton } from "./contract/ActionBar";
import MissingDialog from "./contract/MissingDialog";
import PreviewModal from "./contract/PreviewModal";
import MoreSection from "./contract/MoreSection";
import CopyLinkButton from "./contract/CopyLinkButton";
import RenewalCard from "./contract/RenewalCard";
import { DownloadIcon, EyeIcon, RestoreIcon, SendIcon } from "./contract/icons";
import { nextToAsk, renewalCountdown, termsBadge, transcriptHighlights } from "./contract/paper-utils";
import { useAskedKeys } from "./contract/use-asked-keys";
import s from "./contract/contract.module.css";

const POLL_INTERVAL_MS = 4000;
// How long a term the call just filled in stays marked as just heard.
const HEARD_MS = 8000;

type CallItem = LiveDealState["calls"][number];
type ActionItemT = LiveDealState["actionItems"][number];
type CallHighlightItem = LiveDealState["callHighlights"][number];
type SetFieldResult = { error?: string; fields?: LiveField[]; status?: string };
// Who put the contract in changes_requested, from the audit trail.
export type ChangesRequestedBy = { by: "reviewer" | "client" | "signer"; name: string | null };
// A client's open change request from the sign page, on the clause it names.
export type ClientClauseComment = PaperComment & { createdAt: string };
// A signed contract's term: when it ends or renews.
export type ContractRenewal = { date: string; autoRenews: boolean; note: string | null };

// The call the deal was made on (Start a call), with who it's with: the
// lead's name (null while SealMe hasn't put one to it yet) and their title,
// else their company.
export type DealPhoneCall = {
  id: string;
  status: string;
  source: string;
  startedAt: string;
  endedAt: string | null;
  transcript: string;
  personName: string | null;
  personSub: string | null;
};

// The text exactly as it went out, for a sent contract whose terms or
// template changed since: drawn as plain text.
export type SentText = { templateName: string; agencyName: string; clientName: string; clauses: PlainClause[] };

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
type NextView = { eyebrow: ReactNode; title: ReactNode; text?: ReactNode; quote?: string | null; tone?: "default" | "done" | "warn" | "dark"; actions?: ReactNode };
type Toast = { id: number; text: string; tone: "ok" | "error" };

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
// lines (system audio = "Client", mic = "You", see deepgram.ts). Neither the
// native capture nor the transcription pipeline has any silence check, so if
// one channel goes dead for the whole call nothing errors anywhere: it looks
// exactly like a call where that side said nothing. This screen is the one
// place that becomes visible to the person who recorded it.
function channelHasWords(transcript: string, label: string): boolean {
  return transcript
    .split("\n")
    .some((line) => line.trim().startsWith(`${label}:`) && line.trim().slice(label.length + 1).trim().length > 0);
}

function timeAgo(date: Date | string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// "Fill in deliverables", but "Fill in SDR count".
function lowerLabel(label: string): string {
  return label
    .split(/\s+/)
    .map((w) => (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

function parseClauses(json: string | null | undefined): Clause[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Clause[]).filter((c) => c && typeof c.body === "string").map((c) => ({ ...c, title: typeof c.title === "string" ? c.title : "" })) : [];
  } catch {
    return [];
  }
}

// The rep's own values on top of what the server last said, while their
// saves are on the way: the screen shows a typed term at once.
function withPending(fields: LiveField[], pending: Record<string, string>): LiveField[] {
  const keys = Object.keys(pending);
  if (keys.length === 0) return fields;
  const out = fields.map((f) => {
    if (!Object.hasOwn(pending, f.fieldKey)) return f;
    const value = pending[f.fieldKey].trim();
    return { ...f, value: value || null, status: value ? (f.status === "missing" ? "confirmed" : "user_edited") : "missing" };
  });
  for (const key of keys) {
    const value = pending[key].trim();
    if (value && !fields.some((f) => f.fieldKey === key)) {
      out.push({ id: `pending:${key}`, fieldKey: key, groupLabel: "", label: fieldMeta(key).label, value, status: "confirmed", sourceQuote: null, history: [] });
    }
  }
  return out;
}

const subscribeNothing = () => () => {};
// False on the server and while hydrating, so dates in the viewer's own
// format only show once the page runs in the browser.
function useIsClient(): boolean {
  return useSyncExternalStore(subscribeNothing, () => true, () => false);
}

function isRedirect(err: unknown): boolean {
  return typeof err === "object" && err !== null && "digest" in err && String((err as { digest: unknown }).digest).startsWith("NEXT_REDIRECT");
}

// The contract screen: the document drawn as one sheet of paper, the terms
// it needs beside it, and the one thing to do next. The same screen serves
// a call that's still on (terms fill in as they're said, the transcript
// runs, the rep can type over anything) and a contract or proposal opened
// later. While the call is on (or SealMe is still reading it) the screen
// asks the server for what's new every few seconds; server components only
// render once per navigation.
export default function LiveDealView({
  dealId,
  leadId,
  clientName,
  clientNameKnown = true,
  client,
  agencyName,
  contractViewedAt,
  template: initialTemplate,
  plainText,
  signature,
  hasContract,
  initialStatus,
  initialSummary,
  initialFields,
  initialCalls,
  initialActionItems,
  initialCallHighlights,
  phoneCall: initialPhoneCall,
  getLiveDealStateAction,
  setFieldAction,
  generateAndSendAction,
  makeDraftAction,
  retryExtractionAction,
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
  contractSignedAt = null,
  contractSignerName = null,
  contractExpiresAt = null,
  contractDeliveryMethod = null,
  markedNotSignedAt = null,
  pendingSigners = [],
  clauseComments = [],
  renewal = null,
  startRenewalAction,
  canExportAuditTrail = false,
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
  // False while the client is a stand-in ("New client", a document made
  // during a cold call before anyone said who it's with): the screen then
  // says "the client" instead of a made-up first name.
  clientNameKnown?: boolean;
  // Who the document is with, for the parties line (contractParty).
  client: { name: string; company: string | null };
  agencyName: string;
  contractViewedAt: string | null;
  // The template the text comes from: the contract's once there is one.
  template: LiveTemplate | null;
  plainText: SentText | null;
  // The client's signature, shown under the terms they signed.
  signature: PaperSignature | null;
  hasContract: boolean;
  initialStatus: string;
  initialSummary: string | null;
  initialFields: LiveField[];
  initialCalls: CallItem[];
  initialActionItems: ActionItemT[];
  initialCallHighlights: CallHighlightItem[];
  phoneCall: DealPhoneCall | null;
  // transcriptKnown: how much of the call's transcript the page has;
  // templateKnown: the version of the template it has (its clauses stay
  // out of the answer while that still matches).
  getLiveDealStateAction: (dealId: string, transcriptKnown?: number, templateKnown?: string | null) => Promise<LiveDealState | null>;
  // One term typed in, saved without leaving the page.
  setFieldAction: (fieldKey: string, value: string) => Promise<SetFieldResult>;
  // Makes the draft when there's none yet and goes to the Send page.
  generateAndSendAction: () => Promise<{ error?: string }>;
  // Makes the draft without leaving the page (a proposal's Copy link and
  // Download PDF before it has a document).
  makeDraftAction: () => Promise<{ error?: string; contractId?: string }>;
  retryExtractionAction: () => void;
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
  contractSentAt?: string | null;
  contractSignedAt?: string | null;
  // Who signed it for the client, once they did.
  contractSignerName?: string | null;
  // When the SealMe sign link runs (or ran) out.
  contractExpiresAt?: string | null;
  // "sealme" (the client signs at /sign/{id}) or "docusign".
  contractDeliveryMethod?: string | null;
  // When the rep marked it not signed, from the audit log.
  markedNotSignedAt?: string | null;
  // Who still has to sign after the client (partially signed).
  pendingSigners?: { name: string; role: string }[];
  // What the client asked to change, shown under each clause.
  clauseComments?: ClientClauseComment[];
  // A signed contract's term, and the way to start its renewal.
  renewal?: ContractRenewal | null;
  startRenewalAction?: () => void | Promise<void>;
  // Workspace admins can export the audit trail (under More).
  canExportAuditTrail?: boolean;
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
  const router = useRouter();
  const isClient = useIsClient();
  const [status, setStatus] = useState(initialStatus);
  const [summary, setSummary] = useState(initialSummary);
  const [fields, setFields] = useState(initialFields);
  const [calls, setCalls] = useState(initialCalls);
  const [actionItems, setActionItems] = useState(initialActionItems);
  const [callHighlights, setCallHighlights] = useState(initialCallHighlights);
  const [contractStatus, setContractStatus] = useState(initialContractStatus);
  const [contractExpired, setContractExpired] = useState(initialContractExpired);
  const [viewedAt, setViewedAt] = useState(contractViewedAt);
  const [sentAt, setSentAt] = useState(contractSentAt);
  const [template, setTemplate] = useState(initialTemplate);
  const [call, setCall] = useState(initialPhoneCall);
  const [docusignNowStarted, setDocusignNowStarted] = useState(false);
  // Terms typed by the rep whose save hasn't come back yet.
  const [pending, setPending] = useState<Record<string, string>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [heard, setHeard] = useState<{ key: string; quote: string | null } | null>(null);
  const [missingOpen, setMissingOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  // A failed PDF download from inside the preview, shown there: the toast
  // would sit under the modal.
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  // The call this screen ended, shown as ended until the server says so.
  const [endedCall, setEndedCall] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // A term changed here after changes were asked for: the next step is
  // sending this version.
  const [updatedAfterRequest, setUpdatedAfterRequest] = useState(false);
  const [sending, startSending] = useTransition();
  const [restoring, startRestoring] = useTransition();
  const [asked, markAsked] = useAskedKeys(dealId);
  const session = useCaptureSession();
  const inDesktop = useInDesktopApp();

  // Next keeps this component mounted when the page renders again on the
  // server (a saved term revalidates it, router.refresh, a redirect back
  // here), so the fresh props would never reach the state above on their
  // own. Every server render sends new arrays, which is how fresh props are
  // told apart. What the rep is typing, and their saves on the way, stay.
  const [propsFields, setPropsFields] = useState(initialFields);
  if (initialFields !== propsFields) {
    setPropsFields(initialFields);
    setStatus(initialStatus);
    setSummary(initialSummary);
    setFields(initialFields);
    setCalls(initialCalls);
    setActionItems(initialActionItems);
    setCallHighlights(initialCallHighlights);
    setContractStatus(initialContractStatus);
    setContractExpired(initialContractExpired);
    setViewedAt(contractViewedAt);
    setSentAt(contractSentAt);
    setTemplate(initialTemplate);
    setCall(initialPhoneCall);
  }

  const isProposal = kind === "proposal";
  const doc = isProposal ? "proposal" : "contract";
  // The same rule the server actions enforce: the terms are what a reviewer
  // or the client is looking at, so they can't be edited, unless the sign
  // link expired or the rep marked it not signed (a status that never
  // locks) and the contract has to go out again anyway.
  const termsLocked = !contractExpired && documentLocksTerms(contractStatus, kind);
  const editable = !termsLocked;
  const plain = termsLocked && plainText ? plainText : null;

  const shownFields = useMemo(() => withPending(fields, pending), [fields, pending]);
  const clauses = useMemo(() => parseClauses(template?.clauses), [template?.clauses]);
  const terms = useMemo(() => contractTerms(clauses, shownFields, (key) => fieldMeta(key).label), [clauses, shownFields]);
  const termsByKey = useMemo(() => new Map(terms.map((t) => [t.key, t])), [terms]);
  // What a send would leave blank: an empty term, or one the text has with
  // no row behind it. The server refuses to send with any of these.
  const missing = useMemo(() => terms.filter((t) => t.state === "empty"), [terms]);
  const partyName = plain?.clientName ?? contractParty(shownFields, client);
  // The client's name as the call heard it, before the client is renamed
  // (that happens once the call is written up).
  const heardClientName = shownFields.find((f) => f.fieldKey === "clientName")?.value?.trim() || null;
  const knownClientName = clientNameKnown ? clientName : heardClientName;
  const firstName = knownClientName ? knownClientName.split(/\s+/)[0] || knownClientName : null;
  // In the middle of a sentence, and at its start.
  const who = firstName ?? "the client";
  const Who = firstName ?? "The client";
  // A stand-in client's party name is the stand-in too, unless the call or
  // the lead gave a real one (the client's name, or their company).
  const partyKnown = !!plain || clientNameKnown || partyName !== clientName;

  // The call this screen is on: the one the deal was made on (Start a
  // call), or a recording made on the deal itself that's still going.
  const lastCall = calls[calls.length - 1];
  const pill = call && (call.status === "recording" || call.status === "processing")
    ? {
        id: call.id,
        state: call.status === "recording" && endedCall !== call.id ? ("live" as const) : ("ended" as const),
        startedAt: call.startedAt,
        desktop: call.source === "desktop",
        ours: !!session?.phoneCallId && session.phoneCallId === call.id,
      }
    : lastCall && callInProgress(lastCall)
      ? {
          id: lastCall.id,
          state: endedCall === lastCall.id ? ("ended" as const) : ("live" as const),
          startedAt: new Date(lastCall.startedAt).toISOString(),
          desktop: lastCall.source === "local",
          ours: session?.dealId === dealId,
        }
      : null;
  const callLive = pill?.state === "live";
  // The live screen keeps to the call (what to ask, the transcript) and
  // leaves out what's for later: Mark as not signed, the proposal's
  // sharing card. Not for a recording on the deal this page can't stop: one
  // that's left without its end looks just like one that's on.
  const callFocus = callLive && (pill.id === call?.id || pill.ours);
  // Who the call is with; null while nobody knows (the pill says "New
  // lead", the transcript "Client").
  const personName = call?.personName || heardClientName || (clientNameKnown ? clientName : null);
  const clientFirstName = personName?.split(/\s+/)[0] || null;

  // Polls while the call records or is being written up, while SealMe
  // reads it, or right after a recording on the deal ended.
  const polling = dealIsLive({ status, calls, phoneCallStatus: call?.status ?? null });

  const transcriptText = dealTranscript(call, calls);
  const lines = useMemo(() => parseTranscript(transcriptText), [transcriptText]);
  const heardTerm = heard ? termsByKey.get(heard.key) : undefined;
  const heardKey = heard && heardTerm?.state === "filled" ? heard.key : null;
  const heardQuote = heardKey ? (heard?.quote ?? heardTerm?.sourceQuote ?? null) : null;
  const highlights = useMemo(() => transcriptHighlights(lines, terms, heardKey, heardQuote), [lines, terms, heardKey, heardQuote]);

  // What the poll, the saves and the PDF download read after an await: the
  // state as of the last render.
  const latest = useRef({ fields, call, calls, contractStatus, template, hasContract, previewOpen });
  useEffect(() => {
    latest.current = { fields, call, calls, contractStatus, template, hasContract, previewOpen };
  });
  const pollBusy = useRef(false);
  // Each save bumps the counter and notes it per term, so a poll that left
  // before a save can't put the term's old value back.
  const saveSeq = useRef(0);
  const savedAt = useRef(new Map<string, number>());
  const transcriptOff = useRef(false);
  const toastSeq = useRef(0);

  function showToast(text: string, tone: Toast["tone"] = "ok") {
    toastSeq.current += 1;
    setToast({ id: toastSeq.current, text, tone });
  }

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 3200);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!heard) return;
    const id = window.setTimeout(() => setHeard(null), HEARD_MS);
    return () => window.clearTimeout(id);
  }, [heard]);

  // Once the call is over and written up, the page renders once more on
  // the server for everything that came of it (the contract, the notes,
  // the review panel).
  const wasPolling = useRef(polling);
  useEffect(() => {
    if (wasPolling.current && !polling) router.refresh();
    wasPolling.current = polling;
  }, [polling, router]);

  async function poll() {
    if (pollBusy.current) return;
    pollBusy.current = true;
    try {
      const seqAtStart = saveSeq.current;
      const before = latest.current;
      const phoneText = before.call?.transcript ?? "";
      const known = before.call && !transcriptOff.current ? phoneText.length : 0;
      const data = await getLiveDealStateAction(dealId, known, before.template?.version ?? null);
      if (!data) return;

      // The transcript only grows: each poll brings what came after what
      // the page has. When the two don't add up, the next poll asks for all
      // of it.
      let nextCall = before.call;
      let needsRender = false;
      if (data.phoneCall) {
        const pc = data.phoneCall;
        if (!before.call || before.call.id !== pc.id) {
          needsRender = true;
        } else {
          const text = (pc.transcriptReset ? "" : phoneText.slice(0, known)) + pc.transcriptAppend;
          transcriptOff.current = text.length !== pc.transcriptLength;
          nextCall = { ...before.call, status: pc.status, startedAt: pc.startedAt, endedAt: pc.endedAt, transcript: text };
          setCall(nextCall);
        }
      }

      // A term saved since this poll left keeps what the save brought back
      // (the state as it is now, not as it was when the poll left).
      const savedSince = (key: string) => (savedAt.current.get(key) ?? -1) > seqAtStart;
      const keepSaved = (current: LiveField[]) => {
        const out = data.fields.map((f) => (savedSince(f.fieldKey) ? (current.find((c) => c.fieldKey === f.fieldKey) ?? f) : f));
        for (const c of current) if (savedSince(c.fieldKey) && !out.some((f) => f.fieldKey === c.fieldKey)) out.push(c);
        return out;
      };
      const nextTranscript = dealTranscript(nextCall, data.calls);
      // Only what the call filled in counts as just heard, never a term
      // the rep typed.
      const heardNow = justHeard(before.fields, keepSaved(before.fields), parseTranscript(nextTranscript));
      setFields(keepSaved);
      if (heardNow && !savedSince(heardNow)) setHeard({ key: heardNow, quote: data.fields.find((f) => f.fieldKey === heardNow)?.sourceQuote?.trim() || null });

      setStatus(data.status);
      setSummary(data.summary);
      setCalls(data.calls);
      setActionItems(data.actionItems);
      setCallHighlights(data.callHighlights);
      // The clauses only come back when the template isn't the one the page
      // has (picked again, or edited); otherwise the page keeps its copy.
      if (!data.templateUnchanged && data.template?.version !== before.template?.version) setTemplate(data.template);
      setViewedAt(data.contract?.viewedAt ?? null);
      setSentAt(data.contract?.sentAt ?? null);
      // A contract made or sent meanwhile (the end of the call makes the
      // draft): the page renders again for everything that goes with it.
      const nextContractStatus = data.contract?.status ?? null;
      if (nextContractStatus !== before.contractStatus || Boolean(data.contract) !== before.hasContract) {
        setContractStatus(nextContractStatus);
        setContractExpired(nextContractStatus === "expired");
        needsRender = true;
      }
      if (needsRender) router.refresh();
    } catch {
      // A missed poll just waits for the next one.
    } finally {
      pollBusy.current = false;
    }
  }

  useVisibleInterval(() => void poll(), POLL_INTERVAL_MS, polling);

  // ReviewPanel polls its own review state, so this page's status (the top
  // chip, what's next, the send gating) follows the review through its
  // whole lifecycle without a second timer here.
  function handleReviewSync(nextContractStatus: string, dealStatus: string) {
    setStatus(dealStatus);
    // A new contract status means it moved on (the cron marked the link
    // expired, or it went out again), so that status alone settles it.
    if (nextContractStatus !== contractStatus) setContractExpired(nextContractStatus === "expired");
    setContractStatus(nextContractStatus);
  }

  async function saveField(key: string, value: string) {
    const label = termsByKey.get(key)?.label ?? fieldMeta(key).label;
    saveSeq.current += 1;
    savedAt.current.set(key, saveSeq.current);
    setPending((p) => ({ ...p, [key]: value }));
    if (heard?.key === key) setHeard(null);
    let message: { text: string; tone: Toast["tone"] };
    try {
      const result = await setFieldAction(key, value);
      if (result.error) {
        message = { text: result.error, tone: "error" };
      } else {
        if (result.fields) setFields(result.fields);
        if (result.status) setStatus(result.status);
        if (latest.current.contractStatus === "changes_requested") setUpdatedAfterRequest(true);
        message = { text: value.trim() ? `${label} updated` : `${label} cleared`, tone: "ok" };
      }
    } catch {
      message = { text: "Couldn't save that. Try again", tone: "error" };
    }
    setPending((p) => {
      if (p[key] !== value) return p;
      const next = { ...p };
      delete next[key];
      return next;
    });
    showToast(message.text, message.tone);
  }

  function commitEdit(key: string, value: string) {
    setEditingKey(null);
    void saveField(key, value);
  }

  // Opens a term for typing: on the paper where it first appears, or in
  // the list for a term the text doesn't have (the client's email). A
  // document that can't be edited just shows where the term is.
  function startEditing(key: string) {
    if (!editable) {
      revealField(key);
      return;
    }
    setEditingKey(key);
    if (termsByKey.get(key)?.onPaper === false) {
      window.requestAnimationFrame(() => document.getElementById("missing")?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    }
  }

  function handleSend() {
    if (missing.length > 0) {
      setMissingOpen(true);
      return;
    }
    if (hasContract) {
      router.push(`/deals/${dealId}/send`);
      return;
    }
    startSending(async () => {
      try {
        const result = await generateAndSendAction();
        if (result?.error) showToast(result.error, "error");
      } catch (err) {
        // Making the draft ends in a redirect to the Send page, which Next
        // carries out by itself.
        if (!isRedirect(err)) showToast(`Couldn't open the ${doc} to send. Try again`, "error");
      }
    });
  }

  function restore() {
    startRestoring(async () => {
      try {
        await restoreDeal(dealId);
        router.refresh();
      } catch {
        showToast("Couldn't restore it. Try again from Trash.", "error");
      }
    });
  }

  // A blob, not a link to the PDF: the desktop app would open a plain link
  // in its own viewer with no way back to the app.
  async function downloadPdf() {
    if (!contractId || downloading) return;
    setDownloading(true);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/contracts/${contractId}/pdf`);
      if (!res.ok) throw new Error("Failed to download the PDF");
      const filename = filenameFromDisposition(res.headers.get("content-disposition") ?? "", isProposal ? "proposal.pdf" : "contract.pdf");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      const text = "Couldn't download the PDF. Try again.";
      // Over the open preview (a modal) a toast can't be seen, so the
      // preview says it itself.
      if (latest.current.previewOpen) setPreviewError(text);
      else showToast(text, "error");
    } finally {
      setDownloading(false);
    }
  }

  // End call and Discard work only from the desktop app that's recording
  // this call (its own session); anywhere else the pill just says where.
  const canStop = !!pill && pill.state === "live" && pill.ours && inDesktop === true && !!session;
  async function endCall() {
    if (!session || !pill) return;
    const { error } = await stopCapture(session);
    if (error) throw new Error(error);
    setEndedCall(pill.id);
    // A recording made on the deal itself plays a short spoken recap, as
    // its Stop & finish always did. Nothing plays when there's none.
    if (session.dealId !== undefined) new Audio(`/api/deals/${session.dealId}/call-recap`).play().catch(() => {});
    showToast("Call ended. SealMe is finishing the notes.");
    router.refresh();
  }
  async function discardCall() {
    if (!session) return;
    const { error } = await discardCapture(session);
    if (error) throw new Error(error);
    // A call from Start a call takes its drafts to the trash with it, this
    // one included. A recording made on the deal leaves the deal as it was.
    if (session.phoneCallId) router.push("/leads");
    else router.refresh();
  }

  // The bar at the top of the app shows the same recording; this page has
  // it in the pill, so the bar steps aside while the page is open.
  const captureOnPage = pill?.ours && session ? (session.phoneCallId ?? session.dealId) : null;
  useEffect(() => {
    if (!captureOnPage) return;
    return showCaptureOnPage(captureOnPage);
  }, [captureOnPage]);

  // Wherever the contract screen offers it too: still out, past its link,
  // or changes asked for after it went out. Not from the trash, which the
  // server refuses.
  const markNotSigned = !trashed && canMarkNotSigned(contractStatus ? { status: contractStatus, sentAt } : null, kind);

  const sendable =
    !trashed &&
    editable &&
    missing.length === 0 &&
    (isProposal
      ? !hasContract || (contractStatus === "draft" && !derivedContractId)
      : (!hasContract || contractStatus === "draft") && status !== "pending_approval" && status !== "changes_requested" && status !== "sent" && status !== "signed");

  // A signed contract's renewal, shown in its own card under the next step.
  const showRenewal = renewal && !isProposal && !trashed && contractStatus === "signed" ? renewal : null;
  const sendAgain = <CardButton variant="primary" href={`/deals/${dealId}/send`}>Send again</CardButton>;
  const readyTitle = terms.length > 1 ? `All ${terms.length} terms are in` : "Everything's in";
  // Dates in the viewer's own format, once the page runs in the browser.
  const dateText = (iso: string | null) => (iso && isClient ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null);
  const signerName = signature?.signerName ?? contractSignerName;
  // The client signs a SealMe contract at its own link, which the rep can
  // copy and share while it's out (a DocuSign one is signed on DocuSign's
  // page). Built at the click, so it falls back to this page's origin.
  const signLink =
    !isProposal && contractId && contractDeliveryMethod === "sealme" && !contractExpired && (contractStatus === "sent" || contractStatus === "partially_signed") ? (
      <CopyLinkButton link={() => clientDocumentUrl(contractId, "contract")} />
    ) : null;
  const downloadButton = contractId ? (
    <CardButton onClick={downloadPdf} busy={downloading}>
      {downloading ? "Downloading..." : "Download PDF"}
    </CardButton>
  ) : null;

  // Brings the first client comment on the paper into view and moves focus
  // there, so a keyboard or screen reader lands on it too.
  function showComments() {
    const el = document.querySelector<HTMLElement>('[data-contract-paper="work"] [data-client-comment]');
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.focus({ preventScroll: true });
  }

  // The one thing this deal needs next. During the call that's what to ask;
  // once everything's in, sending it; otherwise where it stands.
  function nextStep(): NextView {
    if (trashed) {
      return {
        eyebrow: "Next step",
        title: "In the trash",
        text: `Nothing goes to ${who} from the trash. Restore it to carry on.`,
        actions: (
          <>
            <CardButton variant="primary" onClick={restore} busy={restoring}>{restoring ? "Restoring..." : "Restore"}</CardButton>
            {downloadButton}
          </>
        ),
      };
    }
    if (callLive && editable && missing.length > 0) {
      const next = nextToAsk(terms, asked)!;
      const askedAlready = asked.has(next.key);
      return {
        eyebrow: askedAlready ? (
          <>
            Listening for the answer
            <WaitingDots />
          </>
        ) : (
          "Ask next"
        ),
        title: next.label,
        quote: fieldQuestion(next.key, next.label),
        actions: askedAlready ? (
          <CardButton onClick={() => startEditing(next.key)}>Type it in</CardButton>
        ) : (
          <CardButton onClick={() => markAsked(next.key)}>Mark as asked</CardButton>
        ),
      };
    }
    const ready: NextView = {
      eyebrow: "Ready to send",
      title: readyTitle,
      tone: "done",
      text: callLive
        ? `Send it now, while ${who} is still on the call.`
        : isProposal
          ? "Send it by email or copy the link. Nothing goes out until you do."
          : `${Who} gets it to sign as soon as you send.`,
      actions: (
        <CardButton variant="primary" onClick={handleSend} busy={sending}>
          Review and send
        </CardButton>
      ),
    };
    if (callLive && sendable) return ready;
    if (status === "processing") return { eyebrow: "Next step", title: "SealMe is reading the call", text: "The terms fill in by themselves in a moment." };
    if (status === "extraction_failed") {
      return {
        eyebrow: "Next step",
        title: "Reading the call failed",
        tone: "warn",
        text: "Try again; nothing is lost. If it keeps failing, check your AI extraction setup (e.g. Anthropic billing).",
        actions: (
          <form action={retryExtractionAction}>
            <CardButton type="submit" variant="primary">Try again</CardButton>
          </form>
        ),
      };
    }
    if (editable && missing.length > 0) {
      const n = missing.length;
      return {
        eyebrow: "Still empty",
        title: n === 1 ? "1 term still empty" : `${n} terms still empty`,
        text: `Click an empty field in the ${doc} to type it in.`,
        actions: <CardButton onClick={() => startEditing(missing[0].key)}>Fill in {lowerLabel(missing[0].label)}</CardButton>,
      };
    }
    if (sendable) return ready;
    const reviewAndSend = (
      <CardButton variant="primary" onClick={handleSend} busy={sending}>
        Review and send
      </CardButton>
    );

    // A proposal goes Draft, Sent, Viewed, then on to its contract. It's
    // never signed, reviewed or expired, so none of the contract's steps apply.
    if (isProposal) {
      if (derivedContractId) {
        return { eyebrow: "Next step", title: "Contract made", text: "Carry on from the contract.", actions: <CardButton variant="primary" href={`/deals/${derivedContractId}`}>Open contract</CardButton> };
      }
      if (contractStatus === "sent") {
        return viewedAt
          ? { eyebrow: "Next step", title: <span suppressHydrationWarning>{`${Who} opened it ${timeAgo(viewedAt)}`}</span>, text: "Make the contract when they're ready to go ahead." }
          : { eyebrow: "Next step", title: `Sent to ${who}`, text: "They haven't opened it yet." };
      }
      return { eyebrow: "Next step", title: "Check the proposal and send it", text: "Send it by email or copy the link. Nothing goes out until you do.", actions: reviewAndSend };
    }

    // Checked on the contract: marking it leaves the deal at "sent".
    if (contractStatus === "not_signed") {
      const on = dateText(markedNotSignedAt);
      return {
        eyebrow: "Next step",
        title: "Not signed",
        text: on ? `Marked as not signed on ${on}. Send it again if ${who} wants to go ahead.` : `${Who} didn't sign it. Send it again whenever they're ready.`,
        actions: sendAgain,
      };
    }
    if (status === "pending_approval") {
      // The review card right under this says who has it.
      return { eyebrow: "Next step", title: "Waiting for approval", text: `It goes to ${who} as soon as it's approved.` };
    }
    if (status === "changes_requested") {
      // Changed here since: what's left is sending this version.
      if (updatedAfterRequest) {
        return {
          eyebrow: "Next step",
          title: "Contract updated",
          tone: "done",
          text: changesRequestedBy?.by === "reviewer" ? "Send it again when you're ready." : `Send it again so ${who} gets this version.`,
        };
      }
      if (docusignVoid) {
        return { eyebrow: "Next step", title: "Voided in DocuSign", tone: "warn", text: `${docusignVoid.reason ? `${docusignVoid.reason}. ` : ""}Make any changes, then send it again.` };
      }
      // Not from contractSentAt: it stays set from an earlier round when a
      // new one goes to review, so a reviewer's or counter-signer's no
      // would read as the client's.
      if (changesRequestedBy?.by === "signer") {
        return { eyebrow: "Next step", title: "Declined to sign", tone: "warn", text: `${changesRequestedBy.name ?? "A signer"} declined to sign. Make any changes, then send it again.` };
      }
      // The client's comments sit on the paper, under the clauses they're about.
      const comments = clauseComments.length > 0;
      const text =
        changesRequestedBy?.by === "client" || (!changesRequestedBy && comments)
          ? comments
            ? `${Who} asked for changes. Their comments are under the clauses. Make the changes, then send it again.`
            : `${Who} asked for changes. Make them, then send it again.`
          : changesRequestedBy?.by === "reviewer"
            ? "A reviewer asked for changes before it goes out."
            : "Changes were asked for. Make them, then send it again.";
      return {
        eyebrow: "Next step",
        title: "Make the requested changes",
        tone: "warn",
        text,
        actions: comments ? <CardButton onClick={showComments}>{clauseComments.length === 1 ? "Show the comment" : "Show the comments"}</CardButton> : undefined,
      };
    }
    if (status === "sent" && contractExpired) {
      const on = dateText(contractExpiresAt);
      return {
        eyebrow: "Next step",
        title: "Sign link expired",
        tone: "warn",
        text: on ? `The sign link expired on ${on}. Send it again so ${who} can sign.` : `${Who} can't sign it anymore. Send it again for a new link.`,
        actions: sendAgain,
      };
    }
    // The client signed; a counter-signer still has to.
    if (contractStatus === "partially_signed") {
      const waitingOn = pendingSigners.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join(", ");
      return {
        eyebrow: "Next step",
        title: `Signed by ${signerName ?? who}`,
        text: `Waiting on ${waitingOn || "the other signers"}.`,
        actions: signLink,
      };
    }
    if (status === "sent") {
      return {
        eyebrow: "Next step",
        title: `Waiting for ${who} to sign`,
        // Only SealMe's own sign page records a view; DocuSign's doesn't tell us.
        text: viewedAt ? (
          <span suppressHydrationWarning>{`They opened it ${timeAgo(viewedAt)}.`}</span>
        ) : contractDeliveryMethod === "sealme" ? (
          "They haven't opened it yet."
        ) : contractDeliveryMethod === "docusign" ? (
          "Sent through DocuSign."
        ) : undefined,
        actions: signLink,
      };
    }
    if (status === "signed") {
      const on = dateText(signature?.signedAt ?? contractSignedAt);
      const by = signerName ? `Signed by ${signerName}${on ? ` on ${on}` : ""}.` : on ? `Signed on ${on}.` : "";
      // With a renewal card under this one there's still that to do.
      if (showRenewal) {
        const soon = isClient && renewalCountdown(showRenewal.date).soon;
        const text = [by, soon ? "The renewal is below." : ""].filter(Boolean).join(" ");
        return { eyebrow: "Next step", title: "Signed", tone: "done", text: text || undefined };
      }
      return { eyebrow: "Next step", title: "Signed", tone: "done", text: `${by ? `${by} ` : ""}Nothing left to do on this deal.` };
    }
    return { eyebrow: "Next step", title: "Check the contract and send it", text: `${Who} gets it to sign as soon as you send.`, actions: reviewAndSend };
  }

  const step = nextStep();
  // Mark as not signed rides along whatever the step says, wherever
  // canMarkNotSigned allows it, the same as on the contract screen.
  const stepActions =
    markNotSigned && !callFocus ? (
      <>
        {step.actions}
        <div style={{ flexBasis: "100%", minWidth: 0 }}>
          <MarkNotSignedButton dealId={dealId} clientName={clientName} />
        </div>
      </>
    ) : (
      step.actions
    );

  // The line under the parties: where the document stands.
  function paperMeta(): { text: string; live: boolean } {
    if (callLive && editable && !plain) return { text: "Draft, filling in during the call", live: true };
    const sent = dateText(sentAt);
    const sentLine = sent ? `Sent on ${sent}` : "Sent";
    if (isProposal) {
      if (contractStatus !== "sent") return { text: "Draft", live: false };
      return { text: changedSinceSent ? `${sentLine}, changed since` : sentLine, live: false };
    }
    if (contractStatus === "signed") {
      const on = dateText(signature?.signedAt ?? contractSignedAt);
      const by = signature?.signerName ? ` by ${signature.signerName}` : "";
      return { text: on ? `Signed on ${on}${by}` : `Signed${by}`, live: false };
    }
    if (contractStatus === "not_signed") return { text: `${sentLine}, not signed`, live: false };
    if (contractExpired) return { text: `${sentLine}, sign link expired`, live: false };
    if (contractStatus === "partially_signed") return { text: signerName ? `${sentLine}, signed by ${signerName}` : `${sentLine}, partly signed`, live: false };
    if (contractStatus === "sent") return { text: sentLine, live: false };
    if (contractStatus === "pending_approval") return { text: "Waiting for approval", live: false };
    if (contractStatus === "changes_requested") return { text: "Draft, changes requested", live: false };
    return { text: "Draft", live: false };
  }
  const meta = paperMeta();

  const reviewVisible =
    !!reviewPanel &&
    !isProposal &&
    (reviewPanel.initialSteps.length > 0 || status === "pending_approval" || status === "changes_requested" || contractStatus === "pending_approval" || contractStatus === "changes_requested");
  const reviewPanelNode = reviewPanel && !isProposal && (
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
  );

  // With no document yet (a proposal made from a call with blanks the rep
  // filled in here), Copy link and Download PDF make it first.
  const proposalReady = (hasContract ? Boolean(contractId) : true) && missing.length === 0 && status !== "processing" && status !== "extraction_failed";

  const canSendToDocusignNow = !trashed && !isProposal && docusignEnabled && status === "ready" && contractStatus === "draft" && clientHasEmail;
  const history = shownFields.filter((f) => f.history.length > 0);
  const voiceFix = !termsLocked && shownFields.some((f) => f.status !== "missing");

  // What a recording on this screen might have missed: nothing heard at
  // all, or only one side. At the top while the call is on (it can still be
  // saved) or just ended; for a call long over, under More with the calls.
  const micNow: ReactNode[] = [];
  const micPast: ReactNode[] = [];
  const watchMic = (key: string, transcript: string, startedAt: Date | string, endedAt: Date | string | null, inProgress: boolean, recent: boolean) => {
    const into = recent ? micNow : micPast;
    const start = new Date(startedAt);
    const end = endedAt ? new Date(endedAt) : null;
    if (inProgress && !transcript.trim()) into.push(<NothingHeardYet key={`${key}-quiet`} startedAt={start} />);
    // A call over in its first minute says nothing (MicSilentWarning's own
    // rule), so a past one is left out here rather than as an empty card.
    const longEnough = recent || !end || end.getTime() - start.getTime() > 60_000;
    if (longEnough && channelHasWords(transcript, "Client") && !channelHasWords(transcript, "You")) into.push(<MicSilentWarning key={`${key}-mic`} startedAt={start} endedAt={end} />);
    if (end && channelHasWords(transcript, "You") && !channelHasWords(transcript, "Client")) {
      into.push(
        <div key={`${key}-other`} className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          We didn&apos;t pick up anything from the other side of this call. Only your own mic came through. If you were on headphones or an external mic, try switching back to your Mac&apos;s built-in speakers and microphone and recording again.
        </div>,
      );
    }
  };
  if (call?.source === "desktop") {
    const onPill = pill?.id === call.id;
    // The call's own status says whether it's on; the pill shows it while it records or is written up.
    const recent = onPill || (!!call.endedAt && callIsRecent({ startedAt: call.startedAt, endedAt: call.endedAt }));
    watchMic(`pc-${call.id}`, call.transcript, call.startedAt, call.endedAt, call.status === "recording", recent);
  }
  for (const c of calls) {
    if (c.source !== "local") continue;
    const inProgress = c.id === lastCall?.id && callInProgress(c);
    watchMic(`call-${c.id}`, c.transcript, c.startedAt, c.endedAt, inProgress, inProgress || callIsRecent(c));
  }

  const moreHint = [summary ? "Summary" : null, actionItems.length ? "action items" : null, "notes", history.length ? "history" : null, calls.length ? "calls" : null]
    .filter(Boolean)
    .join(", ");

  // The main button under the paper, by where the document stands.
  const badge = termsBadge(missing.length, terms.length);
  let primary: ReactNode;
  if (trashed) {
    primary = (
      <BarButton variant="primary" icon={<RestoreIcon />} onClick={restore} busy={restoring}>
        {restoring ? "Restoring..." : "Restore"}
      </BarButton>
    );
  } else if (isProposal) {
    primary = (
      <BarButton variant="primary" icon={<SendIcon />} badge={badge} onClick={handleSend} busy={sending}>
        {contractStatus === "sent" ? "Send again" : "Send proposal"}
      </BarButton>
    );
  } else if (contractStatus === "pending_approval") {
    primary = (
      <BarButton variant="primary" disabled>
        Waiting for approval
      </BarButton>
    );
  } else if (termsLocked) {
    primary = (
      <BarButton variant="primary" icon={<DownloadIcon />} onClick={downloadPdf} busy={downloading} disabled={!contractId}>
        {downloading ? "Downloading..." : "Download PDF"}
      </BarButton>
    );
  } else {
    // Back to the client: past its link, marked not signed, or changes asked for.
    const again = contractStatus === "not_signed" || contractExpired || contractStatus === "changes_requested";
    primary = (
      <BarButton variant="primary" icon={<SendIcon />} badge={badge} onClick={handleSend} busy={sending}>
        {again ? "Send again" : "Send for signature"}
      </BarButton>
    );
  }

  const paperProps = {
    kind,
    agencyName: plain?.agencyName ?? agencyName,
    partyName,
    templateName: plain?.templateName ?? template?.name ?? "",
    clauses,
    plainClauses: plain ? plain.clauses : undefined,
    terms,
    metaText: meta.text,
    signature: isProposal ? null : signature,
  };

  return (
    <div className={s.screen} data-wide-page="">
      <header className={s.head}>
        <div className={s.headMain}>
          {/* Back to the person it's for, opened on the call it came from. */}
          <Link href={leadId ? `/leads/${leadId}${call ? `?call=${call.id}` : ""}` : "/leads"} className={s.back}>
            ← {leadId ? clientName : "Leads"}
          </Link>
          <div className={s.titleRow}>
            <h1 className={s.title}>{clientName}</h1>
            <span className={`chip ${dealStatusChip(status, contractExpired, kind, contractStatus)}`}>
              <span className="chip-dot" />
              {dealStatusLabel(status, contractExpired, kind, contractStatus)}
            </span>
            {/* Only while it's waiting on them; once it's signed, closed or
                back with the rep, when they last opened it is beside the point. */}
            {viewedAt && !contractExpired && (contractStatus === "sent" || contractStatus === "partially_signed") && (
              <span className={s.headMeta}>
                Viewed <ClientText text={() => timeAgo(viewedAt)} />
              </span>
            )}
            {!isProposal && sourceDealId && (
              <Link href={`/deals/${sourceDealId}`} className={s.headLink}>
                Made from a proposal →
              </Link>
            )}
          </div>
        </div>
        {pill && (
          <CallPill
            key={pill.id}
            state={pill.state}
            startedAt={pill.startedAt}
            name={personName}
            sub={call?.personSub ?? null}
            documentLabel={doc}
            onEnd={canStop ? endCall : undefined}
            onDiscard={canStop ? discardCall : undefined}
            hint={pill.desktop ? "Recording in the desktop app" : null}
          />
        )}
      </header>

      {micNow.length > 0 && <div className={s.warnings}>{micNow}</div>}

      <div className={s.layout}>
        <div className={s.paperCol}>
          <ContractPaper
            {...paperProps}
            editable={editable}
            metaLive={meta.live}
            heardKey={heardKey}
            heardQuote={heardQuote}
            askedKeys={asked}
            editingKey={editingKey}
            onStartEdit={setEditingKey}
            onCommit={commitEdit}
            onCancel={() => setEditingKey(null)}
            comments={isProposal ? undefined : clauseComments}
            animateIn
          />
          <ActionBar alignWithNotes={meta.live} label={isProposal ? "Proposal actions" : "Contract actions"}>
            <BarButton icon={<EyeIcon />} onClick={() => setPreviewOpen(true)}>
              Preview
            </BarButton>
            {primary}
          </ActionBar>
        </div>

        <aside className={s.side} aria-label={isProposal ? "Proposal terms and next step" : "Contract terms and next step"}>
          <TermsCard
            title={isProposal ? "Proposal terms" : "Contract terms"}
            terms={terms}
            askedKeys={asked}
            onPick={startEditing}
            editingKey={editingKey}
            onCommit={commitEdit}
            onCancel={() => setEditingKey(null)}
            editable={editable}
            heardKey={heardKey}
          />

          <NextCard eyebrow={step.eyebrow} title={step.title} text={step.text} quote={step.quote} tone={step.tone} actions={stepActions} />

          {showRenewal && <RenewalCard date={showRenewal.date} autoRenews={showRenewal.autoRenews} note={showRenewal.note} startAction={startRenewalAction} />}

          {isProposal && !trashed && !callFocus && (
            <ProposalActions
              dealId={dealId}
              contractId={contractId}
              contractStatus={contractStatus}
              ready={proposalReady}
              makeDraftAction={hasContract ? undefined : makeDraftAction}
              notReadyHint={status === "processing" || status === "extraction_failed" ? "Ready once SealMe has read the call." : "Fill in the empty terms first."}
              viewedAt={viewedAt}
              derivedContractId={derivedContractId}
              contractTemplates={contractTemplates}
              changedSinceSent={changedSinceSent}
              createDisabled={status === "processing"}
              showSend={false}
            />
          )}

          {(canSendToDocusignNow || docusignNowStarted) && (
            <SendToDocusignButton dealId={dealId} sendAction={sendViaDocusignNowAction} onStart={() => setDocusignNowStarted(true)} />
          )}

          {reviewVisible && reviewPanelNode}

          <TranscriptCard lines={lines} live={callLive} clientFirstName={clientFirstName} highlights={highlights} />

          <MoreSection hint={moreHint ? moreHint[0].toUpperCase() + moreHint.slice(1) : null}>
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

            <ActionItemsCard dealId={dealId} items={actionItems} today={today} toggleAction={toggleActionItemAction} />

            <DealNotes dealId={dealId} notes={notes} currentUserEmail={currentUserEmail} currentUserName={currentUserName} addAction={addNoteAction} deleteAction={deleteNoteAction} />

            {history.length > 0 && <TermHistory fields={history} />}

            {micPast.length > 0 && (
              <div className="card p-5">
                <h2 className="mb-1 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
                  Call recording
                </h2>
                <div className="flex flex-col gap-2">{micPast}</div>
              </div>
            )}

            {calls.length > 0 && (
              <div className="card p-5">
                <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
                  Calls
                </h2>
                <div className="flex flex-col gap-3">
                  {calls.map((c, i) => (
                    <div key={c.id} className="border-b pb-3 last:border-b-0 last:pb-0" style={{ borderColor: "var(--hairline-soft)" }}>
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-[13px] font-medium">
                          Call {i + 1} - {CALL_SOURCE_LABEL[c.source] ?? c.source}
                        </span>
                        <span className="flex-none text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
                          <ClientText text={() => new Date(c.startedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
                          {!c.endedAt && c.id === lastCall?.id ? " · in progress" : ""}
                        </span>
                      </div>
                      <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--ink-muted)", overflowWrap: "anywhere" }}>
                        {callPreview(c.transcript)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!reviewVisible && reviewPanelNode}

            {/* Its changes would be refused while the terms are locked. */}
            {voiceFix && (
              <VoiceCorrectionButton dealId={dealId} applyAction={applyVoiceFieldCorrectionAction} reviewAction={isProposal ? refuseProposalReview : sendForReviewToAction} />
            )}

            {status !== "signed" && <ContinueCallButton dealId={dealId} />}

            {canExportAuditTrail && (
              <div className={s.moreLinks}>
                <AuditTrailButton dealId={dealId} className={s.moreLink} />
              </div>
            )}
          </MoreSection>
        </aside>
      </div>

      <MissingDialog
        open={missingOpen}
        missing={missing.map((t: ContractTerm) => ({ key: t.key, label: t.label }))}
        partyName={partyKnown ? partyName : null}
        documentLabel={doc}
        live={callLive}
        onFill={(key) => {
          setMissingOpen(false);
          startEditing(key);
        }}
        onClose={() => setMissingOpen(false)}
      />

      <PreviewModal
        open={previewOpen}
        onClose={() => {
          setPreviewOpen(false);
          setPreviewError(null);
        }}
        subtitle={`This is what ${partyKnown && partyName ? partyName : "the client"} will see.`}
        actions={downloadButton}
        notice={previewError}
      >
        <ContractPaper {...paperProps} editable={false} mode="preview" />
      </PreviewModal>

      {toast && (
        <div key={toast.id} className={s.toast} data-tone={toast.tone} role={toast.tone === "error" ? "alert" : "status"}>
          <i aria-hidden="true" />
          <span>{toast.text}</span>
        </div>
      )}

      <ActionBarSpacer />
    </div>
  );
}

// Every term the rep or a later call changed, old value to new, under More.
function TermHistory({ fields }: { fields: LiveField[] }) {
  return (
    <div className="card p-5">
      <h2 className="mb-3 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
        Change history
      </h2>
      <div className="flex flex-col gap-3">
        {fields.map((f) => (
          <div key={f.fieldKey} className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{f.label}</span>
            {f.history.map((change, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
                <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
                  {change.oldValue ? <span style={{ textDecoration: "line-through" }}>{change.oldValue}</span> : <span>Empty</span>}
                  {" → "}
                  <span style={{ color: "var(--ink)" }}>{change.newValue ?? "Cleared"}</span>
                </span>
                <span className="flex-none text-[11px]">
                  {change.changedBy === "manual" ? "edited" : change.changedBy === "voice" ? "by voice" : "on call"} ·{" "}
                  <ClientText text={() => new Date(change.changedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// A proposal never goes through review, so the voice "send it to X for
// review" ask is turned down instead of starting a chain.
async function refuseProposalReview(): Promise<{ error?: string }> {
  return { error: "A proposal doesn't go through review. Send it by email or copy the link." };
}
