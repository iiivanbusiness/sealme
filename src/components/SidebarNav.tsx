"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { activeNavHref } from "@/lib/nav-config";

export type SidebarNavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
};

export type SidebarNavGroup = { label: string; items: SidebarNavItem[]; collapsible?: boolean };

// expandAll: nothing folded (the phone's menu already is the "More").
export default function SidebarNav({ groups, expandAll = false }: { groups: SidebarNavGroup[]; expandAll?: boolean }) {
  const items = groups.flatMap((g) => g.items);
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);

  const activeHref = activeNavHref(pathname, items.map((item) => item.href));
  // A folded group opens by itself when the page you're on is in it.
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const isOpen = (group: SidebarNavGroup) => expandAll || !group.collapsible || opened.has(group.label) || group.items.some((i) => i.href === activeHref);
  const toggle = (label: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  useLayoutEffect(() => {
    const container = containerRef.current;
    function measure() {
      const el = activeHref ? itemRefs.current.get(activeHref) : null;
      setPill(el ? { top: el.offsetTop, height: el.offsetHeight } : null);
    }
    measure();

    // On a short window the list scrolls; bring the active item into view
    // without scrolling the page itself.
    const active = activeHref ? itemRefs.current.get(activeHref) : null;
    if (container && active) {
      const top = active.offsetTop;
      const bottom = top + active.offsetHeight;
      if (top < container.scrollTop) container.scrollTop = top - 8;
      else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight + 8;
    }

    // Re-measure whenever anything in the list changes size after this
    // first paint: group headings and labels can shift once fonts and
    // styles finish loading, and the container's own size doesn't change
    // when that happens, so watching only the container left the pill a
    // row off.
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const child of Array.from(container.children)) observer.observe(child);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => observer.disconnect();
  }, [activeHref]);

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
      {pill && (
        <div
          aria-hidden="true"
          className="nav-pill-wrap left-0 right-0 transition-[top,height] duration-300 ease-out"
          // Inline, not the `absolute` class: .nav-pill-wrap in globals.css
          // sets position: relative and beats the utility, which put the
          // pill in the flow and pushed every item down a row.
          style={{ position: "absolute", top: pill.top, height: pill.height }}
        >
          <div className="nav-pill" />
        </div>
      )}
      {groups.map((group, gi) => (
        <div key={group.label || gi} className={`flex flex-col gap-1 ${gi > 0 ? "mt-3.5" : ""}`}>
          {group.collapsible && !expandAll ? (
            // Looks like the other section labels, with a chevron to fold it.
            <button
              type="button"
              onClick={() => toggle(group.label)}
              aria-expanded={isOpen(group)}
              className="flex h-[24px] items-center gap-1 rounded-[8px] px-3 text-left text-[10.5px] font-medium uppercase tracking-[0.08em]"
              style={{ color: "var(--ink-muted)" }}
            >
              <span style={{ opacity: 0.75 }}>{group.label}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="flex-none transition-transform duration-150" style={{ transform: isOpen(group) ? "rotate(90deg)" : undefined, opacity: 0.75 }}>
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          ) : (
            group.label && (
              <div className="h-[18px] px-3 text-[10.5px] font-medium uppercase leading-[18px] tracking-[0.08em]" style={{ color: "var(--ink-muted)", opacity: 0.75 }}>
                {group.label}
              </div>
            )
          )}
          {isOpen(group) && group.items.map((item) => {
            const isActive = item.href === activeHref;
            return (
              <Link
                key={item.href}
                href={item.href}
                ref={(el) => {
                  if (el) itemRefs.current.set(item.href, el);
                  else itemRefs.current.delete(item.href);
                }}
                className="group relative z-10 flex h-[35px] items-center gap-2.5 rounded-[10px] px-3 text-[13.5px] font-medium leading-5 transition-[color,transform] duration-150 active:scale-[0.97]"
                style={{ color: isActive ? "var(--on-primary)" : "var(--ink-muted)" }}
              >
                <span className="inline-flex flex-none transition-transform duration-150 group-hover:scale-[1.12]">
                  {item.icon}
                </span>
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </div>
  );
}
