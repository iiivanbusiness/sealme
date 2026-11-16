"use client";

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type Ref } from "react";
import LocalDateTime from "@/components/LocalDateTime";
import { clauseNumbers, clauseParts, type Clause, type ClausePart, type ContractTerm } from "./types";
import { clauseHeading, clauseIndexOf, commentsByClause, firstSlots, looksLikeIsoDate, normalizeEditedValue, numberColumnWidth, partiesLine, type PaperComment } from "./paper-utils";
import { docFont } from "./doc-font";
import s from "./contract.module.css";

// The contract drawn as one sheet of paper: the template's clauses with
// every term written in where it goes. During a call the terms fill in as
// they're heard; any term can be clicked and typed over. A sent contract
// is drawn read-only, and preview mode draws what the client gets (blank
// terms as lines to write on, nothing clickable).

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

// Room needed right of the paper for the "Just heard" note to sit beside
// it. With less, the note floats over the text by the term instead, or on
// a phone sits under the clause.
const SIDE_ROOM = 250;
const NO_KEYS: ReadonlySet<string> = new Set();

const PHONE_QUERY = "(max-width: 767px)";
function subscribePhone(onChange: () => void): () => void {
  const mq = window.matchMedia(PHONE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
const phoneNow = () => window.matchMedia(PHONE_QUERY).matches;
const notPhone = () => false;

export type PlainClause = { title: string; body: string; label?: string };
export type PaperSignature = { signerName: string | null; signedAt: string | null; image: string | null };
export type { PaperComment } from "./paper-utils";

export type ContractPaperProps = {
  kind: string;
  agencyName: string;
  partyName: string;
  templateName: string;
  clauses: Clause[];
  // The text exactly as it was sent (the snapshot), drawn as plain text
  // with no fields. Wins over clauses when given.
  plainClauses?: PlainClause[];
  terms: ContractTerm[];
  editable: boolean;
  mode?: "work" | "preview";
  metaText: string;
  metaLive?: boolean;
  heardKey?: string | null;
  heardQuote?: string | null;
  askedKeys?: ReadonlySet<string>;
  editingKey?: string | null;
  onStartEdit?: (key: string) => void;
  // Only called when the value changed. "" clears the term.
  onCommit?: (key: string, value: string) => void;
  onCancel?: () => void;
  signature?: PaperSignature | null;
  // What the client asked to change on the sign page, each shown under the
  // clause it's about (work mode only: never in the preview or the PDF).
  comments?: PaperComment[];
  animateIn?: boolean;
  // Leave room right of the paper on a wide column for the "Just heard"
  // note. Defaults to metaLive.
  sideNotes?: boolean;
  // Scroll the page to a term the moment it's heard (wide screens only,
  // and not while the rep is scrolling or typing). Defaults to metaLive.
  followHeard?: boolean;
};

export default function ContractPaper({
  kind,
  agencyName,
  partyName,
  templateName,
  clauses,
  plainClauses,
  terms,
  editable,
  mode = "work",
  metaText,
  metaLive = false,
  heardKey = null,
  heardQuote = null,
  askedKeys,
  editingKey = null,
  onStartEdit,
  onCommit,
  onCancel,
  signature = null,
  comments,
  animateIn = false,
  sideNotes,
  followHeard,
}: ContractPaperProps) {
  const preview = mode === "preview";
  // Read once: the sheet lands when it first appears, not on every update.
  const [enter] = useState(animateIn);
  const plain = plainClauses !== undefined;
  const proposal = kind === "proposal";
  const shown: PlainClause[] = plainClauses ?? clauses;
  const asked = askedKeys ?? NO_KEYS;

  const numbers = useMemo(() => clauseNumbers(shown), [shown]);
  const numW = useMemo(() => numberColumnWidth(numbers), [numbers]);
  const parts = useMemo<ClausePart[][]>(() => shown.map((c) => (plain ? [{ kind: "text", text: c.body }] : clauseParts(c.body))), [shown, plain]);
  const bodies = useMemo(() => (plain ? [] : clauses.map((c) => c.body)), [clauses, plain]);
  const first = useMemo(() => firstSlots(bodies), [bodies]);
  const byKey = useMemo(() => new Map(terms.map((t) => [t.key, t])), [terms]);
  const notes = useMemo(() => (preview || !comments?.length ? null : commentsByClause(shown, comments)), [preview, comments, shown]);

  // Editing: the place that was clicked, or the first place the term
  // appears when it was picked from the terms list.
  const canEdit = editable && !preview && !plain && !!onStartEdit;
  const [picked, setPicked] = useState<{ key: string; slot: string } | null>(null);
  const editSlot = canEdit && editingKey ? (picked?.key === editingKey ? picked.slot : (first.get(editingKey) ?? null)) : null;

  // Just heard: only a term the call filled in, never one the rep typed.
  const heardTerm = heardKey ? byKey.get(heardKey) : undefined;
  const heardSlot = heardKey ? (first.get(heardKey) ?? null) : null;
  const heardOn = !preview && !plain && !!heardKey && !!heardSlot && heardTerm?.state === "filled" && !!heardTerm.value;
  const hotClause = heardOn && heardKey ? clauseIndexOf(bodies, heardKey) : -1;
  const quote = heardOn && editingKey !== heardKey ? heardQuote?.trim() || null : null;
  const reserveSide = !preview && (sideNotes ?? metaLive);
  const follow = !preview && (followHeard ?? metaLive);

  const wrapRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const [room, setRoom] = useState(0);
  const phone = useSyncExternalStore(subscribePhone, phoneNow, notPhone);
  // Where the note goes: beside the paper when there's room, else over the
  // text by the term (nothing under it moves), and on a phone under the
  // clause.
  const noteMode = !quote ? null : room >= SIDE_ROOM ? "side" : phone ? "inline" : "over";

  // Puts the note by the term after every render and whenever the paper or
  // its column changes size: beside the paper level with it, or just above
  // it (below when the window has no room above) pointing at it.
  const placeNote = useRef<() => void>(() => {});
  useIsoLayoutEffect(() => {
    placeNote.current = () => {
      const wrap = wrapRef.current;
      const paper = paperRef.current;
      const note = noteRef.current;
      if (!wrap || !paper || !note || !heardSlot) return;
      const field = wrap.querySelector<HTMLElement>(`[data-slot="${heardSlot}"]`);
      if (!field) return;
      const wr = wrap.getBoundingClientRect();
      const pr = paper.getBoundingClientRect();
      const r = field.getClientRects()[0] ?? field.getBoundingClientRect();
      if (noteMode === "over") {
        const w = Math.min(270, wr.width - 16);
        note.style.width = `${w}px`;
        const cx = r.left + Math.min(r.width, 160) / 2 - wr.left;
        const left = Math.max(8, Math.min(cx - w / 2, wr.width - w - 8));
        const h = note.offsetHeight;
        const below = r.top - h - 12 < 8;
        note.style.left = `${left}px`;
        note.style.top = `${below ? r.bottom - wr.top + 12 : r.top - wr.top - h - 12}px`;
        note.style.setProperty("--ax", `${Math.max(16, Math.min(cx - left, w - 16))}px`);
        note.toggleAttribute("data-below", below);
        return;
      }
      const line = lineRef.current;
      if (!line) return;
      const midY = r.top + r.height / 2 - wr.top;
      note.style.width = `${Math.min(270, Math.max(180, wr.right - pr.right - 50))}px`;
      note.style.left = `${pr.right - wr.left + 34}px`;
      note.style.top = `${Math.max(0, midY - note.offsetHeight / 2)}px`;
      line.style.left = `${pr.right - wr.left + 6}px`;
      line.style.width = "28px";
      line.style.top = `${midY}px`;
    };
    placeNote.current();
  });
  useEffect(() => {
    const wrap = wrapRef.current;
    const paper = paperRef.current;
    if (!wrap || !paper || preview || typeof ResizeObserver === "undefined") return;
    // Fires once right away, then on every resize (fonts landing included).
    // Subscribed again when the room on the right is reserved or released,
    // which moves the paper without resizing anything.
    const ro = new ResizeObserver(() => {
      const wr = wrap.getBoundingClientRect();
      const pr = paper.getBoundingClientRect();
      setRoom(Math.round(wr.right - pr.right));
      placeNote.current();
    });
    ro.observe(wrap);
    ro.observe(paper);
    return () => ro.disconnect();
  }, [preview, reserveSide]);

  // Follow the call: bring a newly heard term into view, unless the rep
  // scrolled or typed in the last few seconds or is editing.
  const lastInput = useRef(0);
  const editingNow = useRef(editingKey);
  useEffect(() => {
    editingNow.current = editingKey;
  }, [editingKey]);
  useEffect(() => {
    if (!follow) return;
    const mark = () => {
      lastInput.current = Date.now();
    };
    window.addEventListener("wheel", mark, { passive: true });
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("keydown", mark);
    return () => {
      window.removeEventListener("wheel", mark);
      window.removeEventListener("touchmove", mark);
      window.removeEventListener("keydown", mark);
    };
  }, [follow]);
  useEffect(() => {
    if (!follow || !heardOn || !heardSlot || editingNow.current) return;
    if (window.innerWidth < 768 || Date.now() - lastInput.current < 5000) return;
    const field = wrapRef.current?.querySelector<HTMLElement>(`[data-slot="${heardSlot}"]`);
    if (!field || inView(field)) return;
    field.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    // A note over the text picks above or below by where the term was;
    // once the scroll is done there's room above it.
    const id = window.setTimeout(() => placeNote.current(), 500);
    return () => window.clearTimeout(id);
  }, [follow, heardOn, heardSlot, heardKey]);

  // After Enter or Escape, focus goes back to the term that was edited, so
  // the keyboard user stays where they were.
  const refocusSlot = useRef<string | null>(null);
  useEffect(() => {
    if (editingKey || !refocusSlot.current) return;
    const slot = refocusSlot.current;
    refocusSlot.current = null;
    if (document.activeElement && document.activeElement !== document.body) return;
    wrapRef.current?.querySelector<HTMLElement>(`[data-slot="${slot}"]`)?.focus({ preventScroll: true });
  }, [editingKey]);

  const startEdit = (key: string, slot: string) => {
    setPicked({ key, slot });
    onStartEdit?.(key);
  };
  // value is null when nothing changed since the editor opened (compared
  // with that moment, so a term the call fills in meanwhile isn't wiped).
  const finishEdit = (key: string, slot: string, value: string | null, byKeyboard: boolean) => {
    if (byKeyboard) refocusSlot.current = slot;
    setPicked(null);
    if (value === null) onCancel?.();
    else onCommit?.(key, value);
  };

  const renderField = (key: string, slot: string) => {
    const term = byKey.get(key);
    const label = term?.label || key;
    const value = term?.value?.trim() ? term.value : null;
    const empty = !term || term.state === "empty" || !value;

    if (preview) {
      return empty ? (
        <span key={slot} className={s.blank} data-field-key={key} aria-hidden="true" />
      ) : (
        <span key={slot} className={s.pv} data-field-key={key}>
          {value}
        </span>
      );
    }

    if (slot === editSlot) {
      return <FieldEditor key={slot} slot={slot} fieldKey={key} label={label} initial={empty ? "" : (value ?? "")} onDone={(v, byKeyboard) => finishEdit(key, slot, v, byKeyboard)} />;
    }

    const isAsked = empty && asked.has(key);
    const isHeard = !empty && heardOn && key === heardKey;
    const className = [s.f, empty ? s.empty : term.state === "edited" ? s.edited : s.filled, isAsked ? s.asked : "", isHeard ? s.heard : ""].filter(Boolean).join(" ");
    const source = !empty && term.state === "filled" && term.sourceQuote ? `Heard: “${term.sourceQuote}”` : null;
    const tip = empty
      ? canEdit
        ? `${label}: not heard yet. Click to type it.`
        : label
      : term.state === "edited"
        ? canEdit
          ? "Typed by you. Click to edit."
          : "Typed by you."
        : [source, canEdit ? "Click to edit." : null].filter(Boolean).join(" ") || undefined;

    if (!canEdit) {
      return (
        <span key={slot} className={className} data-field-key={key} data-slot={slot} title={tip}>
          {empty ? label : value}
        </span>
      );
    }
    return (
      <span
        key={slot}
        className={className}
        data-field-key={key}
        data-slot={slot}
        data-click=""
        role="button"
        tabIndex={0}
        aria-label={`Edit ${label}${empty ? ` (${isAsked ? "asked, " : ""}empty)` : `: ${value}`}`}
        title={tip}
        onClick={() => startEdit(key, slot)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            startEdit(key, slot);
          }
        }}
      >
        {empty ? label : value}
      </span>
    );
  };

  const title = templateName.trim() || (proposal ? "Proposal" : "Contract");
  const parties = partiesLine(kind, agencyName, partyName);
  const signed = !!signature && !!(signature.signerName || signature.signedAt);

  return (
    <div ref={wrapRef} className={`${s.paperWrap} ${docFont.variable}`}>
      <div className={s.stage} data-side={reserveSide ? "" : undefined}>
        <article
          ref={paperRef}
          className={preview ? `${s.paper} ${s.paperPreview}` : s.paper}
          data-contract-paper={mode}
          data-enter={enter && !preview ? "" : undefined}
          aria-label={title}
        >
          {agencyName.trim() && <div className={s.brand}>{agencyName}</div>}
          <h2 className={s.pTitle}>{title}</h2>
          {parties && <p className={s.pParties}>{parties}</p>}
          {!preview && metaText && (
            <div className={s.pMeta} data-live={metaLive ? "" : undefined}>
              <i aria-hidden="true" />
              <span>{metaText}</span>
            </div>
          )}

          <div className={s.clauses} style={{ "--num-w": `${numW}px` } as CSSProperties}>
            {shown.map((clause, ci) => {
              const num = numbers[ci];
              const head = clauseHeading(clause.title);
              const hot = ci === hotClause;
              return (
                <div key={ci} className={s.clause} data-plain={num ? undefined : ""} data-hot={hot ? "" : undefined}>
                  {num && <span className={s.cNum}>{num}</span>}
                  <p className={s.cBody}>
                    {head && (
                      <>
                        <span className={s.cTitle}>{head}</span>{" "}
                      </>
                    )}
                    {parts[ci].map((part, pi) =>
                      part.kind === "text" ? (
                        <Fragment key={pi}>{pi === 0 && head ? part.text.replace(/^\s+/, "") : part.text}</Fragment>
                      ) : (
                        renderField(part.key, `${ci}:${pi}`)
                      ),
                    )}
                  </p>
                  {hot && quote && noteMode === "inline" && <HeardNote quote={quote} inline />}
                  {notes?.byClause.get(ci)?.map((c) => <ClientComment key={c.id} comment={c} />)}
                  {/* A comment is answered by changing a term in its clause;
                      a clause with none is the template's own wording. */}
                  {canEdit && notes?.byClause.has(ci) && !parts[ci].some((p) => p.kind === "field") && (
                    <p className={s.cmtHint}>This clause is fixed template wording. Change it in the template, or reply to the client and send it again as is.</p>
                  )}
                </div>
              );
            })}
            {notes && notes.loose.length > 0 && (
              <div className={s.cmtLoose}>
                {notes.loose.map((c) => (
                  <ClientComment key={c.id} comment={c} about={c.clauseTitle} />
                ))}
              </div>
            )}
          </div>

          {!proposal && (
            <div className={s.sign}>
              <div className={s.signCol}>
                <div className={s.signLine}>
                  <b>{agencyName.trim() || "Agency"}</b>
                  Authorized signature
                </div>
              </div>
              <div className={s.signCol}>
                {signature?.image && (
                  <div className={s.signArea}>
                    {/* A data URL from the sign page, not an optimizable asset. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={signature.image} alt={signature.signerName ? `${signature.signerName}'s signature` : "Signature"} />
                  </div>
                )}
                <div className={s.signLine}>
                  <b>{partyName.trim() || "Client"}</b>
                  {signed ? (
                    <>
                      Signed{signature?.signerName ? ` by ${signature.signerName}` : ""}
                      {signature?.signedAt && (
                        <>
                          {" on "}
                          <DateText value={signature.signedAt} />
                        </>
                      )}
                    </>
                  ) : (
                    "Authorized signature"
                  )}
                </div>
              </div>
            </div>
          )}
        </article>
      </div>
      {quote && (noteMode === "side" || noteMode === "over") && (
        <>
          {noteMode === "side" && <span ref={lineRef} className={s.coLine} aria-hidden="true" />}
          <HeardNote key={noteMode} quote={quote} noteRef={noteRef} over={noteMode === "over"} />
        </>
      )}
    </div>
  );
}

function HeardNote({ quote, inline = false, over = false, noteRef }: { quote: string; inline?: boolean; over?: boolean; noteRef?: Ref<HTMLDivElement> }) {
  return (
    <div ref={noteRef} className={inline ? s.coInline : s.co} data-over={over ? "" : undefined} role="status">
      <div className={s.coBox}>
        <div className={s.coEyebrow}>
          <i aria-hidden="true" />
          Just heard
        </div>
        <div className={s.coQuote}>“{quote}”</div>
      </div>
    </div>
  );
}

// A client's change request from the sign page, under the clause it's
// about: who asked and what they said. Focusable from script only, so
// "Show the comments" can move focus here.
function ClientComment({ comment, about }: { comment: PaperComment; about?: string }) {
  const label = about?.trim() ? `Client comment on ${about.trim()}` : "Client comment";
  return (
    <div className={s.cmt} data-client-comment="" tabIndex={-1}>
      <div className={s.cmtLabel}>{label}</div>
      <p className={s.cmtText}>
        <b>{comment.fromName}:</b> {comment.comment}
      </p>
    </div>
  );
}

function DateText({ value }: { value: string }) {
  if (!looksLikeIsoDate(value)) return <>{value}</>;
  return <LocalDateTime iso={value} options={{ year: "numeric", month: "short", day: "numeric" }} />;
}

// The term being typed, in place in the text. Enter or leaving it saves,
// Escape puts back what was there. One line of plain text only. onDone
// gets null when nothing changed.
function FieldEditor({ slot, fieldKey, label, initial, onDone }: { slot: string; fieldKey: string; label: string; initial: string; onDone: (value: string | null, byKeyboard: boolean) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const initialText = useRef(initial);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initialText.current;
    el.focus({ preventScroll: true });
    revealIfHidden(el);
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, []);

  const finish = (save: boolean, byKeyboard: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = save ? normalizeEditedValue(ref.current?.textContent ?? "") : null;
    onDone(value === null || value === normalizeEditedValue(initialText.current) ? null : value, byKeyboard);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false, true);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLSpanElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain").replace(/\s+/g, " ");
    const selection = window.getSelection();
    if (!text || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };

  return (
    <span
      ref={ref}
      className={`${s.f} ${s.editing}`}
      data-field-key={fieldKey}
      data-slot={slot}
      data-ph={label}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label={`Edit ${label}`}
      aria-multiline="false"
      spellCheck
      enterKeyHint="done"
      onKeyDown={onKeyDown}
      onBlur={() => {
        // Switching to another app (the meeting) isn't leaving the term.
        if (!document.hasFocus()) return;
        finish(true, false);
      }}
      onPaste={onPaste}
      onDrop={(e) => e.preventDefault()}
    />
  );
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Clear of the header at the top and the floating action bar at the bottom.
function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.top >= 80 && r.bottom <= window.innerHeight - 150;
}

function revealIfHidden(el: HTMLElement) {
  if (!inView(el)) el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
}

// For the terms list: scrolls the contract to a term and flashes it, for a
// term that can't be edited right now (a sent contract). Returns false when
// the term isn't on the paper.
export function revealField(key: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.querySelector<HTMLElement>(`[data-contract-paper="work"] [data-field-key="${CSS.escape(key)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
  el.removeAttribute("data-flash");
  void el.offsetWidth;
  el.setAttribute("data-flash", "");
  window.setTimeout(() => el.removeAttribute("data-flash"), 1400);
  return true;
}
