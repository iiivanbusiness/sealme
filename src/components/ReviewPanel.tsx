"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import ClientText from "@/components/ClientText";

type ChecklistItem = { id: string; label: string; done: boolean };
type Comment = { id: string; authorName: string; authorEmail: string; body: string; createdAt: string };
type ReviewStepItem = {
  id: string;
  order: number;
  status: string; // pending | approved | rejected
  assigneeId: string;
  assigneeName: string;
  decidedByName: string | null;
  decidedOnBehalfOfName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  note: string | null;
  priority: string; // low | normal | high | urgent
  dueAt: Date | null;
  checklistItems: ChecklistItem[];
  comments: Comment[];
};
type TeammateOption = { id: string; name: string };
type ReviewState = {
  contractStatus: string;
  dealStatus: string;
  contractCreatedAt: Date;
  contractSentAt: Date | null;
  contractSignedAt: Date | null;
  steps: ReviewStepItem[];
};

// Faster while someone is actively reviewing, slower otherwise; stops once the
// contract is signed since nothing can change after that.
const ACTIVE_REVIEW_POLL_MS = 10000;
const IDLE_POLL_MS = 30000;

// Same-day: an exact clock time ("4:32 PM") is more useful than a relative
// "now" once there's more than one timestamp on screen — the whole point of
// this timeline is answering "when was it sent, when did they act on it."
// Older than today: falls back to a short date, same as the rest of the app.
function formatWhen(date: Date): string {
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type TimelineRow = {
  id: string;
  kind: "done" | "active" | "upcoming";
  title: string;
  subtitle: string;
  time: Date | null;
  failed?: boolean;
  step?: ReviewStepItem;
};

// The full contract journey as one fixed-shape line — drafted, through
// however many human review steps are actually configured (zero or more),
// to sent-to-client, to signed. A single-reviewer contract used to render
// as one lone row with nothing to connect a line to, which is exactly what
// read as "nothing visually changes" even though the row's own content was
// updating correctly. Always including the "Contract drafted" and
// "sent/signed" ends means there's always at least one connecting line on
// screen, and it visibly grows as the deal moves — the same shape as the
// reference ClickUp timeline, not just a single status label.
function buildTimeline(params: {
  steps: ReviewStepItem[];
  contractStatus: string;
  dealStatus: string;
  contractCreatedAt: Date;
  contractSentAt: Date | null;
  contractSignedAt: Date | null;
  clientName: string;
}): { rows: TimelineRow[]; activeStep: ReviewStepItem | null; mostRecentDecided: ReviewStepItem | null } {
  const sorted = [...params.steps].sort((a, b) => a.order - b.order);
  const activeStep = sorted.find((s) => s.status === "pending") ?? null;
  const mostRecentDecided = [...sorted].filter((s) => s.status !== "pending").sort((a, b) => b.order - a.order)[0] ?? null;

  const rows: TimelineRow[] = [
    { id: "created", kind: "done", title: "Contract", subtitle: "drafted", time: params.contractCreatedAt },
  ];

  for (const step of sorted) {
    const kind: TimelineRow["kind"] = step.status !== "pending" ? "done" : step.id === activeStep?.id ? "active" : "upcoming";
    rows.push({
      id: step.id,
      kind,
      title: step.assigneeName,
      subtitle: kind === "done" ? (step.status === "approved" ? "approved" : "requested changes") : kind === "active" ? "reviewing now" : "up next",
      time: kind === "done" ? step.decidedAt : kind === "active" ? step.createdAt : null,
      failed: step.status === "rejected",
      step,
    });
  }

  const hasBeenSent =
    params.contractStatus === "sent" ||
    params.contractStatus === "partially_signed" ||
    params.contractStatus === "signed" ||
    params.dealStatus === "sent" ||
    params.dealStatus === "signed";
  const isSigned = params.dealStatus === "signed";

  const sentKind: TimelineRow["kind"] = !hasBeenSent ? "upcoming" : isSigned ? "done" : "active";
  rows.push({
    id: "sent",
    kind: sentKind,
    title: params.clientName,
    subtitle: sentKind === "upcoming" ? "up next" : sentKind === "active" ? "awaiting signature" : "sent",
    time: hasBeenSent ? params.contractSentAt : null,
  });

  rows.push({
    id: "signed",
    kind: isSigned ? "done" : "upcoming",
    title: params.clientName,
    subtitle: isSigned ? "signed" : "up next",
    time: isSigned ? params.contractSignedAt : null,
  });

  return { rows, activeStep, mostRecentDecided };
}

function rowSnapshotKey(row: TimelineRow): string {
  return row.step ? `${row.step.status}|${row.step.assigneeId}` : row.kind;
}

function SendIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M2 21l21-9L2 3v7l15 2-15 2v7z" fill="#fff" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" className="animate-spin">
      <circle cx="12" cy="12" r="9" stroke="#fff" strokeWidth="2.5" strokeOpacity="0.3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Persistent review status card for the Deal page's sidebar — always
// visible once a contract exists, not just while a chain-triggered review
// happens to be in flight. "Send to" is the manual override: it always
// works, even mid-chain, by reassigning whatever step is currently active
// (or starting a fresh one if nothing is). The chain (configured in
// Settings) is just the default that fires this same underlying state on
// "Send to client" — this panel doesn't care which path created it.
//
// The timeline itself is the confirmation: there's no separate "sent!"
// takeover card. Every mutation (ours or, via polling, a teammate's on
// their own device) flows through the same refresh() -> applyState() path,
// which diffs the incoming rows (drafted / each reviewer / sent / signed)
// against what was last shown and marks whichever ones are new or changed
// so they animate in place — so the tracking line is always on screen and
// always current, instead of being hidden behind a modal moment you could
// miss.
export default function ReviewPanel({
  dealId,
  clientName,
  initialContractStatus,
  initialDealStatus,
  initialContractCreatedAt,
  initialContractSentAt,
  initialContractSignedAt,
  initialSteps,
  teammates,
  currentUserId,
  currentUserEmail,
  currentUserName,
  delegatedAssigneeIds,
  currentUserCanManageWorkspace,
  getReviewStateAction,
  sendToAction,
  decideAction,
  addChecklistItemAction,
  toggleChecklistItemAction,
  removeChecklistItemAction,
  addCommentAction,
  deleteCommentAction,
  updateStepMetaAction,
  onSync,
}: {
  dealId: string;
  clientName: string;
  initialContractStatus: string;
  initialDealStatus: string;
  initialContractCreatedAt: Date;
  initialContractSentAt: Date | null;
  initialContractSignedAt: Date | null;
  initialSteps: ReviewStepItem[];
  teammates: TeammateOption[];
  currentUserId: string;
  currentUserEmail: string;
  currentUserName: string;
  delegatedAssigneeIds: string[];
  currentUserCanManageWorkspace: boolean;
  getReviewStateAction: (dealId: string) => Promise<ReviewState | null>;
  // Lets an embedding page (LiveDealView) keep its own status-driven UI
  // — the top badge, docusign-send gating — in step with this panel's
  // polling, since that page's own poll only runs during a live call and
  // would otherwise never learn the review moved forward.
  onSync?: (contractStatus: string, dealStatus: string) => void;
  sendToAction: (dealId: string, assigneeId: string) => Promise<{ error?: string }>;
  decideAction: (dealId: string, reviewStepId: string, decision: "approve" | "reject", formData: FormData) => Promise<{ error?: string }>;
  addChecklistItemAction: (dealId: string, reviewStepId: string, formData: FormData) => Promise<{ error?: string }>;
  toggleChecklistItemAction: (dealId: string, itemId: string, done: boolean) => Promise<{ error?: string }>;
  removeChecklistItemAction: (dealId: string, itemId: string) => Promise<{ error?: string }>;
  addCommentAction: (dealId: string, reviewStepId: string, body: string) => Promise<{ error?: string }>;
  deleteCommentAction: (dealId: string, commentId: string) => Promise<{ error?: string }>;
  updateStepMetaAction: (dealId: string, reviewStepId: string, formData: FormData) => Promise<{ error?: string }>;
}) {
  const [note, setNote] = useState("");
  const [newItemLabel, setNewItemLabel] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [sendToId, setSendToId] = useState(teammates[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSending, startSending] = useTransition();
  const [isPending, startTransition] = useTransition();

  const [contractStatus, setContractStatus] = useState(initialContractStatus);
  const [dealStatus, setDealStatus] = useState(initialDealStatus);
  const [contractSentAt, setContractSentAt] = useState(initialContractSentAt);
  const [contractSignedAt, setContractSignedAt] = useState(initialContractSignedAt);
  const [steps, setSteps] = useState(initialSteps);
  const [newRowIds, setNewRowIds] = useState<Set<string>>(new Set());
  const [changedRowIds, setChangedRowIds] = useState<Set<string>>(new Set());
  const [justSent, setJustSent] = useState(false);

  const initialTimeline = buildTimeline({
    steps: initialSteps,
    contractStatus: initialContractStatus,
    dealStatus: initialDealStatus,
    contractCreatedAt: initialContractCreatedAt,
    contractSentAt: initialContractSentAt,
    contractSignedAt: initialContractSignedAt,
    clientName,
  });
  // Keyed on the same snapshot every row is diffed against — a reassignment
  // to a different person (the manual "Send to" override) doesn't change a
  // step's status, so keying on status alone would let a genuine
  // reassignment slip by with no row flash at all, same as the "nothing
  // happened" bug this fixes. Synthetic rows (drafted/sent/signed) key on
  // their own kind, so they flash too the moment they actually progress.
  const prevSnapshotRef = useRef<Map<string, string>>(
    new Map(initialTimeline.rows.map((r) => [r.id, rowSnapshotKey(r)]))
  );
  const flashTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function applyState(data: ReviewState) {
    const nextTimeline = buildTimeline({
      steps: data.steps,
      contractStatus: data.contractStatus,
      dealStatus: data.dealStatus,
      contractCreatedAt: initialContractCreatedAt,
      contractSentAt: data.contractSentAt,
      contractSignedAt: data.contractSignedAt,
      clientName,
    });

    const nextNew = new Set<string>();
    const nextChanged = new Set<string>();
    for (const row of nextTimeline.rows) {
      const prevSnapshot = prevSnapshotRef.current.get(row.id);
      const snapshot = rowSnapshotKey(row);
      if (prevSnapshot === undefined) nextNew.add(row.id);
      else if (prevSnapshot !== snapshot) nextChanged.add(row.id);
    }
    prevSnapshotRef.current = new Map(nextTimeline.rows.map((r) => [r.id, rowSnapshotKey(r)]));

    setContractStatus(data.contractStatus);
    setDealStatus(data.dealStatus);
    setContractSentAt(data.contractSentAt);
    setContractSignedAt(data.contractSignedAt);
    setSteps(data.steps);
    onSync?.(data.contractStatus, data.dealStatus);

    if (nextNew.size > 0 || nextChanged.size > 0) {
      setNewRowIds(nextNew);
      setChangedRowIds(nextChanged);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      flashTimeoutRef.current = setTimeout(() => {
        setNewRowIds(new Set());
        setChangedRowIds(new Set());
      }, 1700);
    }
  }

  async function refresh() {
    const data = await getReviewStateAction(dealId);
    if (data) applyState(data);
  }

  // Picks up a teammate's own decision on their own device without anyone
  // having to reload — this is what makes "did he actually review it yet"
  // a question the panel answers on its own instead of one you have to ask.
  const hasActiveStep = steps.some((s) => s.status === "pending");
  useVisibleInterval(refresh, hasActiveStep ? ACTIVE_REVIEW_POLL_MS : IDLE_POLL_MS, contractStatus !== "signed");

  useEffect(() => {
    return () => {
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
    };
  }, []);

  const { rows, activeStep, mostRecentDecided } = buildTimeline({
    steps,
    contractStatus,
    dealStatus,
    contractCreatedAt: initialContractCreatedAt,
    contractSentAt,
    contractSignedAt,
    clientName,
  });

  const actingAsDelegate = Boolean(activeStep && delegatedAssigneeIds.includes(activeStep.assigneeId));
  const canDecideCurrent = Boolean(activeStep && (activeStep.assigneeId === currentUserId || actingAsDelegate));
  const canEditMeta = Boolean(activeStep && (canDecideCurrent || currentUserCanManageWorkspace));

  // Actions return `{ error? }` instead of throwing — Next.js redacts a
  // thrown Server Action error's message in production (replacing it with
  // an opaque "Minified React error #…"), so the specific, useful message
  // ("This client has no email on file yet", "An earlier step hasn't been
  // approved yet"...) only survives the trip to the client as data.
  function run(fn: () => Promise<{ error?: string }>, onSuccess?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) {
        setError(result.error);
        return;
      }
      onSuccess?.();
      await refresh();
    });
  }

  function sendTo() {
    if (!sendToId) return;
    setError(null);
    startSending(async () => {
      const result = await sendToAction(dealId, sendToId);
      if (result.error) {
        setError(result.error);
        return;
      }
      await refresh();
      // Guaranteed feedback on the button itself — resending to whoever's
      // already the active reviewer (a "nudge") never changes their row's
      // status or assignee, so the diff-driven row flash never fires for
      // it. Without this, clicking Send in that case looked like it did
      // nothing at all.
      setJustSent(true);
      if (sentTimeoutRef.current) clearTimeout(sentTimeoutRef.current);
      sentTimeoutRef.current = setTimeout(() => setJustSent(false), 1700);
    });
  }

  function decide(decision: "approve" | "reject") {
    if (!activeStep) return;
    run(
      () => {
        const formData = new FormData();
        formData.set("note", note);
        return decideAction(dealId, activeStep.id, decision, formData);
      },
      () => setNote("")
    );
  }

  function addItem() {
    if (!activeStep || !newItemLabel.trim()) return;
    run(
      () => {
        const formData = new FormData();
        formData.set("label", newItemLabel.trim());
        return addChecklistItemAction(dealId, activeStep.id, formData);
      },
      () => setNewItemLabel("")
    );
  }

  // Comments show (or disappear) immediately; refresh() then swaps in the
  // server's version, which also undoes the change if the save failed.
  function addComment() {
    const body = commentDraft.trim();
    if (!activeStep || !body) return;
    const stepId = activeStep.id;
    const pending: Comment = { id: `pending-${Date.now()}`, authorName: currentUserName, authorEmail: currentUserEmail, body, createdAt: new Date().toISOString() };
    setError(null);
    setCommentDraft("");
    setSteps((prev) => prev.map((s) => (s.id === stepId ? { ...s, comments: [...s.comments, pending] } : s)));
    startTransition(async () => {
      const result = await addCommentAction(dealId, stepId, body);
      if (result.error) {
        setError(result.error);
        setCommentDraft(body);
      }
      await refresh();
    });
  }

  function deleteComment(commentId: string) {
    setError(null);
    setSteps((prev) => prev.map((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== commentId) })));
    startTransition(async () => {
      const result = await deleteCommentAction(dealId, commentId);
      if (result.error) setError(result.error);
      await refresh();
    });
  }

  function updatePriority(value: string) {
    if (!activeStep) return;
    run(() => {
      const formData = new FormData();
      formData.set("priority", value);
      formData.set("dueAt", activeStep.dueAt ? activeStep.dueAt.toISOString().slice(0, 10) : "");
      return updateStepMetaAction(dealId, activeStep.id, formData);
    });
  }

  const phaseLabel =
    dealStatus === "signed"
      ? "Signed"
      : contractStatus === "sent"
        ? "Sent to client"
        : contractStatus === "expired"
          ? "Sign link expired"
          : activeStep
          ? `With ${activeStep.assigneeName}`
          : mostRecentDecided?.status === "rejected"
            ? "Changes requested"
            : "Not sent for review";
  const phaseChip =
    dealStatus === "signed" || contractStatus === "sent"
      ? "chip-success"
      : activeStep
        ? "chip-active"
        : mostRecentDecided?.status === "rejected"
          ? "chip-warn"
          : "chip-neutral";

  return (
    <div className="card flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>Review</h2>
        <span className={`chip ${phaseChip}`} style={{ fontSize: 11 }}>{phaseLabel}</span>
      </div>

      {error && (
        <div className="rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          {error}
        </div>
      )}

      <div className="flex flex-col">
        {rows.map((row, i) => {
          const isLast = i === rows.length - 1;
          const time = row.time;
          const timeLabel = row.kind === "upcoming" ? "next" : time ? <ClientText text={() => formatWhen(time)} /> : "now";
          const rowAnimation = newRowIds.has(row.id)
            ? "review-row-in 0.35s ease-out"
            : changedRowIds.has(row.id)
              ? "review-row-flash 1.6s ease-out"
              : undefined;
          return (
            <div key={row.id} className="flex gap-2.5 rounded-[8px]" style={{ animation: rowAnimation }}>
              <div
                className="flex-none pt-[3px] text-right text-[11px] font-medium"
                style={{ width: 46, color: row.kind === "active" ? "var(--accent-blue)" : "var(--ink-muted)" }}
              >
                {timeLabel}
              </div>

              <div className="flex flex-none flex-col items-center" style={{ width: 18 }}>
                <span
                  className="flex flex-none items-center justify-center rounded-full text-[10px] font-bold"
                  style={
                    row.kind === "done"
                      ? { width: 18, height: 18, background: row.failed ? "#c0392b" : "var(--accent-blue)", color: "#fff" }
                      : row.kind === "active"
                        ? { width: 10, height: 10, marginTop: 4, border: "2px solid var(--accent-blue)", background: "var(--surface-1)" }
                        : { width: 8, height: 8, marginTop: 5, border: "1.5px solid var(--hairline)", background: "transparent" }
                  }
                >
                  {row.kind === "done" ? (row.failed ? "✕" : "✓") : null}
                </span>
                {!isLast && (
                  <div className="w-0 flex-1" style={{ minHeight: 14, borderLeft: "1.5px dashed var(--hairline)" }} />
                )}
              </div>

              <div className="min-w-0 flex-1 pb-5">
                <div className="flex flex-wrap items-baseline gap-1.5">
                  <span
                    className="text-[13px] font-medium"
                    style={
                      row.kind === "upcoming"
                        ? { color: "var(--ink-muted)" }
                        : row.kind === "done"
                          ? { color: "var(--ink-muted)", textDecoration: "line-through" }
                          : undefined
                    }
                  >
                    {row.title}
                  </span>
                  <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>{row.subtitle}</span>
                </div>

                {row.kind === "active" && row.step && (
                  <div className="mt-2.5 flex min-w-0 flex-col gap-3">
                    {actingAsDelegate && (
                      <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
                        You&apos;re acting as a review backup, not directly as {activeStep!.assigneeName}.
                      </div>
                    )}

                    {canEditMeta && (
                      <select
                        value={activeStep!.priority}
                        onChange={(e) => updatePriority(e.target.value)}
                        disabled={isPending}
                        className="input w-full"
                        style={{ fontSize: "12px", padding: "5px 8px" }}
                      >
                        <option value="low">Low priority</option>
                        <option value="normal">Normal priority</option>
                        <option value="high">High priority</option>
                        <option value="urgent">Urgent</option>
                      </select>
                    )}

                    <div className="flex flex-col gap-1.5">
                      {activeStep!.checklistItems.map((item) => (
                        <div key={item.id} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={item.done}
                            disabled={!canDecideCurrent || isPending}
                            onChange={(e) => run(() => toggleChecklistItemAction(dealId, item.id, e.target.checked))}
                          />
                          <span className="flex-1 text-[13px]" style={item.done ? { color: "var(--ink-muted)", textDecoration: "line-through" } : undefined}>
                            {item.label}
                          </span>
                          {canDecideCurrent && (
                            <button type="button" disabled={isPending} onClick={() => run(() => removeChecklistItemAction(dealId, item.id))} className="text-[11px]" style={{ color: "var(--ink-muted)" }}>
                              Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    {canDecideCurrent && (
                      <div className="flex gap-2">
                        <input
                          value={newItemLabel}
                          onChange={(e) => setNewItemLabel(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addItem(); } }}
                          placeholder="Add a checklist item…"
                          disabled={isPending}
                          className="input flex-1"
                          style={{ fontSize: "12.5px", padding: "6px 9px" }}
                        />
                        <button type="button" disabled={isPending || !newItemLabel.trim()} onClick={addItem} className="btn btn-secondary btn-sm">
                          Add
                        </button>
                      </div>
                    )}

                    <div className="flex flex-col gap-2">
                      {activeStep!.comments.map((c) => (
                        <div
                          key={c.id}
                          className="rounded-[8px] px-2.5 py-2"
                          style={{ background: "var(--surface-1)", opacity: c.id.startsWith("pending-") ? 0.6 : 1, transition: "opacity 0.2s ease-out" }}
                        >
                          <div className="mb-0.5 flex items-center justify-between gap-2">
                            <span className="text-[12px] font-medium">{c.authorName}</span>
                            <div className="flex items-center gap-2">
                              <span className="text-[10.5px]" style={{ color: "var(--ink-muted)" }}>{c.id.startsWith("pending-") ? "Saving…" : <ClientText text={() => timeAgo(c.createdAt)} />}</span>
                              {c.authorEmail === currentUserEmail && !c.id.startsWith("pending-") && (
                                <button type="button" onClick={() => deleteComment(c.id)} className="text-[10.5px]" style={{ color: "var(--ink-muted)" }}>
                                  Delete
                                </button>
                              )}
                            </div>
                          </div>
                          <p className="text-[12.5px] leading-relaxed" style={{ whiteSpace: "pre-wrap" }}>{c.body}</p>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <textarea
                        value={commentDraft}
                        onChange={(e) => setCommentDraft(e.target.value)}
                        placeholder="Leave a comment…"
                        rows={2}
                        className="input flex-1"
                        style={{ fontSize: "12.5px", padding: "6px 9px" }}
                      />
                      <button type="button" disabled={!commentDraft.trim()} onClick={addComment} className="btn btn-secondary btn-sm self-end">
                        Post
                      </button>
                    </div>

                    {canDecideCurrent && (
                      <div>
                        <textarea
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="Add a note (optional)"
                          rows={2}
                          className="input mb-2.5 w-full"
                          style={{ fontSize: "13px", padding: "8px 11px" }}
                        />
                        <button type="button" disabled={isPending} onClick={() => decide("approve")} className="btn btn-primary w-full justify-center">
                          {isPending ? "Working…" : "✓ Mark as done"}
                        </button>
                        <button type="button" disabled={isPending} onClick={() => decide("reject")} className="mt-2 w-full text-center text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
                          {isPending ? "Working…" : "Request changes instead"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {teammates.length > 0 && (
        <div className="flex items-center gap-1.5 rounded-full p-1.5" style={{ background: "var(--surface-2)" }}>
          <select
            value={sendToId}
            onChange={(e) => setSendToId(e.target.value)}
            disabled={isSending}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] font-medium outline-none"
            style={{ padding: "6px 8px", color: "var(--ink)" }}
          >
            {teammates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <button
            type="button"
            disabled={isSending || !sendToId}
            onClick={sendTo}
            aria-label="Send for review"
            className="flex flex-none items-center justify-center rounded-full"
            style={{
              width: 30,
              height: 30,
              background: justSent ? "var(--success)" : "var(--accent-blue)",
              opacity: isSending || !sendToId ? 0.6 : 1,
              transition: "background 0.2s ease-out",
            }}
          >
            {isSending ? <Spinner /> : justSent ? <CheckIcon /> : <SendIcon />}
          </button>
        </div>
      )}
    </div>
  );
}
