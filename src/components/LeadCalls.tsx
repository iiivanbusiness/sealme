"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import LeadJoinPicker, { type JoinPick } from "@/components/LeadJoinPicker";
import MoreMenu from "@/components/MoreMenu";
import DownloadContractButton from "@/components/DownloadContractButton";
import { noteLines } from "@/lib/note-lines";
import type { SetAsideRow } from "@/lib/call-docs";
import { clientDocumentUrl } from "@/lib/document-links";
import { shareProposalLink } from "@/app/(app)/deals/[id]/share-actions";

// id is null while it's still being written, right after the call's notes.
export type CallDoc = {
  id: string | null;
  label: string;
  chip: string;
  day?: string; // when it got where it is (sent, viewed, signed), else when it was made
  contractId?: string | null; // the document that goes out, once it's made
  ready?: boolean; // made and nothing missing, so it can go out
  hint?: string | null; // why it can't go out yet
  sent?: boolean; // already with the client
};

const COPIED_MS = 1500;

export type LeadCallItem =
  | {
      type: "call";
      id: string;
      n: number | null; // Call 1 is the first call with this lead; null for one set aside
      at: string; // ISO
      day: string; // "Nov 13", on the viewer's calendar
      minutes: number | null;
      who: string | null;
      processing: boolean;
      recording: boolean;
      line: string; // one sentence for the closed row
      summary: string | null;
      notes: string | null;
      painPoints: string[];
      nextStep: string | null;
      transcript: string | null;
      proposal: CallDoc | null;
      contract: CallDoc | null;
      // Couldn't be written up, or nothing was heard: no notes, just what
      // happened and where to fix it (when the rep can).
      setAside: SetAsideRow | null;
    }
  // A proposal or contract made without a call (typed in, the API, an import).
  | { type: "doc"; id: string; at: string; day: string; kind: "proposal" | "contract"; doc: CallDoc & { id: string } };

type Kind = "proposal" | "contract";
const KIND_LABEL: Record<Kind, string> = { proposal: "Proposal", contract: "Contract" };

export function CopyButton({ text, label = "Copy", className = "text-[12px] font-medium" }: { text: () => string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          ?.writeText(text())
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
      className={className}
      style={{ color: "var(--accent-blue)" }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message && !err.message.includes("digest") ? err.message : fallback;
}

const sectionLabel = "text-[11.5px] font-semibold uppercase";
const sectionStyle = { letterSpacing: "0.5px", color: "var(--ink-muted)" };

function Section({ title, copy, children }: { title: string; copy?: () => string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className={sectionLabel} style={sectionStyle}>{title}</span>
        {copy && <CopyButton text={copy} />}
      </div>
      {children}
    </div>
  );
}

function Bullets({ lines }: { lines: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-snug">
      {lines.map((l, i) => (
        <li key={i} className="break-words">{l}</li>
      ))}
    </ul>
  );
}

// What was said: the summary, the key points, what hurts, what's next, and
// the whole transcript folded away at the bottom.
function NotesTab({ call }: { call: Extract<LeadCallItem, { type: "call" }> }) {
  const points = call.notes ? noteLines(call.notes) : [];
  const empty = !call.summary && !points.length && !call.painPoints.length && !call.nextStep;
  return (
    <div className="flex flex-col gap-4">
      {empty && <div className="text-[13px]" style={{ color: "var(--ink-muted)" }}>Nothing was written up for this call.</div>}
      {call.summary && (
        <Section title="Summary">
          <div className="break-words text-[13.5px] leading-relaxed">{call.summary}</div>
        </Section>
      )}
      {points.length > 0 && (
        <Section title="Key points" copy={() => points.map((l) => `- ${l}`).join("\n")}>
          <Bullets lines={points} />
        </Section>
      )}
      {call.painPoints.length > 0 && (
        <Section title="Pain points">
          <Bullets lines={call.painPoints} />
        </Section>
      )}
      {call.nextStep && (
        <Section title="Next step">
          <div className="break-words text-[13px]">{call.nextStep}</div>
        </Section>
      )}
      {call.transcript && (
        <details className="text-[12.5px]">
          <summary className="cursor-pointer select-none font-medium" style={{ color: "var(--ink-muted)" }}>Full transcript</summary>
          <div className="mt-2 max-h-[360px] overflow-y-auto whitespace-pre-wrap break-words rounded-[10px] p-3" style={{ background: "var(--canvas)" }}>
            {call.transcript}
          </div>
        </details>
      )}
    </div>
  );
}

// Where a document is and since when: "Viewed · Nov 13".
function DocState({ doc }: { doc: CallDoc }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className={`chip ${doc.chip}`}>{doc.label}</span>
      {doc.day && <span className="text-[12.5px] tabular-nums" style={{ color: "var(--ink-muted)" }}>{doc.day}</span>}
    </span>
  );
}

// A call's proposal: Open, Send, Copy link and Download PDF, by the same
// rules as the proposal's own page (see ProposalActions). It goes out only
// once nothing is missing, and copying the link of a draft marks it sent.
function ProposalOut({ doc }: { doc: CallDoc & { id: string } }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the browser wouldn't write to the clipboard, so the rep can
  // copy the link by hand.
  const [manualLink, setManualLink] = useState<string | null>(null);
  const ready = Boolean(doc.ready && doc.contractId);

  async function copy() {
    if (!ready || !doc.contractId) return;
    setError(null);
    setManualLink(null);
    const url = clientDocumentUrl(doc.contractId, "proposal");
    // The clipboard write starts before any await: browsers only allow it
    // inside the click itself.
    const write = navigator.clipboard?.writeText(url) ?? Promise.reject(new Error("No clipboard"));
    try {
      await write;
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setManualLink(url);
    }
    // Sharing the link is sending it: a draft is marked sent. One already
    // out only gets its text updated when it changed since (the server
    // checks that), so this page doesn't need to know.
    try {
      const result = await shareProposalLink(doc.id);
      if (result.error) {
        setCopied(false);
        setError(result.error);
        return;
      }
      if (!doc.sent) router.refresh();
    } catch {
      setCopied(false);
      setError("Couldn't mark it as sent. Try again.");
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <DocState doc={doc} />
      <div className="flex flex-wrap items-start gap-2">
        <Link href={`/deals/${doc.id}`} className="btn btn-secondary btn-sm">
          Open proposal
        </Link>
        {ready ? (
          <Link href={`/deals/${doc.id}/send`} className={`btn ${doc.sent ? "btn-secondary" : "btn-primary"} btn-sm`}>
            {doc.sent ? "Send again" : "Send by email"}
          </Link>
        ) : (
          <button type="button" disabled className="btn btn-primary btn-sm">
            Send by email
          </button>
        )}
        <button type="button" onClick={copy} disabled={!ready} className="btn btn-secondary btn-sm">
          {copied ? "Copied" : "Copy link"}
        </button>
        {doc.contractId && <DownloadContractButton contractId={doc.contractId} kind="proposal" className="btn btn-secondary btn-sm" />}
      </div>
      {!ready && doc.hint && (
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          {doc.hint}
        </span>
      )}
      {manualLink && (
        <label className="flex flex-col gap-1">
          <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Copy the link from here:</span>
          <input readOnly value={manualLink} onFocus={(e) => e.currentTarget.select()} className="input w-full min-w-0" style={{ fontSize: "12.5px", padding: "7px 10px" }} />
        </label>
      )}
      {error && <div className="chip chip-warn w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]">{error}</div>}
    </div>
  );
}

// The proposal or contract from this call: where it is and what to do with
// it, or Create when there isn't one yet. A contract goes out from its own
// screen, after review, so here it only opens.
function DocTab({ kind, doc, canCreate, fromProposal, onCreate }: { kind: Kind; doc: CallDoc | null; canCreate: boolean; fromProposal: boolean; onCreate: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const what = KIND_LABEL[kind].toLowerCase();
  if (doc && !doc.id) {
    return (
      <div className="text-[13px]" style={{ color: "var(--ink-muted)" }}>
        SealMe is writing the {what} from this call. It shows here in a minute.
      </div>
    );
  }
  if (doc?.id) {
    if (kind === "proposal") return <ProposalOut doc={{ ...doc, id: doc.id }} />;
    return (
      <div className="flex flex-col gap-3">
        <DocState doc={doc} />
        <Link href={`/deals/${doc.id}`} className="btn btn-secondary btn-sm self-start">
          Open contract
        </Link>
      </div>
    );
  }
  if (!canCreate) {
    return (
      <div className="flex flex-col items-start gap-2 text-[13px]" style={{ color: "var(--ink-muted)" }}>
        No {what} from this call. Add a {what} template first, then make one from the call.
        <Link href={`/templates?kind=${kind}`} className="btn btn-secondary btn-sm">Go to templates</Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-start gap-2.5">
      <div className="text-[13px]" style={{ color: "var(--ink-muted)" }}>
        {fromProposal
          ? pending
            ? "Making the contract from this call's proposal. This takes about half a minute."
            : "No contract from this call yet. SealMe makes one from this call's proposal."
          : pending
            ? `Writing the ${what} from the call. This takes about half a minute.`
            : `No ${what} from this call yet. SealMe can write one from what was said.`}
      </div>
      {error && <div className="chip chip-warn w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]">{error}</div>}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              await onCreate();
            } catch (err) {
              setError(errorText(err, `Couldn't make the ${what}. Try again.`));
            }
          });
        }}
        className="btn btn-primary btn-sm"
      >
        {pending ? (fromProposal ? "Making the contract…" : `Writing the ${what}…`) : `Create ${what}`}
      </button>
    </div>
  );
}

function Badge({ label, chip }: { label: string; chip: string }) {
  return <span className={`chip whitespace-nowrap ${chip}`}>{label}</span>;
}

function CallRow({
  call,
  target,
  phone,
  templates,
  searchLeads,
  moveAction,
  deleteAction,
  createAction,
}: {
  call: Extract<LeadCallItem, { type: "call" }>;
  // The page was opened for this call (e.g. Start a call just saved it).
  target: boolean;
  phone: boolean;
  templates: Record<Kind, boolean>;
  searchLeads: (q: string) => Promise<JoinPick[]>;
  moveAction: (callId: string, leadId: string) => Promise<{ leadId: string }>;
  deleteAction: (callId: string) => Promise<{ error?: string }>;
  createAction: (callId: string, kind: Kind) => Promise<{ dealId?: string; error?: string }>;
}) {
  const router = useRouter();
  // Not opened, moved or deleted until it's written up: while it records,
  // the bar at the top has Stop and Discard.
  const busy = call.processing || call.recording;
  // A set-aside call has no notes to open, and can't be moved (only a call
  // with notes can), but can be deleted.
  const setAside = call.setAside;
  const [open, setOpen] = useState(target && !busy && !setAside);
  // The call the page was opened for, still being written up when it loaded:
  // it opens by itself once its notes are in (the page re-reads itself).
  const [wasBusy, setWasBusy] = useState(busy);
  if (wasBusy !== busy) {
    setWasBusy(busy);
    if (target && !busy && !setAside) setOpen(true);
  }
  const [tab, setTab] = useState<"notes" | Kind>("notes");
  const [panel, setPanel] = useState<"move" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!target) return;
    // After the page's own scroll on arrival, so this one wins. Only when
    // the call's top isn't already on screen: a call near the top stays put,
    // with the "Call saved" notice above it still in view.
    const id = requestAnimationFrame(() => {
      const el = row.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      if (top < 0 || top > window.innerHeight - 120) el.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(id);
  }, [target]);
  const name = call.n ? `Call ${call.n}` : "Call";
  const head = [name, call.day, call.minutes ? `${call.minutes} min` : null].filter(Boolean).join(" · ");
  const hasNotes = Boolean(call.summary || call.notes);
  // A proposal or contract already made on a call that can't be opened yet
  // (or has nothing to open) still opens from its row.
  const docLinks = (filling: boolean) =>
    !phone &&
    (["proposal", "contract"] as const).map((kind) => {
      const doc = call[kind];
      if (!doc?.id) return null;
      return (
        <Link key={kind} href={`/deals/${doc.id}`} className="chip chip-neutral whitespace-nowrap" style={{ color: "var(--accent-blue)" }}>
          {KIND_LABEL[kind]}: {filling ? "filling in" : doc.label}
        </Link>
      );
    });

  async function create(kind: Kind) {
    const result = await createAction(call.id, kind);
    if (result.error) throw new Error(result.error);
    if (result.dealId) router.push(`/deals/${result.dealId}`);
  }

  return (
    <div ref={row} className="flex scroll-mt-4 flex-col" style={{ borderTop: "1px solid var(--hairline-soft)" }}>
      <div className="flex items-start gap-2 py-3">
        {setAside ? (
          // Couldn't be written up, or nothing was heard: what happened, and
          // where to fix it.
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <span className="flex w-full items-center gap-2">
              <span className="text-[13.5px] font-medium tabular-nums" style={{ color: "var(--ink)" }}>{head}</span>
              {call.who && <span className="hidden truncate text-[12.5px] sm:inline" style={{ color: "var(--ink-muted)" }}>{call.who}</span>}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-0.5">
              <span className={`chip whitespace-nowrap ${setAside.chip}`}>{setAside.label}</span>
              {setAside.reason && <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{setAside.reason}</span>}
              {setAside.fix && (
                <Link href={setAside.fix.href} className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
                  {setAside.fix.label}
                </Link>
              )}
              {docLinks(false)}
            </span>
          </div>
        ) : busy ? (
          // Still recording or being written up: nothing to open yet, but a
          // proposal or contract already made on it opens from here.
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <span className="flex w-full items-center gap-2">
              <span className="text-[13.5px] font-medium tabular-nums" style={{ color: "var(--ink)" }}>{head}</span>
              {call.who && <span className="hidden truncate text-[12.5px] sm:inline" style={{ color: "var(--ink-muted)" }}>{call.who}</span>}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {call.recording ? (
                <span className="chip chip-success inline-flex items-center gap-1.5">
                  <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "currentColor" }} />
                  Recording now
                </span>
              ) : (
                <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>Writing up the notes…</span>
              )}
              {docLinks(call.recording)}
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
          >
            <span className="flex w-full items-center gap-2">
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className="flex-none transition-transform" style={{ transform: open ? "rotate(90deg)" : undefined, color: "var(--ink-muted)" }}>
                <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-[13.5px] font-medium tabular-nums" style={{ color: "var(--ink)" }}>{head}</span>
              {call.who && <span className="hidden truncate text-[12.5px] sm:inline" style={{ color: "var(--ink-muted)" }}>{call.who}</span>}
            </span>
            {call.line && <span className="line-clamp-2 break-words text-[13px]" style={{ color: "var(--ink)" }}>{call.line}</span>}
            <span className="flex flex-wrap gap-1.5 pt-0.5">
              {hasNotes && <Badge label="Notes" chip="chip-neutral" />}
              {!phone && call.proposal && <Badge label={`Proposal: ${call.proposal.label}`} chip={call.proposal.chip} />}
              {!phone && call.contract && <Badge label={`Contract: ${call.contract.label}`} chip={call.contract.chip} />}
            </span>
          </button>
        )}
        {!busy && (
          <MoreMenu
            size="sm"
            label={`More for ${name.toLowerCase()}`}
            items={[
              ...(setAside ? [] : [{ label: "Move to another lead", onSelect: () => (setPanel("move"), setError(null)) }]),
              { label: "Delete call", danger: true, onSelect: () => (setPanel("delete"), setError(null)) },
            ]}
          />
        )}
      </div>

      {panel === "move" && (
        <div className="pb-3">
          <LeadJoinPicker
            search={searchLeads}
            newOption="+ New lead from this call"
            confirmText={(pick) => (pick === "new" ? "Move this call to a new lead, filled in from the call?" : `Move this call to ${pick.name}${pick.company ? ` at ${pick.company}` : ""}?`)}
            confirmLabel="Move call"
            onConfirm={async (pick) => {
              const { leadId } = await moveAction(call.id, pick === "new" ? "new" : pick.id);
              router.push(`/leads/${leadId}`);
            }}
            onCancel={() => setPanel(null)}
          />
        </div>
      )}

      {panel === "delete" && (
        <div className="mb-3 flex flex-col gap-2.5 rounded-[12px] p-3 text-[13px]" style={{ background: "var(--canvas)" }}>
          <div>
            Delete {call.n ? `call ${call.n} and its notes` : "this call"}? A draft proposal or contract from it goes to the trash. This can&apos;t be undone.
          </div>
          {error && <div className="chip chip-warn w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]">{error}</div>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  setError(null);
                  try {
                    const result = await deleteAction(call.id);
                    if (result.error) setError(result.error);
                    else setPanel(null);
                  } catch (err) {
                    setError(errorText(err, "Couldn't delete the call. Try again."));
                  }
                })
              }
              className="btn btn-sm"
              style={{ background: "#c0392b", color: "#fff" }}
            >
              {pending ? "Deleting…" : "Delete call"}
            </button>
            <button type="button" disabled={pending} onClick={() => setPanel(null)} className="btn btn-ghost btn-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {open && (
        <div className="mb-3 flex flex-col gap-4 rounded-[12px] border p-4" style={{ borderColor: "var(--hairline)" }}>
          {/* Proposals and contracts aren't in the iPhone app. */}
          {!phone && (
            <div className="flex gap-1 overflow-x-auto" role="tablist" aria-label={name}>
              {(["notes", "proposal", "contract"] as const).map((t) => {
                const doc = t === "proposal" ? call.proposal : t === "contract" ? call.contract : null;
                return (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    onClick={() => setTab(t)}
                    className="btn btn-sm flex-none gap-1.5"
                    style={tab === t ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
                  >
                    {t === "notes" ? "Notes" : KIND_LABEL[t]}
                    {doc && <span style={{ opacity: 0.75 }}>· {doc.label}</span>}
                  </button>
                );
              })}
            </div>
          )}
          {tab === "notes" || phone ? (
            <NotesTab call={call} />
          ) : (
            <DocTab
              key={tab}
              kind={tab}
              doc={tab === "proposal" ? call.proposal : call.contract}
              canCreate={templates[tab]}
              // The contract carries on from this call's proposal (see createFromCall).
              fromProposal={tab === "contract" && Boolean(call.proposal?.id)}
              onCreate={() => create(tab)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Every call with the lead, newest on top and closed, so the list reads
// like a timeline; open one for its notes, proposal and contract.
export default function LeadCalls({
  items,
  openCallId = null,
  phone,
  templates,
  searchLeads,
  moveAction,
  deleteAction,
  createAction,
}: {
  items: LeadCallItem[];
  // The call to open and scroll to when the page loads (?call= in the link).
  openCallId?: string | null;
  phone: boolean;
  templates: Record<Kind, boolean>;
  searchLeads: (q: string) => Promise<JoinPick[]>;
  moveAction: (callId: string, leadId: string) => Promise<{ leadId: string }>;
  deleteAction: (callId: string) => Promise<{ error?: string }>;
  createAction: (callId: string, kind: Kind) => Promise<{ dealId?: string; error?: string }>;
}) {
  const calls = items.filter((i) => i.type === "call").length;
  const shown = phone ? items.filter((i) => i.type === "call") : items;
  return (
    <div className="card flex min-w-0 flex-col px-5 pt-4 sm:px-6">
      <div className="flex items-baseline justify-between gap-2 pb-3">
        <div className="text-[14px] font-medium">
          Calls{calls > 1 && <span className="font-normal" style={{ color: "var(--ink-muted)" }}> · {calls}</span>}
        </div>
      </div>
      {shown.length === 0 && (
        <div className="pb-4 text-[13px]" style={{ color: "var(--ink-muted)", borderTop: "1px solid var(--hairline-soft)", paddingTop: 12 }}>
          No calls yet. Calls you start with {phone ? "this lead" : "this lead, from Start a call or the desktop app,"} show up here with their notes.
        </div>
      )}
      <div className="flex flex-col pb-1">
        {shown.map((item) =>
          item.type === "call" ? (
            <CallRow
              key={item.id}
              call={item}
              target={item.id === openCallId}
              phone={phone}
              templates={templates}
              searchLeads={searchLeads}
              moveAction={moveAction}
              deleteAction={deleteAction}
              createAction={createAction}
            />
          ) : (
            <div key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3" style={{ borderTop: "1px solid var(--hairline-soft)" }}>
              <span className="text-[13.5px] font-medium tabular-nums">
                {KIND_LABEL[item.kind]} · {item.day}
              </span>
              <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>Made without a call</span>
              <span className="flex items-center gap-2 sm:ml-auto">
                <Badge label={item.doc.label} chip={item.doc.chip} />
                <Link href={`/deals/${item.doc.id}`} className="btn btn-secondary btn-sm">Open</Link>
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
