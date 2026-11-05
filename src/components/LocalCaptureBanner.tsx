"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LOCAL_CAPTURE_STORAGE_KEY, LOCAL_CAPTURE_EVENT } from "./LocalCaptureForm";
import { discardLocalCapture } from "@/app/(app)/deals/new/actions";
import { captureErrorText } from "@/lib/capture-error";

type Session = { dealId: string; token: string; startedAt: number };
type StopResult = { ok: boolean; error?: string };

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(LOCAL_CAPTURE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    // Corrupt/unavailable localStorage — just don't show the banner.
    return null;
  }
}

export default function LocalCaptureBanner() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  useEffect(() => {
    setSession(readSession());
    // AppShell is a persistent layout that doesn't remount on navigation —
    // without this listener, a recording started after the first page load
    // would never make the banner appear.
    const onChange = () => {
      const next = readSession();
      setSession(next);
      // Finished or discarded somewhere else: a half-open "Discard this
      // recording?" or an old error shouldn't greet the next call.
      if (!next) {
        setConfirmingDiscard(false);
        setError(null);
      }
    };
    // LOCAL_CAPTURE_EVENT only reaches this window. Stop & finish or Discard
    // in the floating panel (another webview on the same origin) changes the
    // same localStorage key, which arrives here as a "storage" event, so the
    // banner goes away in the main window too.
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === LOCAL_CAPTURE_STORAGE_KEY) onChange();
    };
    window.addEventListener(LOCAL_CAPTURE_EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(LOCAL_CAPTURE_EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  async function handleStop() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<StopResult>("stop_local_capture_and_upload", { token: session.token });
      if (!result.ok) {
        setError(captureErrorText(result.error, "Something went wrong stopping the recording"));
        setBusy(false);
        return;
      }
      localStorage.removeItem(LOCAL_CAPTURE_STORAGE_KEY);
      const dealId = session.dealId;
      setSession(null);
      // This banner lives in the persistent layout, so the next call's banner
      // would otherwise come up stuck on "Finishing…".
      setBusy(false);
      // Best-effort spoken recap of what the call produced — 204 (not
      // configured, nothing extracted, provider hiccup) just means no
      // audio plays. Never blocks the navigation below.
      new Audio(`/api/deals/${dealId}/call-recap`).play().catch(() => {});
      router.push(`/deals/${dealId}`);
      router.refresh();
    } catch (err) {
      setError(captureErrorText(err, "Something went wrong stopping the recording"));
      setBusy(false);
    }
  }

  // Throws the call away. Also the recovery path for a stuck banner, e.g.
  // the app was closed (or crashed) before Stop & finish was ever pressed,
  // leaving this session sitting in localStorage on next launch. The app has
  // nothing to stop then and says so without an error. The session is only
  // forgotten once the recording has really stopped and SealMe has closed
  // the call: otherwise the banner would vanish while the mic keeps going,
  // or leave the deal waiting on a call that never ends. Confirmation is
  // inline, not window.confirm(): Tauri's WKWebView doesn't reliably surface
  // native JS dialogs, so that silently did nothing when clicked.
  async function handleDiscard() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("discard_local_capture");
    } catch (err) {
      setError(captureErrorText(err, "Couldn't stop the recording"));
      setBusy(false);
      return;
    }
    try {
      await discardLocalCapture(session.dealId, session.token);
    } catch {
      setError("The recording is stopped, but SealMe couldn't close the call. Check your connection and discard it again");
      setBusy(false);
      return;
    }
    localStorage.removeItem(LOCAL_CAPTURE_STORAGE_KEY);
    setSession(null);
    setBusy(false);
    setConfirmingDiscard(false);
    // The deal it was for, if that's the page open, is no longer waiting on it.
    router.refresh();
  }

  if (!session) return null;

  return (
    <div
      className="mx-3.5 mb-0 mt-3.5 flex flex-wrap items-center gap-3 rounded-[14px] px-4 py-3 text-[13px]"
      style={{ background: "var(--success-soft)", color: "var(--success)" }}
    >
      <span className="inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ background: "var(--success)" }} />
      <span className="font-medium">Recording your call locally</span>
      {error && (
        <span className="text-[12px]" style={{ color: "var(--warn)" }}>
          {error}
        </span>
      )}
      {confirmingDiscard ? (
        <span className="ml-auto flex items-center gap-2.5">
          <span className="text-[12.5px] font-medium">Discard this recording?</span>
          <button
            type="button"
            disabled={busy}
            onClick={handleDiscard}
            className="btn btn-sm"
            style={{ background: "var(--warn)", color: "var(--on-primary, #fff)" }}
          >
            {busy ? "Discarding…" : "Yes, discard"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingDiscard(false)}
            className="text-[12px] font-medium"
            style={{ color: "var(--success)" }}
          >
            Cancel
          </button>
        </span>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={handleStop}
            className="btn btn-sm ml-auto"
            style={{ background: "var(--success)", color: "var(--on-primary, #fff)" }}
          >
            {busy ? "Finishing…" : "Stop & finish"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmingDiscard(true)}
            className="text-[12px] font-medium underline decoration-dotted underline-offset-2"
            style={{ color: "var(--success)" }}
          >
            Discard
          </button>
        </>
      )}
    </div>
  );
}
