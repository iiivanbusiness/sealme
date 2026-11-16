import Link from "next/link";
import type { ReactNode } from "react";
import s from "./contract.module.css";

// The one thing to do next, under the terms: what to ask during the call,
// that the contract is ready to send, or where it stands once it's out.
// Generic on purpose: the screen decides the words and the buttons.

export type NextCardProps = {
  eyebrow: ReactNode;
  title: ReactNode;
  text?: ReactNode;
  // A suggested question, shown in quotes.
  quote?: string | null;
  tone?: "default" | "done" | "warn" | "dark";
  actions?: ReactNode;
  id?: string;
};

export default function NextCard({ eyebrow, title, text, quote, tone = "default", actions, id }: NextCardProps) {
  return (
    <section id={id} className={s.card} data-tone={tone === "default" ? undefined : tone} aria-live="polite">
      <div className={s.eyebrow}>{eyebrow}</div>
      <h3 className={s.nextTitle}>{title}</h3>
      {quote && <p className={s.nextText}>“{quote}”</p>}
      {text && <div className={s.nextText}>{text}</div>}
      {actions && <div className={s.nextRow}>{actions}</div>}
    </section>
  );
}

// "Listening for the answer..." style dots, for an eyebrow.
export function WaitingDots() {
  return (
    <span className={s.dots} aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

type CardButtonProps = {
  children: ReactNode;
  variant?: "secondary" | "primary" | "done" | "danger" | "quiet";
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  type?: "button" | "submit";
  icon?: ReactNode;
  title?: string;
  // Opens in a new tab (a PDF, a sign link).
  newTab?: boolean;
};

// A small button for NextCard actions and dialogs. With href it's a link;
// links to /api/... (a PDF) are plain anchors, not client navigation.
export function CardButton({ children, variant = "secondary", href, onClick, disabled = false, busy = false, type = "button", icon, title, newTab = false }: CardButtonProps) {
  const v = variant === "secondary" ? undefined : variant;
  if (href && !disabled) {
    const plain = newTab || href.startsWith("/api/") || /^[a-z]+:/i.test(href);
    if (plain) {
      return (
        <a className={s.cbtn} data-variant={v} href={href} title={title} target={newTab ? "_blank" : undefined} rel={newTab ? "noopener noreferrer" : undefined}>
          {icon}
          {children}
        </a>
      );
    }
    return (
      <Link className={s.cbtn} data-variant={v} href={href} title={title}>
        {icon}
        {children}
      </Link>
    );
  }
  return (
    <button type={type} className={s.cbtn} data-variant={v} onClick={onClick} disabled={disabled || busy} aria-busy={busy || undefined} title={title}>
      {icon}
      {children}
    </button>
  );
}
