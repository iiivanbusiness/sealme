import Link from "next/link";
import type { ReactNode } from "react";
import s from "./contract.module.css";

// The floating bar under the paper: Preview and the one main action.
// Desktop: it sticks to the bottom of the window while the paper column is
// in view and rests under the paper at the end. Phone: fixed at the bottom,
// above the tab bar (override the gap with --action-bar-bottom).
// Put it in the same column as ContractPaper; alignWithNotes keeps it
// centered over the paper when the paper leaves room on its right
// (ContractPaper sideNotes). On a phone it leaves the page flow, so put an
// ActionBarSpacer at the very end of the page.

export default function ActionBar({ children, alignWithNotes = false, label = "Document actions" }: { children: ReactNode; alignWithNotes?: boolean; label?: string }) {
  return (
    // data-action-bar: the phone's help button moves up out of its way (globals.css).
    <div className={s.barSlot} data-notes={alignWithNotes ? "" : undefined} data-action-bar="">
      <div className={s.barIn} role="group" aria-label={label}>
        <span className={s.barBlur} aria-hidden="true" />
        <div className={s.barRow}>{children}</div>
      </div>
    </div>
  );
}

// Phones only: room at the end of the page so the last card can scroll
// clear of the fixed bar. Nothing on wider screens.
export function ActionBarSpacer() {
  return <div className={s.barSpacer} aria-hidden="true" />;
}

export type BarButtonProps = {
  children: ReactNode;
  variant?: "ghost" | "primary" | "done";
  // Shown in a pill inside the button: "3 terms missing". A narrow bar (a
  // phone) leaves it and the main button's icon out, so the label fits.
  badge?: string | null;
  disabled?: boolean;
  busy?: boolean;
  // A link instead of a button. /api/... links (the PDF) are plain anchors.
  href?: string;
  onClick?: () => void;
  icon?: ReactNode;
  type?: "button" | "submit";
  title?: string;
};

export function BarButton({ children, variant = "ghost", badge, disabled = false, busy = false, href, onClick, icon, type = "button", title }: BarButtonProps) {
  const v = variant === "ghost" ? undefined : variant;
  const inner = (
    <>
      {icon && <span className={s.bbtnIcon}>{icon}</span>}
      <span className={s.bbtnLabel}>{children}</span>
      {badge && <span className={s.badge}>{badge}</span>}
    </>
  );
  if (href && !disabled && !busy) {
    if (href.startsWith("/api/") || /^[a-z]+:/i.test(href)) {
      return (
        <a className={s.bbtn} data-variant={v} data-badge={badge ? "" : undefined} href={href} title={title}>
          {inner}
        </a>
      );
    }
    return (
      <Link className={s.bbtn} data-variant={v} data-badge={badge ? "" : undefined} href={href} title={title}>
        {inner}
      </Link>
    );
  }
  return (
    <button type={type} className={s.bbtn} data-variant={v} data-badge={badge ? "" : undefined} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} title={title}>
      {inner}
    </button>
  );
}
