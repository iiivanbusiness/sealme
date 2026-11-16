"use client";

import { useId } from "react";
import Dialog from "./Dialog";
import s from "./contract.module.css";

// Shown when Send is pressed with terms still empty: which ones, and a way
// straight to the first of them. There is no "send anyway"; SealMe never
// sends a document with blanks in it.

export type MissingDialogProps = {
  open: boolean;
  missing: { key: string; label: string }[];
  partyName?: string | null;
  // "contract" or "proposal", for the wording.
  documentLabel?: string;
  // During the call the rep can still ask for them.
  live?: boolean;
  // Starts typing that term (the first one for "Fill them in").
  onFill: (key: string) => void;
  onClose: () => void;
};

export default function MissingDialog({ open, missing, partyName, documentLabel = "contract", live = false, onFill, onClose }: MissingDialogProps) {
  const titleId = useId();
  const n = missing.length;
  const who = partyName?.trim() || "The client";
  return (
    <Dialog open={open && n > 0} onClose={onClose} labelledBy={titleId}>
      <div className={s.sheet}>
        <h2 id={titleId} className={s.sheetTitle}>
          {n} {n === 1 ? "term is" : "terms are"} still empty
        </h2>
        <p className={s.sheetText}>
          {who} would get blank lines in these places. {live ? "Ask for them before you hang up, or type them in yourself." : `Type them in before you send the ${documentLabel}.`}
        </p>
        <div className={s.chips}>
          {missing.map((m) => (
            <button key={m.key} type="button" className={s.chip} onClick={() => onFill(m.key)} aria-label={`Fill in ${m.label}`}>
              {m.label}
            </button>
          ))}
        </div>
        <div className={s.sheetRow}>
          <button type="button" className={s.cbtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={s.cbtn} data-variant="primary" data-autofocus="" onClick={() => n > 0 && onFill(missing[0].key)}>
            Fill them in
          </button>
        </div>
      </div>
    </Dialog>
  );
}
