"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { discardLocalCapture } from "@/app/(app)/deals/new/actions";
import { discardLiveCall, liveCallState, type LiveCallState } from "@/app/(app)/deals/new/live-actions";
import { captureErrorText } from "@/lib/capture-error";

// What the recording bar (main window) and the floating panel share for a
// call recorded in the desktop app: stopping it, throwing it away, and, for
// a call on a lead, what SealMe has made of it so far.

// The session lives here, not in LocalCaptureForm (which re-exports it for
// the components that import it from there), so the form can use the stop
// and discard below without the two files importing each other.
export const LOCAL_CAPTURE_STORAGE_KEY = "sealme:local-capture";
// AppShell (and the banner inside it) is a persistent layout: it doesn't
// remount on client-side navigation, so a plain mount-time localStorage read
// in the banner would never notice a session that starts after the app's
// first page load. This event tells it to re-check right away instead.
export const LOCAL_CAPTURE_EVENT = "sealme:local-capture-changed";
// How the last call ended. Another window only gets a "storage" event that
// says the session went away; the main window reads this to tell a finished
// call from a discarded one when it has to leave that call's lead page.
export const LOCAL_CAPTURE_ENDED_KEY = "sealme:local-capture-ended";

// What's kept while a call records. A call started from Start a call is a
// call on a lead (phoneCallId); one started before that change, or with
// "Record another call" on a deal, is a deal's (dealId).
export type CaptureSession = { token: string; startedAt: number } & ({ phoneCallId: string; leadId: string; dealId?: undefined } | { dealId: string; phoneCallId?: undefined; leadId?: undefined });

export function parseCaptureSession(raw: string | null): CaptureSession | null {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed.token !== "string") return null;
    if (typeof parsed.phoneCallId === "string" || typeof parsed.dealId === "string") return parsed as CaptureSession;
    return null;
  } catch {
    // Corrupt: no session to show.
    return null;
  }
}

export function readCaptureSession(): CaptureSession | null {
  try {
    return parseCaptureSession(localStorage.getItem(LOCAL_CAPTURE_STORAGE_KEY));
  } catch {
    // localStorage unavailable: no session to show.
    return null;
  }
}

// The session as it is now, for a component: changes made in this window
// arrive as LOCAL_CAPTURE_EVENT, ones made in another window (the floating
// panel) as a "storage" event. null on the server and while hydrating.
function subscribeCaptureSession(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === LOCAL_CAPTURE_STORAGE_KEY) onChange();
  };
  window.addEventListener(LOCAL_CAPTURE_EVENT, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LOCAL_CAPTURE_EVENT, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// The raw string, not the parsed session: a snapshot has to stay the same
// value between reads while nothing changed.
function rawCaptureSession(): string | null {
  try {
    return localStorage.getItem(LOCAL_CAPTURE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function useCaptureSession(): CaptureSession | null {
  const raw = useSyncExternalStore(subscribeCaptureSession, rawCaptureSession, () => null);
  return useMemo(() => parseCaptureSession(raw), [raw]);
}

export type CaptureEnd = "finished" | "discarded";

// How the session's call ended, if it was this window or another one that
// ended it with Stop & finish or Discard; null when that isn't known.
export function captureEndedAs(session: CaptureSession): CaptureEnd | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_CAPTURE_ENDED_KEY) ?? "null");
    if (!parsed || parsed.id !== (session.phoneCallId ?? session.dealId)) return null;
    return parsed.how === "finished" || parsed.how === "discarded" ? parsed.how : null;
  } catch {
    return null;
  }
}

type StopResult = { ok: boolean; error?: string };
// `stale`: the call this window showed had already ended (see isStale), so
// nothing was done; the caller re-reads the session and shows the error.
export type CaptureActionResult = { error?: string; stale?: boolean };

const STALE: CaptureActionResult = { error: "That call already ended", stale: true };

// A window's session can be behind: the call may have been finished or
// discarded in another window, and the next one started since. Stopping then
// would end that next call's recording under the old token, and forgetting
// would drop its session, so stop and discard leave the recording alone.
function isStale(session: CaptureSession): boolean {
  return readCaptureSession()?.token !== session.token;
}

function forget(session: CaptureSession, how: CaptureEnd) {
  // Only this call's session: never the next call's.
  if (isStale(session)) return;
  try {
    // Just which call and how, never the token.
    localStorage.setItem(LOCAL_CAPTURE_ENDED_KEY, JSON.stringify({ id: session.phoneCallId ?? session.dealId, how }));
  } catch {
    // Without it, the main window treats the call as finished.
  }
  localStorage.removeItem(LOCAL_CAPTURE_STORAGE_KEY);
  window.dispatchEvent(new Event(LOCAL_CAPTURE_EVENT));
}

// Stop & finish: the app sends what's left of the call as the last chunk,
// which ends it on the server. The session is forgotten only once that got
// through, so a failed upload can be tried again from the same button.
export async function stopCapture(session: CaptureSession): Promise<CaptureActionResult> {
  if (isStale(session)) return STALE;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<StopResult>("stop_local_capture_and_upload", { token: session.token });
    if (!result.ok) return { error: captureErrorText(result.error, "Something went wrong stopping the recording") };
  } catch (err) {
    return { error: captureErrorText(err, "Something went wrong stopping the recording") };
  }
  forget(session, "finished");
  return {};
}

// Discard: the recording stops first, then SealMe throws the call away. Also
// the way out of a bar left behind by an app that closed mid-call: the app
// has nothing to stop then and says so without an error. The session is only
// forgotten once both happened, so the bar never goes away while the mic is
// still on, or leaves the call waiting on an end that never comes.
export async function discardCapture(session: CaptureSession): Promise<CaptureActionResult> {
  if (isStale(session)) return STALE;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("discard_local_capture");
  } catch (err) {
    return { error: captureErrorText(err, "Couldn't stop the recording") };
  }
  try {
    if (session.dealId !== undefined) await discardLocalCapture(session.dealId, session.token);
    else await discardLiveCall(session.phoneCallId, session.token);
  } catch {
    return { error: "The recording is stopped, but SealMe couldn't close the call. Check your connection and discard it again" };
  }
  forget(session, "discarded");
  return {};
}

// What SealMe has of a call on a lead while it records, checked about every
// 15 seconds (paused while the window is hidden), and right away after
// `bump` changes (a document was just made).
export function useLiveCallState(phoneCallId: string | null | undefined, bump = 0): LiveCallState | null {
  // Kept with the call it's for, so the next call never shows the last one's.
  const [state, setState] = useState<{ id: string; live: LiveCallState | null } | null>(null);
  useEffect(() => {
    if (!phoneCallId) return;
    let cancelled = false;
    const load = () =>
      liveCallState(phoneCallId)
        .then((next) => {
          if (!cancelled) setState({ id: phoneCallId, live: next });
        })
        // A missed check just waits for the next one.
        .catch(() => {});
    load();
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval === null) interval = setInterval(load, 15_000);
    };
    const stop = () => {
      if (interval !== null) clearInterval(interval);
      interval = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        load();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [phoneCallId, bump]);
  return phoneCallId && state?.id === phoneCallId ? state.live : null;
}

// "12:04" since the call started, ticking every second.
export function useElapsed(startedAt: number | null | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (!startedAt) return "";
  const total = Math.max(0, Math.floor((now - startedAt) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// "Contract: 7 of 9 terms" and "Missing: start date, fee +2".
export function docProgress(doc: LiveCallState["docs"][number]): { line: string; missing: string | null } {
  const label = doc.kind === "proposal" ? "Proposal" : "Contract";
  if (doc.total === 0) return { line: `${label}: started`, missing: null };
  const shown = doc.missing.slice(0, 2).join(", ");
  const more = doc.missing.length > 2 ? ` +${doc.missing.length - 2}` : "";
  return { line: `${label}: ${doc.filled} of ${doc.total} terms`, missing: doc.missing.length ? `Missing: ${shown}${more}` : null };
}
