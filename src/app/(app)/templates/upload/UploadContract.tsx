"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import SubmitButton from "@/components/SubmitButton";
import { clauseNumbers } from "@/lib/contract";
import { fieldMeta, STANDARD_FIELD_LABELS } from "@/lib/field-meta";
import { addField, buildClauses, keyForName, listFields, otherPlaces, type ReviewClause, type Segment, type TextPick } from "@/lib/template-fields";
import { analyzeUploadedContract, saveUploadedTemplate, type ContractReview } from "./actions";

const MAX_BYTES = 4 * 1024 * 1024;

// While the model reads the contract, the message moves on so the wait
// doesn't look stuck. [ms after the start, message]
const STEPS: [number, string][] = [
  [0, "Reading the contract…"],
  [6_000, "Finding the client's name, fees and dates…"],
  [16_000, "Checking every clause…"],
  [30_000, "Almost done…"],
  [60_000, "Still working. Long contracts can take up to 2 minutes."],
];

// Picking a file is the only step: reading it and finding the fields start
// right away, and the name is fixed up on the review screen if needed.
export default function UploadContract() {
  const [review, setReview] = useState<ContractReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [step, setStep] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Each run gets a number, so a result that comes back after Cancel or a
  // newer file is ignored.
  const run = useRef(0);

  useEffect(() => {
    if (!analyzing) return;
    const timers = STEPS.slice(1).map(([ms], i) => setTimeout(() => setStep(i + 1), ms));
    return () => timers.forEach(clearTimeout);
  }, [analyzing]);

  async function analyze(picked: File) {
    if (!/\.(pdf|docx|txt)$/i.test(picked.name)) {
      setError("Upload a PDF, a Word file (.docx) or a .txt file.");
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError(/\.docx$/i.test(picked.name) ? "This Word file is over 4 MB, usually because of images. Remove them, or upload it as a PDF." : "This file is over 4 MB. Upload the Word version, or export a smaller PDF.");
      return;
    }
    const id = ++run.current;
    setFile(picked);
    setError(null);
    setReview(null);
    setStep(0);
    setAnalyzing(true);
    const data = new FormData();
    data.set("file", picked);
    try {
      const result = await analyzeUploadedContract(data);
      if (id !== run.current) return;
      if (result.ok) setReview(result.review);
      else setError(result.error);
    } catch {
      if (id !== run.current) return;
      setError("We lost the connection while reading your contract. Check your internet and try again.");
    } finally {
      if (id === run.current) setAnalyzing(false);
    }
  }

  function cancel() {
    run.current++;
    setAnalyzing(false);
  }

  function restart() {
    run.current++;
    setReview(null);
    setFile(null);
    setError(null);
    setAnalyzing(false);
  }

  const live = <div className="sr-only" aria-live="polite">{analyzing ? STEPS[step][1] : ""}</div>;

  if (review) {
    return (
      <>
        {live}
        <Review review={review} onRestart={restart} onRetry={file ? () => void analyze(file) : undefined} />
      </>
    );
  }

  if (analyzing) {
    return (
      <>
        {live}
        <Intro />
        <div className="card flex max-w-[560px] items-start gap-4 p-6">
          <Spinner />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px]" style={{ color: "var(--ink-muted)" }} title={file?.name}>{file?.name}</div>
            <div className="mt-1 text-[15px] font-medium">{STEPS[step][1]}</div>
            <div className="mt-1 text-[13px]" style={{ color: "var(--ink-muted)" }}>
              SealMe is finding the parts of your contract that change for each client. This usually takes under a minute.
            </div>
            <button type="button" onClick={cancel} className="btn btn-ghost btn-sm mt-3" style={{ padding: "4px 8px", marginLeft: -8 }}>
              Cancel
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {live}
      <Intro />
      <div className="card flex max-w-[560px] flex-col gap-3 p-4 md:p-5">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const picked = e.dataTransfer.files[0];
            if (picked) void analyze(picked);
          }}
          className="flex cursor-pointer flex-col items-center gap-2.5 rounded-[14px] border border-dashed px-5 py-10 text-center transition-colors focus-within:[outline:2px_solid_var(--accent-blue)] focus-within:[outline-offset:2px]"
          style={{ borderColor: dragging ? "var(--accent-blue)" : "var(--hairline)", background: dragging ? "var(--canvas)" : undefined }}
        >
          <input
            id="upload-file"
            type="file"
            accept=".pdf,.docx,.txt"
            className="sr-only"
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = "";
              if (picked) void analyze(picked);
            }}
          />
          <span className="text-[15px] font-medium">
            <span className="hidden md:inline">Drop your contract here</span>
            <span className="md:hidden">Add your contract</span>
          </span>
          <span className="max-w-[400px] text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            PDF, Word (.docx) or text file, up to 4 MB. A blank template or a contract you already used with a client.
          </span>
          <span className="btn btn-primary btn-sm mt-1">Choose a file</span>
        </label>

        {error && (
          <div className="chip chip-warn flex-wrap items-center gap-x-3 gap-y-1.5 whitespace-normal px-3.5 py-2.5 text-[13px]" role="alert" style={{ borderRadius: "var(--r-md)" }}>
            <span>{error}</span>
            {file && (
              <button type="button" onClick={() => void analyze(file)} className="font-medium underline underline-offset-2">
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// A clause's segments in runs of contract text and of the file's signature
// block, each run shown as its own paragraph. Whitespace at the edges of a
// run is trimmed for display only.
// lead: how much was trimmed off the front of a text segment, so a place
// picked in the page maps back to the segment's own text.
type RunItem = { seg: Segment; j: number; lead: number };
type Run = { signature: boolean; first: boolean; items: RunItem[] };

function toRuns(segments: Segment[], prevSignature: boolean): Run[] {
  const runs: Run[] = [];
  segments.forEach((seg, j) => {
    const signature = Boolean(seg.signature);
    const last = runs[runs.length - 1];
    if (last && last.signature === signature) last.items.push({ seg, j, lead: 0 });
    else runs.push({ signature, first: signature && !(last ? last.signature : prevSignature), items: [{ seg, j, lead: 0 }] });
  });
  for (const run of runs) {
    const head = run.items[0];
    if (head.seg.kind === "text") {
      const text = head.seg.text.trimStart();
      head.lead = head.seg.text.length - text.length;
      head.seg = { ...head.seg, text };
    }
    const tail = run.items[run.items.length - 1];
    if (tail.seg.kind === "text") tail.seg = { ...tail.seg, text: tail.seg.text.trimEnd() };
  }
  return runs;
}

// Words picked in the contract to make a field, or why they can't be.
type Pick = ({ at: TextPick; words: string } | { note: string }) & { top: number; left: number };

const WORD = /[\p{L}\p{N}]/u;
const MAX_PICK = 400;

// A pick grown to whole words, without the spaces, commas or the sentence's
// full stop at its edges (a company's "Inc." keeps its dot).
function tidyPick(text: string, start: number, end: number): [number, number] {
  while (start > 0 && WORD.test(text[start - 1]) && WORD.test(text[start])) start--;
  while (end < text.length && WORD.test(text[end - 1]) && WORD.test(text[end] ?? "")) end++;
  while (start < end && /[\s,;:]/.test(text[start])) start++;
  while (end > start && /[\s,;:!?]/.test(text[end - 1])) end--;
  if (end > start && text[end - 1] === "." && !/\b(?:Inc|Ltd|Corp|Co|Jr|Sr|St|No|L\.L\.C|N\.A|P\.C|U\.S)\.$/i.test(text.slice(start, end))) end--;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

// The text segment a node of the page shows, from its data-seg mark.
function segmentOf(node: Node | null): { el: HTMLElement; clause: number; segment: number; lead: number } | null {
  const from = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node instanceof Element ? node : null;
  const el = from?.closest<HTMLElement>("[data-seg]");
  if (!el?.dataset.seg) return null;
  const [clause, segment, lead] = el.dataset.seg.split(":").map(Number);
  return { el, clause, segment, lead };
}

function Review({ review, onRestart, onRetry }: { review: ContractReview; onRestart: () => void; onRetry?: () => void }) {
  const [clauses, setClauses] = useState<ReviewClause[]>(review.clauses);
  const [pick, setPick] = useState<Pick | null>(null);
  const [naming, setNaming] = useState(false);
  const docRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const clausesRef = useRef(clauses);
  useEffect(() => {
    clausesRef.current = clauses;
  }, [clauses]);
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  // The file's own signature block is left out unless the user keeps it.
  const [keepSignature, setKeepSignature] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const [name, setName] = useState(review.name);
  const [announce, setAnnounce] = useState("");
  const [saveState, saveAction] = useActionState(saveUploadedTemplate, null);
  const heading = useRef<HTMLHeadingElement>(null);

  // The screen changed under the person; tell a screen reader where they are.
  useEffect(() => heading.current?.focus(), []);

  const hasSignature = useMemo(() => clauses.some((c) => c.segments.some((s) => s.signature)), [clauses]);
  const dropSignature = hasSignature && !keepSignature;
  const fields = useMemo(() => listFields(clauses, { dropSignature }), [clauses, dropSignature]);
  const clausesJson = useMemo(() => JSON.stringify(buildClauses(clauses, removed, { dropSignature })), [clauses, removed, dropSignature]);

  // Per field: whether any of its places can be taken back out (it covers
  // words from the file) and whether any can't (it was already a
  // {placeholder} in the file, so there are no words to put back).
  const kinds = useMemo(() => {
    const map = new Map<string, { removable: boolean; locked: boolean }>();
    for (const c of clauses) {
      for (const s of c.segments) {
        if (s.kind !== "field" || (dropSignature && s.signature)) continue;
        const k = map.get(s.key) ?? { removable: false, locked: false };
        if (s.original === null) k.locked = true;
        else k.removable = true;
        map.set(s.key, k);
      }
    }
    return map;
  }, [clauses, dropSignature]);

  // Each clause as runs of text and signature block, numbered as in the file.
  const numbers = useMemo(() => clauseNumbers(clauses), [clauses]);
  const layout = useMemo(() => {
    const out: Run[][] = [];
    for (const c of clauses) {
      const before = out.findLast((runs) => runs.length > 0);
      out.push(toRuns(c.segments, before ? before[before.length - 1].signature : false));
    }
    return out;
  }, [clauses]);

  const label = (key: string) => fieldMeta(key).label;
  const isKept = (key: string, set: Set<string>) => kinds.get(key)?.locked || !set.has(key);
  const total = fields.length;
  const kept = fields.filter((f) => isKept(f.key, removed)).length;
  const removedCount = fields.filter((f) => kinds.get(f.key)?.removable && removed.has(f.key)).length;

  function toggle(key: string) {
    if (!kinds.get(key)?.removable) return;
    const next = new Set(removed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setRemoved(next);
    const left = fields.filter((f) => isKept(f.key, next)).length;
    setAnnounce(`${label(key)} ${next.has(key) ? "removed" : "restored"}. ${left} of ${total} fields kept.`);
  }

  function toggleSignature() {
    const keep = !keepSignature;
    setKeepSignature(keep);
    const now = listFields(clauses, { dropSignature: !keep }).filter((f) => isKept(f.key, removed)).length;
    setAnnounce(`Your file's signature block ${keep ? "kept" : "removed"}. ${now} ${now === 1 ? "field" : "fields"}.`);
  }

  function show(key: string) {
    setHover(key);
    document.querySelector(`[data-field="${key}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function showSignature() {
    document.querySelector("[data-signature]")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Selecting words in the contract offers to make them a field. Only plain
  // text between fields can be picked; a selection across a field or a
  // heading says so instead.
  useEffect(() => {
    function onSelectionChange() {
      const sel = document.getSelection();
      const doc = docRef.current;
      if (!sel || sel.isCollapsed || !sel.rangeCount || !doc) return;
      const range = sel.getRangeAt(0);
      if (!doc.contains(range.commonAncestorContainer) || popRef.current?.contains(range.commonAncestorContainer)) return;
      const box = doc.getBoundingClientRect();
      const rect = range.getBoundingClientRect();
      const place = { top: rect.bottom - box.top + 8, left: Math.max(8, Math.min(rect.left - box.left, box.width - 316)) };
      const a = segmentOf(sel.anchorNode);
      const b = segmentOf(sel.focusNode);
      if (!a || !b || a.el !== b.el || sel.anchorNode !== sel.focusNode || sel.anchorNode?.nodeType !== Node.TEXT_NODE) {
        if (a || b) setPick({ note: "Select words between the blue fields, not across one.", ...place });
        return;
      }
      const seg = clausesRef.current[a.clause]?.segments[a.segment];
      if (!seg || seg.kind !== "text") return;
      const [start, end] = tidyPick(seg.text, a.lead + Math.min(sel.anchorOffset, sel.focusOffset), a.lead + Math.max(sel.anchorOffset, sel.focusOffset));
      if (end <= start) return;
      if (end - start > MAX_PICK) {
        setPick({ note: "That's a lot for one field. Select just the part that changes for each client.", ...place });
        return;
      }
      setPick({ at: { clause: a.clause, segment: a.segment, start, end }, words: seg.text.slice(start, end), ...place });
    }
    // A click anywhere else, or Escape, puts it away.
    function onPointerDown(e: PointerEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      setPick(null);
      setNaming(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setPick(null);
      setNaming(false);
    }
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  // Returns why the field couldn't be added, for the form to show.
  function addPicked(fieldName: string, everywhere: boolean): string | null {
    if (!pick || !("at" in pick)) return null;
    const key = keyForName(fieldName, [...fields, ...STANDARD_FIELD_LABELS]);
    if (!key) return "Give the field a name, like Setup fee.";
    const next = addField(clauses, key, pick.at, everywhere);
    setClauses(next);
    if (removed.has(key)) {
      const r = new Set(removed);
      r.delete(key);
      setRemoved(r);
    }
    setPick(null);
    setNaming(false);
    document.getSelection()?.removeAllRanges();
    const count = listFields(next, { dropSignature }).length;
    setAnnounce(`${label(key)} added. ${count} ${count === 1 ? "field" : "fields"}.`);
    setHover(key);
    return null;
  }

  const suggestions = useMemo(() => [...new Set([...fields.map((f) => f.label), ...STANDARD_FIELD_LABELS.map((f) => f.label)])], [fields]);

  const title = !review.autoFound ? "We couldn't look for fields this time" : total ? `We found ${total} ${total === 1 ? "field" : "fields"}` : "We didn't find any fields";
  const sub = !review.autoFound
    ? "Try again, or select the words that change for each client to make them fields, so SealMe knows what to fill in from the call."
    : total
      ? "Blue fields change for each client, and SealMe fills them in from the call. Tap one to remove it, or select other words to add one."
      : "Every part of this contract looks the same for each client. Select words that should come from the call to make them fields, or save it as it is.";

  return (
    <>
      <div className="sr-only" aria-live="polite">{announce}</div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 max-w-[640px]">
          <h1 ref={heading} tabIndex={-1} className="text-[25px] font-medium outline-none" style={{ letterSpacing: "-0.8px" }}>{title}</h1>
          <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>{sub}</div>
        </div>
        <span className="chip chip-neutral min-w-0 max-w-full" title={review.fileName}>
          <span className="truncate">{review.fileName}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* First in the page so on a phone the list and Save come before a
            long contract; on a wide screen it sits to the right. */}
        <form action={saveAction} className="card flex flex-col gap-3 p-5 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1">
          <input type="hidden" name="fileName" value={review.fileName} />
          <input type="hidden" name="summary" value={review.summary ?? ""} />
          <input type="hidden" name="clausesJson" value={clausesJson} />
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }}>Template name</span>
            <input name="name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className="input" />
          </label>
          <SubmitButton className="btn btn-primary w-full justify-center" pendingText="Saving…">
            {kept > 0 ? `Save template with ${kept} ${kept === 1 ? "field" : "fields"}` : "Save without fields"}
          </SubmitButton>
          {saveState?.error && (
            <div className="chip chip-warn whitespace-normal px-3 py-2 text-[12.5px]" role="alert" style={{ borderRadius: "var(--r-md)" }}>
              {saveState.error}
            </div>
          )}

          {total > 0 && (
            <div className="mt-1 flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[14px] font-medium">Fields</span>
                <span className="font-mono-tab text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
                  {removedCount ? `${removedCount} removed` : `${total} found`}
                </span>
              </div>
              <ul className="-mx-2 flex flex-col lg:max-h-[calc(100dvh-440px)] lg:overflow-y-auto">
                {fields.map((f) => {
                  const off = !isKept(f.key, removed) || (removed.has(f.key) && !!kinds.get(f.key)?.removable);
                  return (
                    <li key={f.key} onMouseEnter={() => setHover(f.key)} onMouseLeave={() => setHover(null)}
                      className="flex items-start gap-2 rounded-[10px] px-2 py-2"
                      style={{ background: hover === f.key ? "var(--surface-2)" : "transparent" }}>
                      <button type="button" onClick={() => show(f.key)} onFocus={() => setHover(f.key)} onBlur={() => setHover(null)} className="min-w-0 flex-1 text-left">
                        <span className="block text-[13.5px] font-medium" style={{ color: off ? "var(--ink-muted)" : "var(--ink)", textDecoration: off ? "line-through" : "none" }}>{f.label}</span>
                        <span className="block truncate text-[12px]" style={{ color: "var(--ink-muted)" }} title={f.sample ?? undefined}>
                          {f.sample ? `“${f.sample}”` : "Already a field in your file"}
                          {f.places > 1 ? ` · ${f.places} places` : ""}
                        </span>
                      </button>
                      {kinds.get(f.key)?.removable && (
                        <button type="button" onClick={() => toggle(f.key)} className="btn btn-ghost btn-sm shrink-0" style={{ padding: "4px 8px" }} aria-label={`${off ? "Restore" : "Remove"} ${f.label}`}>
                          {off ? "Restore" : "Remove"}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {hasSignature && (
            <div className="-mx-2 flex items-start gap-2 rounded-[10px] px-2 py-2" style={{ background: "var(--surface-2)" }}>
              <button type="button" onClick={showSignature} className="min-w-0 flex-1 text-left">
                <span className="block text-[13.5px] font-medium">Signature block</span>
                <span className="block text-[12px]" style={{ color: "var(--ink-muted)" }}>
                  {keepSignature ? "Your file's own, kept next to SealMe's" : "Your file's own is removed. SealMe adds its own."}
                </span>
              </button>
              <button type="button" onClick={toggleSignature} className="btn btn-ghost btn-sm shrink-0" style={{ padding: "4px 8px" }} aria-label={keepSignature ? "Remove your file's signature block" : "Keep your file's signature block"}>
                {keepSignature ? "Remove" : "Keep"}
              </button>
            </div>
          )}

          {review.autoFound && (review.dropped > 0 || total > 0) && (
            <p className="text-[12px] leading-[1.5]" style={{ color: "var(--ink-muted)" }}>
              {review.dropped > 0
                ? `${review.dropped} more ${review.dropped === 1 ? "place looked" : "places looked"} client-specific but couldn't be marked. Read through the text, and select anything we missed to make it a field.`
                : "Missing one? Select its words in the contract to make it a field."}
            </p>
          )}

          <div className="flex flex-col gap-1 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
            {!review.autoFound && onRetry && (
              <button type="button" onClick={onRetry} className="btn btn-secondary w-full justify-center">
                Find fields again
              </button>
            )}
            <button type="button" onClick={onRestart} className="btn btn-ghost w-full justify-center">
              Upload a different file
            </button>
            <Link href="/templates" className="py-1 text-center text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
              Cancel
            </Link>
          </div>
        </form>

        <div ref={docRef} className="card relative min-w-0 px-5 py-7 md:px-[46px] md:py-[42px] lg:col-start-1 lg:row-start-1">
          <div className="mb-6 text-[19px] font-medium" style={{ letterSpacing: "-0.4px" }}>{name || review.name}</div>
          {pick && (
            <div ref={popRef} role="dialog" aria-label="Make a field" className="absolute z-20 w-[300px] max-w-[calc(100%-16px)] rounded-[12px] p-2.5"
              style={{ top: pick.top, left: pick.left, background: "var(--surface-1)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-pop)" }}
              // Keeps the words selected while the buttons are pressed.
              onMouseDown={(e) => {
                if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
              }}>
              {"note" in pick ? (
                <p className="px-1 text-[12.5px] leading-[1.5]" style={{ color: "var(--ink-muted)" }}>{pick.note}</p>
              ) : naming ? (
                <NameField
                  key={`${pick.at.clause}:${pick.at.segment}:${pick.at.start}`}
                  words={pick.words}
                  others={otherPlaces(clauses, pick.words, { dropSignature })}
                  suggestions={suggestions}
                  onAdd={addPicked}
                  onCancel={() => {
                    setPick(null);
                    setNaming(false);
                  }}
                />
              ) : (
                <button type="button" onClick={() => setNaming(true)} className="btn btn-primary btn-sm w-full min-w-0 justify-center">
                  <span className="truncate">Make “{pick.words}” a field</span>
                </button>
              )}
            </div>
          )}
          {clauses.map((clause, i) => {
            const runs = layout[i];
            // A clause that is nothing but signature block shows its heading
            // inside the block, since it goes with it.
            const allSignature = runs.length > 0 && runs.every((r) => r.signature);
            const titleEl = clause.title && (
              <h3 className="mb-1.5 flex gap-2 text-[14px] font-semibold">
                {numbers[i] && <span className="font-mono-tab font-normal" style={{ color: "var(--ink-muted)" }}>{numbers[i]}</span>}
                {clause.title}
              </h3>
            );
            // Text that can be picked to make a field carries where it is
            // in the clause; the file's removed signature block can't.
            const segment = ({ seg: s, j, lead }: RunItem, inRemovedBlock: boolean) =>
              s.kind === "text" ? (
                <span key={j} data-seg={inRemovedBlock ? undefined : `${i}:${j}:${lead}`}>{s.text}</span>
              ) : inRemovedBlock ? (
                <span key={j}>{s.original ?? label(s.key)}</span>
              ) : (
                <FieldInText key={j} segment={s} label={label(s.key)} removed={removed.has(s.key)} lit={hover === s.key} onToggle={() => toggle(s.key)} onHover={setHover} />
              );
            return (
              <div key={i} className="mb-5 max-w-[66ch] last:mb-0">
                {!allSignature && titleEl}
                {runs.map((run, r) =>
                  run.signature ? (
                    <SignatureBlock key={r} first={run.first} kept={keepSignature} onToggle={toggleSignature} heading={allSignature && r === 0 ? titleEl : null}>
                      {run.items.map((item) => segment(item, !keepSignature))}
                    </SignatureBlock>
                  ) : (
                    <p key={r} className="whitespace-pre-line text-[14px] leading-[1.75]" style={{ color: "var(--ink-muted)" }}>
                      {run.items.map((item) => segment(item, false))}
                    </p>
                  )
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// Naming a field made from picked words. A name that matches a field
// already in the contract adds a place to it. Words that are also elsewhere
// can be marked everywhere at once; on by default for names and emails,
// which mean the same thing wherever they are, off for numbers and periods,
// which often don't ("30 days" to pay, "30 days" to fix a breach).
function NameField({ words, others, suggestions, onAdd, onCancel }: {
  words: string;
  others: number;
  suggestions: string[];
  onAdd: (name: string, everywhere: boolean) => string | null;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [everywhere, setEverywhere] = useState(() => /\p{Lu}|@/u.test(words));
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(onAdd(value, everywhere && others > 0));
      }}
      className="flex flex-col gap-2"
    >
      <div className="truncate px-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }} title={words}>“{words}”</div>
      <label className="flex flex-col gap-1">
        <span className="text-[12px] font-medium">Field name</span>
        <input ref={input} list="upload-field-names" value={value} maxLength={60} placeholder="For example Setup fee" className="input"
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }} />
      </label>
      <datalist id="upload-field-names">
        {suggestions.map((s) => <option key={s} value={s} />)}
      </datalist>
      {others > 0 && (
        <label className="flex items-start gap-2 text-[12.5px] leading-[1.4]">
          <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} className="mt-[2px]" />
          <span>Also the {others} other {others === 1 ? "place" : "places"} with these words</span>
        </label>
      )}
      {error && <div role="alert" className="text-[12px]" style={{ color: "var(--warn)" }}>{error}</div>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary btn-sm flex-1 justify-center">Add field</button>
        <button type="button" onClick={onCancel} className="btn btn-ghost btn-sm">Cancel</button>
      </div>
    </form>
  );
}

// The file's own signature block, shown where it sits. Removed, it's crossed
// out with a way to keep it; kept, it reads like the rest of the contract.
// Only the first piece of a block (it can run over two clauses) says so.
function SignatureBlock({ first, kept, onToggle, heading, children }: {
  first: boolean;
  kept: boolean;
  onToggle: () => void;
  heading: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-signature={first ? "" : undefined} className="my-2 rounded-[12px] px-4 py-3"
      style={{ border: `1px ${kept ? "solid" : "dashed"} var(--hairline)`, background: kept ? "transparent" : "var(--surface-2)" }}>
      {first && (
        <div className="mb-2.5 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-[220px]">
            <div className="text-[13px] font-medium" style={{ color: "var(--ink)" }}>{kept ? "Your file's signature block, kept" : "Your file's signature block, removed"}</div>
            <div className="mt-0.5 text-[12px] leading-[1.5]" style={{ color: "var(--ink-muted)" }}>
              {kept ? "The contract will have this block and SealMe's own signature section." : "SealMe adds its own signature section when you send the contract, so this one would be a second."}
            </div>
          </div>
          <button type="button" onClick={onToggle} className="btn btn-secondary btn-sm shrink-0">
            {kept ? "Remove it" : "Keep it"}
          </button>
        </div>
      )}
      {heading}
      <p className="whitespace-pre-line text-[13.5px] leading-[1.7]"
        style={{ color: "var(--ink-muted)", textDecorationLine: kept ? "none" : "line-through", textDecorationColor: "color-mix(in srgb, var(--ink-muted) 60%, transparent)" }}>
        {children}
      </p>
    </div>
  );
}

// One place a field sits in the contract text.
function FieldInText({ segment, label, removed, lit, onToggle, onHover }: {
  segment: Extract<Segment, { kind: "field" }>;
  label: string;
  removed: boolean;
  lit: boolean;
  onToggle: () => void;
  onHover: (key: string | null) => void;
}) {
  const { key, original } = segment;
  const hoverProps = { onMouseEnter: () => onHover(key), onMouseLeave: () => onHover(null), onFocus: () => onHover(key), onBlur: () => onHover(null) };

  if (original === null) {
    return (
      <span data-field={key} title="Already a field in your file" className="mx-[1px] rounded-[6px] px-1.5 py-[1px] text-[12.5px] font-medium"
        style={{ color: "var(--accent-blue)", border: "1px dashed var(--accent-blue)", boxShadow: lit ? "0 0 0 2px var(--accent-blue)" : "none" }}>
        {label}
      </span>
    );
  }

  if (removed) {
    // The file's own words, back in the sentence. A span so a long passage
    // wraps with the text around it, as a button wouldn't.
    return (
      <span data-field={key} role="button" tabIndex={0} {...hoverProps}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-label={`“${original}”. Removed. Press to make it the ${label} field again.`}
        title={`Click to make this the ${label} field again`}
        className="cursor-pointer rounded-[4px]"
        style={{ color: "var(--ink)", textDecorationLine: "underline", textDecorationStyle: "dotted", textDecorationColor: "var(--ink-muted)", textUnderlineOffset: 3, background: lit ? "var(--surface-2)" : "transparent", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
        {original}
      </span>
    );
  }

  return (
    <button type="button" data-field={key} {...hoverProps} onClick={onToggle}
      aria-label={`${label} field. In your file: “${original}”. Press to remove.`}
      title={`In your file: “${original}”. Click to remove this field`}
      className="mx-[1px] inline rounded-[6px] px-1.5 py-[1px] align-baseline text-[12.5px] font-medium"
      style={{ background: "color-mix(in srgb, var(--accent-blue) 12%, transparent)", color: "var(--accent-blue)", boxShadow: lit ? "0 0 0 2px var(--accent-blue)" : "none" }}>
      {label}
    </button>
  );
}

function Intro() {
  return (
    <div className="mb-6 max-w-[560px]">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Upload a contract</h1>
      <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        SealMe finds the parts that change for each client, like names, fees and dates, and fills them in from your calls. You just confirm them.
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="mt-0.5 flex-none motion-safe:animate-spin" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="var(--hairline)" strokeWidth="2.5" />
      <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" fill="none" stroke="var(--accent-blue)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
