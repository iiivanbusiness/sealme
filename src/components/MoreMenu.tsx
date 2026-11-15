"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type MoreMenuItem = { label: string; href?: string; onSelect?: () => void; danger?: boolean };

// The "..." button: the few things you do now and then, kept out of the
// way of what you do every day.
export default function MoreMenu({ items, label = "More", size = "md", align = "right" }: { items: MoreMenuItem[]; label?: string; size?: "sm" | "md"; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  if (items.length === 0) return null;
  const box = size === "sm" ? "h-8 w-8" : "h-[38px] w-[38px]";
  const itemClass = "block w-full rounded-[8px] px-3 py-2 text-left text-[13px] font-medium transition-colors hover:bg-[var(--surface-2)]";

  return (
    <div ref={root} className="relative flex-none">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={`flex ${box} items-center justify-center rounded-full border transition-colors`}
        style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", color: "var(--ink-muted)" }}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden>
          <circle cx="4.5" cy="10" r="1.6" />
          <circle cx="10" cy="10" r="1.6" />
          <circle cx="15.5" cy="10" r="1.6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-[calc(100%+6px)] z-50 flex min-w-[200px] flex-col gap-0.5 rounded-[12px] border p-1.5`}
          style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", boxShadow: "0 12px 34px rgba(0, 0, 0, 0.16)" }}
        >
          {items.map((item) =>
            item.href ? (
              <Link key={item.label} href={item.href} role="menuitem" className={itemClass} style={{ color: item.danger ? "#c0392b" : "var(--ink)" }} onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={itemClass}
                style={{ color: item.danger ? "#c0392b" : "var(--ink)" }}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
