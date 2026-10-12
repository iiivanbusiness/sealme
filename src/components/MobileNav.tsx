"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import GlassPanel from "./GlassPanel";

export type MobileNavItem = {
  href: string;
  label: string;
  icon: React.ReactNode;
};

const PRIMARY_COUNT = 4;

function MenuIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" width={19} height={19}>
      <path d="M3 5.5h14M3 10h14M3 14.5h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" width={17} height={17}>
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

// A floating liquid-glass pill fixed to the bottom of the screen on phones
// — the first few nav destinations as icon-only buttons (active one gets
// a solid circle, same convention as SidebarNav's active pill), plus a
// trailing "more" button that opens the full labeled nav in a slide-in
// panel. Replaces the old header hamburger + drawer as the primary way
// to navigate on mobile, matching the reference's floating bottom bar.
export default function MobileNav({ items, drawerContent }: { items: MobileNavItem[]; drawerContent: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lastPathname, setLastPathname] = useState(pathname);

  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const primary = items.slice(0, PRIMARY_COUNT);

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-4 md:hidden"
        style={{ paddingBottom: "max(14px, env(safe-area-inset-bottom))" }}
      >
        <div className="glass-nav mobile-bottom-nav relative flex items-center gap-1 rounded-full px-2 py-2">
          <div className="glass-nav-blur" aria-hidden="true" />
          <div className="relative z-10 flex items-center gap-1">
            {primary.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-label={item.label}
                  className="flex h-11 w-11 flex-none items-center justify-center rounded-full transition-colors"
                  style={{ background: active ? "var(--primary)" : "transparent", color: active ? "var(--on-primary)" : "var(--ink-muted)" }}
                >
                  {item.icon}
                </Link>
              );
            })}
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="More"
              className="flex h-11 w-11 flex-none items-center justify-center rounded-full"
              style={{ color: "var(--ink-muted)" }}
            >
              <MenuIcon />
            </button>
          </div>
        </div>
      </nav>

      {open && (
        <div className="mobile-drawer fixed inset-0 z-50 flex md:hidden">
          <div className="absolute inset-0" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => setOpen(false)} />
          <div className="relative ml-auto flex h-full w-[264px] flex-none">
            <GlassPanel className="mobile-nav-glass flex h-full w-full rounded-none px-3.5 py-[22px]">{drawerContent}</GlassPanel>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
              className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-[8px]"
              style={{ color: "var(--ink-muted)" }}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      )}
    </>
  );
}
