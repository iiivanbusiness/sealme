"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { LOCAL_CAPTURE_STORAGE_KEY, LOCAL_CAPTURE_EVENT, readCaptureSession, type CaptureSession } from "./LocalCaptureForm";
import { createLiveDocument } from "@/app/(app)/deals/new/live-actions";
import { stopCapture, discardCapture, captureEndedAs, useLiveCallState, useElapsed, docProgress } from "@/lib/live-capture-client";

// The bar at the top of the app while the desktop app records a call: how
// long it's been going, Stop & finish, and Discard. For a call on a lead it
// also shows each proposal or contract filling in, what's still missing, and
// Create proposal / Create contract to make one mid-call. Nothing from here
// is sent to anyone.
export default function LocalCaptureBanner() {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState<string | null>(null);
  const [bump, setBump] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const live = useLiveCallState(session?.phoneCallId, bump);
  const elapsed = useElapsed(session?.startedAt);
  // For a call ended in the floating panel while this window shows its lead
  // (see leaveEndedLead below). Refs, since the listeners are set up once.
  const sessionRef = useRef<CaptureSession | null>(null);
  const lastLiveRef = useRef<{ phoneCallId: string; leadId: string | null; leadName: string | null } | null>(null);
  const pathnameRef = useRef(pathname);
  const routerRef = useRef(router);
  // This banner's own Stop & finish or Discard: it navigates by itself.
  const endingHereRef = useRef(false);

  useEffect(() => {
    pathnameRef.current = pathname;
    routerRef.current = router;
  }, [pathname, router]);

  useEffect(() => {
    if (live && session?.phoneCallId) lastLiveRef.current = { phoneCallId: session.phoneCallId, leadId: live.leadId, leadName: live.leadName };
  }, [live, session?.phoneCallId]);

  useEffect(() => {
    // A call on a lead that SealMe hadn't put a name to yet, ended somewhere
    // else while this window shows that placeholder lead: Discard deletes the
    // lead, and Stop may merge it into one that's already there, so the
    // page's next refresh would be a 404. Leads instead, as after this
    // banner's own Stop or Discard.
    const leaveEndedLead = (prev: CaptureSession) => {
      const last = lastLiveRef.current;
      if (!prev.phoneCallId || !last || last.phoneCallId !== prev.phoneCallId || last.leadName) return;
      const path = pathnameRef.current;
      if (path !== `/leads/${prev.leadId}` && path !== `/leads/${last.leadId}`) return;
      routerRef.current.replace(captureEndedAs(prev) === "discarded" ? "/leads" : "/leads?added=1");
    };

    const initial = readCaptureSession();
    sessionRef.current = initial;
    setSession(initial);
    // AppShell is a persistent layout that doesn't remount on navigation —
    // without this listener, a recording started after the first page load
    // would never make the banner appear.
    const onChange = () => {
      const prev = sessionRef.current;
      const next = readCaptureSession();
      sessionRef.current = next;
      setSession(next);
      // Finished or discarded somewhere else: a half-open "Discard this
      // recording?" or an old error shouldn't greet the next call.
      if (!next) {
        setConfirmingDiscard(false);
        setError(null);
        setBusy(false);
        if (prev && !endingHereRef.current) leaveEndedLead(prev);
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

  // The call this banner showed had already ended in another window: show
  // the session as it is now, with why nothing happened.
  function showCurrent(error: string | undefined) {
    const next = readCaptureSession();
    sessionRef.current = next;
    setSession(next);
    setConfirmingDiscard(false);
    setError(error ?? null);
  }

  async function handleStop() {
    if (!session) return;
    setBusy(true);
    setError(null);
    endingHereRef.current = true;
    const { error, stale } = await stopCapture(session);
    endingHereRef.current = false;
    // This banner lives in the persistent layout, so the next call's banner
    // would otherwise come up stuck on "Finishing…".
    setBusy(false);
    if (stale) return showCurrent(error);
    if (error) return setError(error);
    sessionRef.current = null;
    setSession(null);
    if (session.phoneCallId) {
      // The notes are written now, on the lead. A call that SealMe still has
      // to put a name to may end up on a lead that's already there, so it
      // goes to Leads, like an uploaded call.
      // Otherwise the lead opens on this call, the same as after an upload.
      router.push(live && !live.leadName ? "/leads?added=1" : `/leads/${live?.leadId ?? session.leadId}?call=${session.phoneCallId}`);
    } else {
      // Best-effort spoken recap of what the call produced — 204 (not
      // configured, nothing extracted, provider hiccup) just means no
      // audio plays. Never blocks the navigation below.
      new Audio(`/api/deals/${session.dealId}/call-recap`).play().catch(() => {});
      router.push(`/deals/${session.dealId}`);
    }
    router.refresh();
  }

  // Confirmation is inline, not window.confirm(): Tauri's WKWebView doesn't
  // reliably surface native JS dialogs, so that silently did nothing.
  async function handleDiscard() {
    if (!session) return;
    setBusy(true);
    setError(null);
    endingHereRef.current = true;
    const { error, stale } = await discardCapture(session);
    endingHereRef.current = false;
    setBusy(false);
    if (stale) return showCurrent(error);
    if (error) return setError(error);
    sessionRef.current = null;
    setSession(null);
    setConfirmingDiscard(false);
    if (session.phoneCallId && live && !live.leadName) router.push("/leads");
    // The page it was for is no longer waiting on it.
    router.refresh();
  }

  async function make(kind: "proposal" | "contract") {
    if (!session?.phoneCallId) return;
    setMaking(kind);
    setError(null);
    try {
      const result = await createLiveDocument(session.phoneCallId, kind);
      if (result.error) setError(result.error);
      setBump((n) => n + 1);
      router.refresh();
    } catch {
      setError(`Couldn't start the ${kind}. Try again`);
    }
    setMaking(null);
  }

  if (!session) return null;

  const docs = live?.docs ?? [];
  const title = session.phoneCallId ? `Recording${live?.leadName ? ` · ${live.leadName}` : ""}` : "Recording your call locally";

  return (
    <div className="mx-3.5 mb-0 mt-3.5 flex flex-col gap-2 rounded-[14px] px-4 py-3 text-[13px]" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex h-2 w-2 shrink-0 animate-pulse rounded-full" style={{ background: "var(--success)" }} />
        <span className="min-w-0 truncate font-medium">{title}</span>
        {elapsed && <span className="text-[12.5px] tabular-nums opacity-80">{elapsed}</span>}
        {confirmingDiscard ? (
          <span className="ml-auto flex flex-wrap items-center gap-2.5">
            <span className="text-[12.5px] font-medium">Discard this recording?</span>
            <button type="button" disabled={busy} onClick={handleDiscard} className="btn btn-sm" style={{ background: "var(--warn)", color: "var(--on-primary, #fff)" }}>
              {busy ? "Discarding…" : "Yes, discard"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirmingDiscard(false)} className="text-[12px] font-medium" style={{ color: "var(--success)" }}>
              Cancel
            </button>
          </span>
        ) : (
          <span className="ml-auto flex flex-wrap items-center gap-2.5">
            {live?.canMake.proposal && (
              <button type="button" disabled={busy || making !== null} onClick={() => make("proposal")} className="btn btn-secondary btn-sm">
                {making === "proposal" ? "Starting…" : "Create proposal"}
              </button>
            )}
            {live?.canMake.contract && (
              <button type="button" disabled={busy || making !== null} onClick={() => make("contract")} className="btn btn-secondary btn-sm">
                {making === "contract" ? "Starting…" : "Create contract"}
              </button>
            )}
            <button type="button" disabled={busy} onClick={handleStop} className="btn btn-sm" style={{ background: "var(--success)", color: "var(--on-primary, #fff)" }}>
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
          </span>
        )}
      </div>
      {docs.length > 0 && (
        <div className="flex flex-col gap-1 text-[12.5px]" style={{ color: "var(--ink)" }}>
          {docs.map((doc) => {
            const { line, missing } = docProgress(doc);
            return (
              <div key={doc.dealId} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{line}</span>
                {missing && <span style={{ color: "var(--ink-muted)" }}>· {missing}</span>}
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <span className="text-[12px]" style={{ color: "var(--warn)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
