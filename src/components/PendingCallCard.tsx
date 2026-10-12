"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type LeadOption = { id: string; name: string; detail: string };
type PendingCall = {
  id: string;
  status: string; // pending | processing | failed
  when: string;
  duration: string | null;
  source: string;
  rep: string | null;
  transcript: string;
  // A phone call is transcribed only when it's processed.
  awaitingTranscript: boolean;
  leadId: string | null;
  mode: string; // cold | sales when already known, else SealMe decides
};

const PREVIEW_LINES = 4;
const MATCHES_SHOWN = 8;

// One call in the Calls inbox: say what it should become (notes only, or
// notes and a contract), pick who it was with (or let the call make a new
// lead), then Process or Discard. notesOnly (the iPhone app, which has no
// contracts) leaves out the choice.
export default function PendingCallCard({
  call,
  leads,
  processAction,
  discardAction,
  notesOnly = false,
}: {
  call: PendingCall;
  leads: LeadOption[];
  processAction: (input: { leadId: string; mode?: string }) => Promise<void>;
  discardAction: () => Promise<void>;
  notesOnly?: boolean;
}) {
  const router = useRouter();
  const wantsContract = call.mode === "sales" && !notesOnly;
  // Notes only: SealMe finds the client's lead from the call by default.
  const [leadId, setLeadId] = useState(call.leadId ?? (wantsContract ? "" : "new"));
  // Most calls only need notes; a contract is the exception.
  const [need, setNeed] = useState<"notes" | "contract">(wantsContract ? "contract" : "notes");
  const isNew = leadId === "new";
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const selected = isNew ? { id: "new", name: "Find it from the call", detail: "the client's lead, or a new one" } : (leads.find((l) => l.id === leadId) ?? null);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? leads.filter((l) => l.name.toLowerCase().includes(q) || l.detail.toLowerCase().includes(q)) : leads;
    return list.slice(0, MATCHES_SHOWN);
  }, [leads, query]);

  const lines = call.transcript.split("\n").filter(Boolean);
  const shown = showAll ? lines : lines.slice(0, PREVIEW_LINES);
  const processing = call.status === "processing";

  function run(action: () => Promise<void>) {
    setError(null);
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong. Try again");
      }
    });
  }

  return (
    <div className="card flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <span className="font-medium">{call.when}</span>
        <span style={{ color: "var(--ink-muted)" }}>{[call.duration, call.source, call.rep].filter(Boolean).join(" · ")}</span>
        {processing && <span className="chip chip-neutral ml-auto">Processing…</span>}
        {call.status === "failed" && <span className="chip chip-warn ml-auto">Processing failed. Try again</span>}
      </div>

      {call.awaitingTranscript && (
        <div className="rounded-[12px] px-3.5 py-2.5 text-[12.5px]" style={{ background: "var(--canvas)", color: "var(--ink-muted)" }}>
          Recorded call. SealMe writes it out when you process it.
        </div>
      )}

      {lines.length > 0 && (
        <div className="rounded-[12px] px-3.5 py-2.5 text-[12.5px] leading-relaxed" style={{ background: "var(--canvas)", color: "var(--ink-muted)" }}>
          {shown.map((l, i) => (
            <div key={i} className="break-words">{l}</div>
          ))}
          {lines.length > PREVIEW_LINES && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="mt-1 font-medium" style={{ color: "var(--accent-blue)" }}>
              {showAll ? "Show less" : `Show all ${lines.length} lines`}
            </button>
          )}
        </div>
      )}

      {!processing && (
        <>
          <div className="flex flex-wrap items-end gap-2.5">
            {!notesOnly && (
              <div className="flex-none">
                <span className="mb-1 block text-[12px]" style={{ color: "var(--ink-muted)" }}>What you need</span>
                <div className="flex rounded-full p-[3px] text-[12.5px]" style={{ background: "var(--surface-2)" }} role="radiogroup" aria-label="What you need">
                  {(["notes", "contract"] as const).map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={need === n}
                      onClick={() => setNeed(n)}
                      className="rounded-full px-3 py-1.5 font-medium"
                      style={need === n ? { background: "var(--surface-1)", color: "var(--ink)", boxShadow: "0 0 0 1px var(--hairline)" } : { color: "var(--ink-muted)" }}
                    >
                      {n === "notes" ? "Notes only" : "Notes and contract"}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="relative min-w-[220px] flex-1">
              <label className="mb-1 block text-[12px]" style={{ color: "var(--ink-muted)" }}>Lead</label>
              {selected && !open ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(true);
                    setQuery("");
                  }}
                  className="input w-full truncate text-left"
                  aria-label="Lead, change"
                >
                  {selected.name}
                  {selected.detail ? <span style={{ color: "var(--ink-muted)" }}> · {selected.detail}</span> : null}
                </button>
              ) : (
                <input
                  autoFocus={open}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setOpen(true);
                  }}
                  onFocus={() => setOpen(true)}
                  onBlur={() => setTimeout(() => setOpen(false), 150)}
                  placeholder={leads.length ? "Search your leads" : "No leads yet"}
                  aria-label="Lead"
                  className="input w-full"
                />
              )}
              {open && (
                <div className="absolute left-0 right-0 z-10 mt-1 overflow-hidden rounded-[12px] border shadow-lg" style={{ background: "var(--surface-1)", borderColor: "var(--hairline)" }}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setLeadId("new");
                      setOpen(false);
                    }}
                    className="block w-full truncate px-3 py-2 text-left text-[13px] font-medium hover:bg-[var(--canvas)]"
                    style={{ color: "var(--accent-blue)", borderBottom: matches.length ? "1px solid var(--hairline-soft)" : undefined }}
                  >
                    + Find it from the call
                  </button>
                  {matches.map((l) => (
                    <button
                      key={l.id}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setLeadId(l.id);
                        setOpen(false);
                      }}
                      className="block w-full truncate px-3 py-2 text-left text-[13px] hover:bg-[var(--canvas)]"
                    >
                      {l.name}
                      {l.detail ? <span style={{ color: "var(--ink-muted)" }}> · {l.detail}</span> : null}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending || !leadId || (isNew && need === "contract")}
              onClick={() => run(() => processAction({ leadId, mode: need === "notes" ? "notes" : "sales" }))}
              className="btn btn-primary btn-sm"
            >
              {pending ? "Working…" : call.status === "failed" ? "Process again" : "Process"}
            </button>
            <button type="button" disabled={pending} onClick={() => run(discardAction)} className="btn btn-secondary btn-sm">
              Discard
            </button>
            {!leadId && <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Pick the lead, or make a new one from the call.</span>}
            {isNew && need === "contract" && <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>For a contract, pick the lead it&apos;s for.</span>}
            {leadId && !(isNew && need === "contract") && (
              <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
                {need === "notes" ? `SealMe writes the notes on the lead and sets up the next step.${notesOnly ? "" : " No contract."}` : "SealMe writes the notes and drafts the contract for you to check."}
              </span>
            )}
          </div>
        </>
      )}
      {error && <div className="chip chip-warn whitespace-normal px-3 py-2 text-left text-[12.5px]">{error}.</div>}
    </div>
  );
}
