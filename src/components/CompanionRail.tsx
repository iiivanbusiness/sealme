"use client";

import { useEffect, useRef } from "react";
import { LOCAL_CAPTURE_STORAGE_KEY, LOCAL_CAPTURE_EVENT } from "./LocalCaptureForm";
import { useInDesktopApp } from "@/lib/native-shell";

type View = "live" | "calendar" | "notes";
type Session = { dealId: string; token: string; startedAt: number };

// Same fixed dark-glass tokens as CompanionPanel.tsx — kept local rather
// than shared, since this is a tiny, separate window/page and the palette
// is a handful of constants, not worth a cross-file dependency for.
const glass = {
  text: "rgba(255,255,255,0.94)",
  textFaint: "rgba(255,255,255,0.38)",
  divider: "rgba(255,255,255,0.12)",
};

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(LOCAL_CAPTURE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function Icon({ view }: { view: View | "back" }) {
  const common = { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, width: 15, height: 15 };
  if (view === "live") {
    return (
      <svg {...common}>
        <path d="M6 12.5V7.5M10 14.5V5.5M14 12.5V7.5" />
      </svg>
    );
  }
  if (view === "calendar") {
    return (
      <svg {...common}>
        <rect x="3.5" y="4.5" width="13" height="12" rx="1.6" />
        <path d="M3.5 8.5h13M7 2.5v3M13 2.5v3" />
      </svg>
    );
  }
  if (view === "notes") {
    return (
      <svg {...common}>
        <rect x="4.5" y="2.5" width="11" height="15" rx="1.4" />
        <path d="M7 7h6M7 10h6M7 13h3.5" />
      </svg>
    );
  }
  // back to main app
  return (
    <svg {...common}>
      <path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" />
      <path d="M12 3h5v5M16.5 3.5 9 11" />
    </svg>
  );
}

// The persistent floating icon strip — a separate native window from the
// content it opens (see desktop-app's toggle_companion_rail /
// select_companion_view). Content only ever appears once a view is picked
// here; this window has no content of its own beyond the 4 buttons.
export default function CompanionRail() {
  const isTauri = useInDesktopApp();
  const hadSessionRef = useRef(false);

  useEffect(() => {
    hadSessionRef.current = Boolean(readSession());

    // Same "notice a call just started" auto-open as before, just relocated
    // here — the rail is the one window guaranteed to be mounted the whole
    // time companion mode is on, so it's the right place to listen for a
    // new local-capture session and open Live on its own.
    const onChange = async () => {
      const next = readSession();
      const isNew = Boolean(next) && !hadSessionRef.current;
      hadSessionRef.current = Boolean(next);
      if (!isNew) return;
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("select_companion_view", { view: "live" });
      } catch (err) {
        console.error("[companion] auto-open live failed:", err);
      }
    };
    window.addEventListener(LOCAL_CAPTURE_EVENT, onChange);
    return () => window.removeEventListener(LOCAL_CAPTURE_EVENT, onChange);
  }, []);

  async function pick(view: View) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("select_companion_view", { view });
    } catch (err) {
      console.error("[companion] select_companion_view failed:", err);
    }
  }

  async function backToApp() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("toggle_companion_rail");
    } catch (err) {
      console.error("[companion] toggle_companion_rail failed:", err);
    }
  }

  if (!isTauri) return null;

  const buttonStyle: React.CSSProperties = {
    width: 30,
    height: 30,
    color: glass.text,
    cursor: "pointer",
    borderRadius: 8,
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-3" style={{ borderRadius: 16, overflow: "hidden" }}>
      {(["live", "calendar", "notes"] as View[]).map((view) => (
        <button key={view} type="button" onClick={() => pick(view)} title={view} aria-label={view} className="flex flex-none items-center justify-center" style={buttonStyle}>
          <Icon view={view} />
        </button>
      ))}
      <div style={{ width: 20, height: 1, background: glass.divider, margin: "4px 0" }} />
      <button
        type="button"
        onClick={backToApp}
        title="Back to main app"
        aria-label="Back to main app"
        className="flex flex-none items-center justify-center"
        style={{ ...buttonStyle, color: glass.textFaint }}
      >
        <Icon view="back" />
      </button>
    </div>
  );
}
