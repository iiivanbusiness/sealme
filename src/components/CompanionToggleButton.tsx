"use client";

import { useState, useSyncExternalStore } from "react";
import { useInDesktopApp } from "@/lib/native-shell";

// Manual toggle for the floating icon rail (see desktop-app's
// toggle_companion_rail command) — collapses the main window and shows the
// small always-on-top rail instead (content only opens once you pick
// something from it), or the reverse if it's already showing. Only
// rendered inside the desktop app; same isTauri detection pattern as
// ContinueCallButton/LocalCaptureForm. Windows-only hidden for now — not
// offering the floating rail there yet, so this stays macOS-only until
// that changes.
export default function CompanionToggleButton() {
  const isTauri = useInDesktopApp();
  // Same no-subscription read as useInDesktopApp: the platform never changes.
  const isWindows = useSyncExternalStore(
    () => () => {},
    () => navigator.userAgent.includes("Windows"),
    () => false,
  );
  const [error, setError] = useState<string | null>(null);


  if (!isTauri || isWindows) return null;

  async function handleClick() {
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("toggle_companion_rail");
    } catch (err) {
      // Surfaced two ways: a visible dot + tooltip here (there's no room for
      // more in the header), and a console.error so it shows up in devtools
      // even if this button re-renders before it's read.
      const message = typeof err === "string" ? err : err instanceof Error ? err.message : "Couldn't open the panel";
      console.error("[companion] toggle_companion_rail failed:", err);
      setError(message);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      title={error ? `Couldn't open the panel: ${error}` : "Open floating panel"}
      aria-label="Open floating panel"
      className="relative flex h-8 w-8 flex-none items-center justify-center rounded-[9px]"
      style={{ color: error ? "#c0392b" : "var(--ink-muted)" }}
    >
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" width={17} height={17}>
        <rect x="3" y="3.5" width="14" height="13" rx="2" />
        <rect x="10.5" y="9.5" width="5.2" height="5.6" rx="1.2" fill="currentColor" stroke="none" opacity={0.9} />
      </svg>
      {error && (
        <span
          className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full"
          style={{ background: "#c0392b" }}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
