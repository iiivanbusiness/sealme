import type { ReactNode } from "react";
import { ChevronIcon } from "./icons";
import s from "./contract.module.css";

// Everything secondary, folded away under "More" so the screen stays the
// paper and what to do next: the call summary, notes, history, voice
// fixes, another call. The cards inside keep their own look.

export default function MoreSection({ label = "More", hint, defaultOpen = false, children }: { label?: string; hint?: string | null; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className={s.more} open={defaultOpen || undefined}>
      <summary className={s.moreSum}>
        <span>{label}</span>
        {hint && <span className={s.moreHint}>{hint}</span>}
        <ChevronIcon className={s.chev} />
      </summary>
      <div className={s.moreBody}>{children}</div>
    </details>
  );
}
