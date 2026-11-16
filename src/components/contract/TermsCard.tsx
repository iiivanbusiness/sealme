"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ContractTerm } from "./types";
import { normalizeEditedValue, termProgress } from "./paper-utils";
import { TermCheck } from "./icons";
import s from "./contract.module.css";

// Every term the document needs, in the order they appear in it, with how
// many are in. Picking a term opens it for typing on the paper; a term
// that isn't in the text (the client's email, say) is typed right here.
// id="missing" is what the dashboard's "/deals/[id]#missing" links land on.

export type TermsCardProps = {
  title: string;
  terms: ContractTerm[];
  askedKeys: ReadonlySet<string>;
  onPick: (key: string) => void;
  editingKey?: string | null;
  // Only called when the value changed. "" clears the term.
  onCommit?: (key: string, value: string) => void;
  onCancel?: () => void;
  editable: boolean;
  // The term that was just heard, lit up for a moment.
  heardKey?: string | null;
};

export default function TermsCard({ title, terms, askedKeys, onPick, editingKey = null, onCommit, onCancel, editable, heardKey = null }: TermsCardProps) {
  const headingId = useId();
  const { filled, total, complete } = termProgress(terms);
  const pct = total ? Math.round((filled / total) * 100) : 0;

  return (
    <section id="missing" className={s.card} aria-labelledby={headingId}>
      <div className={s.cardH}>
        <h2 id={headingId} className={s.cardTitle}>
          {title}
        </h2>
        {total > 0 && (
          <span className={s.count} data-all={complete ? "" : undefined}>
            {complete ? `All ${total} in` : `${filled} of ${total}`}
          </span>
        )}
      </div>
      {total > 0 && (
        <div className={s.progress} role="progressbar" aria-label={`${filled} of ${total} terms in`} aria-valuemin={0} aria-valuemax={total} aria-valuenow={filled}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {total === 0 ? (
        <p className={s.cardEmpty}>This template has no terms to fill in.</p>
      ) : (
        <ul className={s.tlist}>
          {terms.map((term) => {
            const typingHere = editable && !term.onPaper && editingKey === term.key && !!onCommit;
            return (
              <li key={term.key}>
                {typingHere ? (
                  <RowEditor term={term} onCommit={onCommit} onCancel={onCancel} />
                ) : (
                  <TermRow term={term} asked={askedKeys.has(term.key)} heard={heardKey === term.key} onPick={onPick} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TermRow({ term, asked, heard, onPick }: { term: ContractTerm; asked: boolean; heard: boolean; onPick: (key: string) => void }) {
  const empty = term.state === "empty" || !term.value?.trim();
  const isAsked = empty && asked;
  return (
    <button type="button" className={s.trow} data-new={heard && !empty ? "" : undefined} onClick={() => onPick(term.key)} title={empty ? undefined : (term.value ?? undefined)}>
      <span className={s.ti} aria-hidden="true">
        {empty ? isAsked ? <span className={s.dot} /> : <span className={s.ring} /> : <TermCheck edited={term.state === "edited"} />}
      </span>
      <span className={s.tl}>{term.label}</span>
      <span className={s.tv} data-tone={empty ? (isAsked ? "asked" : "miss") : undefined}>
        {empty ? (isAsked ? "Asked" : "Missing") : term.value}
      </span>
    </button>
  );
}

// A term that isn't in the document's text, typed in its row.
function RowEditor({ term, onCommit, onCancel }: { term: ContractTerm; onCommit: (key: string, value: string) => void; onCancel?: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // What was there when typing started, so a value the call fills in
  // meanwhile isn't wiped by leaving the box untouched.
  const [before] = useState(() => (term.state === "empty" ? "" : normalizeEditedValue(term.value ?? "")));

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const value = save ? normalizeEditedValue(ref.current?.value ?? "") : null;
    if (value === null || value === before) onCancel?.();
    else onCommit(term.key, value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  };

  const email = /email/i.test(term.key);
  return (
    <div className={s.trow} data-editing="">
      <span className={s.ti} aria-hidden="true">
        <span className={s.ring} />
      </span>
      <span className={s.tl}>{term.label}</span>
      <input
        ref={ref}
        className={s.tinput}
        type={email ? "email" : "text"}
        inputMode={email ? "email" : undefined}
        autoComplete="off"
        enterKeyHint="done"
        defaultValue={before}
        placeholder={term.label}
        aria-label={`Edit ${term.label}`}
        onKeyDown={onKeyDown}
        onBlur={() => {
          // Switching to another app (the meeting) isn't leaving the box.
          if (!document.hasFocus()) return;
          finish(true);
        }}
      />
    </div>
  );
}
