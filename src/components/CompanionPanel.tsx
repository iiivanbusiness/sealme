"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LOCAL_CAPTURE_STORAGE_KEY, LOCAL_CAPTURE_EVENT } from "./LocalCaptureForm";
import CallHighlightsList, { type CallHighlightItem } from "./CallHighlightsList";
import RecentNotesList, { type RecentNoteItem } from "./RecentNotesList";
import ClientText from "@/components/ClientText";
import { useInDesktopApp } from "@/lib/native-shell";

type Session = { dealId: string; token: string; startedAt: number };
type StopResult = { ok: boolean; error?: string };

type DealField = { id: string; groupLabel: string; label: string; value: string | null; status: string };
type DealState = {
  dealId: string;
  clientName: string;
  status: string;
  summary: string | null;
  fields: DealField[];
  callHighlights: CallHighlightItem[];
};

type UpcomingEvent = {
  id: string;
  title: string;
  clientName: string | null;
  startTime: string;
  durationMinutes: number;
  platform: string;
  meetingUrl: string | null;
  linkedDealId: string | null;
};

type View = "live" | "calendar" | "notes";

const PLATFORM_LABEL: Record<string, string> = { zoom: "Zoom", meet: "Google Meet" };

// A fixed dark-glass palette, independent of the main app's light/dark
// theme (see the layout's doc comment) — this sits on top of a native
// macOS vibrancy blur (HudWindow material, always dark), so it needs its
// own tokens rather than the app's `--ink`/`--canvas` vars, which assume an
// opaque surface underneath them.
const glass = {
  text: "rgba(255,255,255,0.94)",
  textDim: "rgba(255,255,255,0.58)",
  textFaint: "rgba(255,255,255,0.38)",
  divider: "rgba(255,255,255,0.10)",
  chipBg: "rgba(255,255,255,0.08)",
  chipBorder: "rgba(255,255,255,0.12)",
  accent: "#7fb0ff",
  accentDim: "rgba(127,176,255,0.16)",
  success: "#5fe3ac",
  successDim: "rgba(95,227,172,0.14)",
  danger: "#ff8a8a",
  dangerDim: "rgba(255,138,138,0.14)",
};

// Shared button look for this panel — small, glass "chip" style rather than
// the main app's solid .btn classes (which assume an opaque surface behind
// them and aren't meant to sit on a blurred, borderless window).
function glassButtonStyle(tone: "neutral" | "success" | "danger" = "neutral"): React.CSSProperties {
  const tint = tone === "success" ? glass.successDim : tone === "danger" ? glass.dangerDim : glass.chipBg;
  const color = tone === "success" ? glass.success : tone === "danger" ? glass.danger : glass.text;
  return {
    background: tint,
    color,
    border: `1px solid ${tone === "neutral" ? glass.chipBorder : "transparent"}`,
    borderRadius: 8,
    padding: "5px 10px",
    fontSize: 11.5,
    fontWeight: 600,
    lineHeight: 1.2,
  };
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(LOCAL_CAPTURE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

function formatEventTime(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

// The floating panel's content — content-only now (see CompanionRail.tsx
// for the separate, persistent icon rail that opens/switches this window).
// Which of the three `View` bodies renders is read from the `?view=`
// query param this window was navigated to (see desktop-app's
// select_companion_view) — the one exception is auto-jumping to "live" in
// place if a new recording starts while this window is already open on
// something else. Sits directly on the native vibrancy blur (see
// desktop-app's build_content_window) — nothing here paints a solid
// background, by design.
export default function CompanionPanel({ upcomingEvents, fastPoll = false }: { upcomingEvents: UpcomingEvent[]; fastPoll?: boolean }) {
  const searchParams = useSearchParams();
  const isTauri = useInDesktopApp();
  const [session, setSession] = useState<Session | null>(null);
  const [dealState, setDealState] = useState<DealState | null>(null);
  const [notes, setNotes] = useState<RecentNoteItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [copiedEventId, setCopiedEventId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<View>(() => {
    const param = searchParams.get("view");
    return param === "live" || param === "notes" ? param : "calendar";
  });
  const hadSessionRef = useRef(false);

  useEffect(() => {
    const initial = readSession();
    setSession(initial);
    hadSessionRef.current = Boolean(initial);
    // Deliberately NOT forcing activeView to "live" here even if a call is
    // already active on mount — this window only mounts fresh when the rail
    // navigates it to a specific ?view=, and CompanionRail.tsx is what
    // decides to send it to "live" for a genuinely NEW recording. Doing it
    // here too would override an explicit pick of Calendar/Notes made while
    // a call happened to already be running.

    // AppShell-style pattern (see LocalCaptureBanner) — this window doesn't
    // remount on its own just because a call starts, so a plain mount-time
    // read wouldn't notice one beginning after this window was already
    // open. Jump to "live" only on the null -> non-null transition (a
    // genuinely new call starting while this window is sitting open on
    // something else), never on the reverse or on re-fires with the same
    // session — otherwise stopping a call while browsing Notes would yank
    // you back to a tab about to go empty.
    const onChange = () => {
      const next = readSession();
      setSession(next);
      if (next && !hadSessionRef.current) setActiveView("live");
      hadSessionRef.current = Boolean(next);
    };
    window.addEventListener(LOCAL_CAPTURE_EVENT, onChange);
    return () => window.removeEventListener(LOCAL_CAPTURE_EVENT, onChange);
  }, []);

  // Polls while a call is active so terms/notes reflect the same throttled
  // extraction pass the main deal page shows — not truly real-time, just
  // not stale for more than one poll cycle. `fastPoll` (set from
  // DEMO_FAST_EXTRACTION, see companion/page.tsx) shortens this to match
  // the realtime webhook's faster extraction cadence when recording a demo.
  useEffect(() => {
    if (!session) {
      setDealState(null);
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/companion/state?dealId=${session!.dealId}`);
        if (cancelled) return;
        // A failed poll used to fail completely silently — the panel just
        // kept showing "Nothing captured yet. Keep talking." forever, which
        // reads exactly like extraction genuinely isn't working even when
        // the real cause is an expired session or a deal you've lost access
        // to. Surface it instead of hiding it.
        if (!res.ok) {
          setError(
            res.status === 401
              ? "Signed out — reopen the app to sign back in."
              : res.status === 404
                ? "Can't find this deal — it may not be visible to you."
                : "Couldn't load live deal data."
          );
          return;
        }
        const data = (await res.json()) as DealState;
        if (!cancelled) {
          setDealState(data);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Couldn't reach SealMe — check your connection.");
      }
    }
    load();
    // Pauses while the companion window is hidden; catches up on reopen.
    let interval: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (interval === null) interval = setInterval(load, fastPoll ? 2000 : 15000);
    };
    const stop = () => {
      if (interval !== null) clearInterval(interval);
      interval = null;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        load();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [session, fastPoll]);

  // Lazy-loaded once, the first time the Notes tab is actually opened —
  // cached afterward so flipping tabs back and forth doesn't re-fetch.
  useEffect(() => {
    if (activeView !== "notes" || notes !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/companion/notes");
        if (cancelled) return;
        if (!res.ok) {
          // Same as the live-state poll: leaving `notes` null lets this
          // retry the next time the Notes tab is opened, but surface why
          // it's stuck on "Loading…" instead of just leaving it there.
          setError(res.status === 401 ? "Signed out — reopen the app to sign back in." : "Couldn't load notes.");
          return;
        }
        const data = (await res.json()) as { items: RecentNoteItem[] };
        if (!cancelled) {
          setNotes(data.items);
          setError(null);
        }
      } catch {
        if (!cancelled) setError("Couldn't reach SealMe — check your connection.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeView, notes]);

  async function joinCall(url: string) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } catch (err) {
      console.error("[companion] openUrl failed:", err);
      setError("Couldn't open that link");
    }
  }

  async function copyLink(eventId: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedEventId(eventId);
      setTimeout(() => setCopiedEventId((id) => (id === eventId ? null : id)), 1500);
    } catch {
      setError("Couldn't copy the link");
    }
  }

  async function goToMainApp() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("toggle_companion_rail");
    } catch (err) {
      console.error("[companion] toggle_companion_rail failed:", err);
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "Couldn't open the main app");
    }
  }

  async function handleStop() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<StopResult>("stop_local_capture_and_upload", { token: session.token });
      if (!result.ok) {
        setError(result.error ?? "Something went wrong stopping the recording");
        setBusy(false);
        return;
      }
      localStorage.removeItem(LOCAL_CAPTURE_STORAGE_KEY);
      window.dispatchEvent(new Event(LOCAL_CAPTURE_EVENT));
      setSession(null);
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong stopping the recording");
      setBusy(false);
    }
  }

  async function handleDiscard() {
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("discard_local_capture").catch(() => {});
    } finally {
      localStorage.removeItem(LOCAL_CAPTURE_STORAGE_KEY);
      window.dispatchEvent(new Event(LOCAL_CAPTURE_EVENT));
      setSession(null);
      setBusy(false);
      setConfirmingDiscard(false);
    }
  }

  if (isTauri === null) return null;

  if (!isTauri) {
    return (
      <div className="flex h-full items-center justify-center p-5 text-center text-[13px]" style={{ color: glass.textDim }}>
        This panel only works inside the SealMe desktop app.
      </div>
    );
  }

  const groups = new Map<string, DealField[]>();
  for (const field of dealState?.fields ?? []) {
    if (!groups.has(field.groupLabel)) groups.set(field.groupLabel, []);
    groups.get(field.groupLabel)!.push(field);
  }

  return (
    <div className="flex h-full flex-col" style={{ borderRadius: 16, overflow: "hidden" }}>
      <div className="flex flex-none items-center justify-between gap-2 px-4 py-3" style={{ borderBottom: `1px solid ${glass.divider}` }}>
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="inline-flex h-1.5 w-1.5 flex-none rounded-full"
            style={{ background: session ? glass.success : glass.textFaint }}
          />
          <span className="truncate text-[12.5px] font-semibold" style={{ color: glass.text, letterSpacing: "-0.1px" }}>
            SealMe
          </span>
        </div>
        <button
          type="button"
          onClick={goToMainApp}
          aria-label="Open main app"
          title="Open main app"
          className="flex flex-none items-center justify-center rounded-[7px]"
          style={{ width: 24, height: 24, color: glass.textDim, cursor: "pointer" }}
        >
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" width={13} height={13}>
            <path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3" />
            <path d="M12 3h5v5M16.5 3.5 9 11" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {error && (
            <div className="mb-3 rounded-[8px] px-3 py-2 text-[11.5px]" style={{ background: glass.dangerDim, color: glass.danger }}>
              {error}
            </div>
          )}

          {activeView === "live" &&
            (session ? (
              <div className="flex flex-col gap-5">
                <div
                  className="flex flex-col gap-2 rounded-[12px] px-3.5 py-3"
                  style={{ background: glass.successDim, border: `1px solid rgba(95,227,172,0.22)` }}
                >
                  <div className="flex items-center gap-2">
                    <span className="relative flex h-2 w-2 flex-none">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: glass.success }} />
                      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: glass.success }} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold" style={{ color: glass.text }}>
                      {dealState?.clientName ?? "Recording…"}
                    </span>
                  </div>
                  {confirmingDiscard ? (
                    <div className="flex items-center gap-2">
                      <span className="flex-1 text-[11.5px]" style={{ color: glass.textDim }}>Discard this recording?</span>
                      <button type="button" disabled={busy} onClick={handleDiscard} style={glassButtonStyle("danger")}>
                        Yes, discard
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirmingDiscard(false)} style={glassButtonStyle("neutral")}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button type="button" disabled={busy} onClick={handleStop} style={glassButtonStyle("success")}>
                        {busy ? "Finishing…" : "Stop & finish"}
                      </button>
                      <button type="button" disabled={busy} onClick={() => setConfirmingDiscard(true)} style={glassButtonStyle("neutral")}>
                        Discard
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <h2 className="mb-2 text-[10.5px] font-semibold uppercase" style={{ color: glass.textFaint, letterSpacing: "0.06em" }}>
                    Deal terms
                  </h2>
                  {groups.size === 0 ? (
                    <p className="text-[12px]" style={{ color: glass.textDim }}>Nothing captured yet. Keep talking.</p>
                  ) : (
                    <div className="flex flex-col">
                      {[...groups.entries()].map(([label, rows]) => (
                        <div key={label} className="py-2 first:pt-0" style={{ borderTop: `1px solid ${glass.divider}` }}>
                          <div className="pb-1 text-[10px] font-semibold uppercase" style={{ color: glass.textFaint, letterSpacing: "0.05em" }}>
                            {label}
                          </div>
                          {rows.map((row) => (
                            <div key={row.id} className="flex items-center justify-between gap-2 py-1">
                              <span className="text-[12px]" style={{ color: glass.textDim }}>{row.label}</span>
                              <span className="truncate text-[12px] font-medium" style={{ color: glass.text }}>{row.value ?? "—"}</span>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div
                  style={
                    {
                      "--ink-muted": glass.textDim,
                      "--hairline-soft": glass.divider,
                      "--surface-2": glass.chipBg,
                      "--accent-blue": glass.accent,
                    } as React.CSSProperties
                  }
                >
                  <h2 className="mb-2 text-[10.5px] font-semibold uppercase" style={{ color: glass.textFaint, letterSpacing: "0.06em" }}>
                    Call notes
                  </h2>
                  <div style={{ color: glass.text }}>
                    <CallHighlightsList items={dealState?.callHighlights ?? []} />
                  </div>
                </div>
              </div>
            ) : (
              <p className="py-10 text-center text-[12.5px]" style={{ color: glass.textDim }}>
                No active call. Start recording from the main app to see live terms here.
              </p>
            ))}

          {activeView === "calendar" && (
            <div>
              <h2 className="mb-2 text-[10.5px] font-semibold uppercase" style={{ color: glass.textFaint, letterSpacing: "0.06em" }}>
                Upcoming
              </h2>
              {upcomingEvents.length === 0 ? (
                <p className="py-6 text-center text-[12.5px]" style={{ color: glass.textDim }}>
                  Nothing scheduled. Start a call from the main app to see it here.
                </p>
              ) : (
                <div className="flex flex-col">
                  {upcomingEvents.map((event) => {
                    const open = expandedEventId === event.id;
                    return (
                      <div key={event.id} className="py-1 first:pt-0" style={{ borderTop: `1px solid ${glass.divider}` }}>
                        <button
                          type="button"
                          onClick={() => setExpandedEventId(open ? null : event.id)}
                          className="flex w-full items-center gap-2 rounded-[8px] py-1.5 text-left"
                          style={{ cursor: "pointer" }}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12.5px] font-medium" style={{ color: glass.text }}>{event.title}</div>
                            <div className="text-[11px]" style={{ color: glass.textDim }}><ClientText text={() => formatEventTime(event.startTime)} /></div>
                          </div>
                          <svg
                            viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"
                            width={11} height={11}
                            style={{ color: glass.textFaint, flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }}
                          >
                            <path d="M7 4l6 6-6 6" />
                          </svg>
                        </button>
                        {open && (
                          <div className="flex flex-col gap-2 rounded-[10px] px-2.5 py-2.5" style={{ background: glass.chipBg, marginBottom: 6 }}>
                            <div className="flex items-center justify-between gap-2 text-[11.5px]" style={{ color: glass.textDim }}>
                              <span>{PLATFORM_LABEL[event.platform] ?? event.platform} · {event.durationMinutes} min</span>
                              {event.clientName && <span className="truncate" style={{ color: glass.text }}>{event.clientName}</span>}
                            </div>
                            {event.meetingUrl ? (
                              <div className="flex items-center gap-2">
                                <button type="button" onClick={() => joinCall(event.meetingUrl!)} style={{ ...glassButtonStyle("success"), flex: 1, cursor: "pointer" }}>
                                  Join call
                                </button>
                                <button
                                  type="button"
                                  onClick={() => copyLink(event.id, event.meetingUrl!)}
                                  title="Copy link"
                                  aria-label="Copy link"
                                  className="flex flex-none items-center justify-center rounded-[8px]"
                                  style={{ width: 28, height: 28, border: `1px solid ${glass.chipBorder}`, color: glass.text, cursor: "pointer" }}
                                >
                                  {copiedEventId === event.id ? (
                                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" width={12} height={12}>
                                      <path d="M4 10l4 4 8-8" />
                                    </svg>
                                  ) : (
                                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" width={12} height={12}>
                                      <rect x="7" y="7" width="9" height="9" rx="1.5" />
                                      <path d="M4.5 12.5V5.5a1 1 0 0 1 1-1h7" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                            ) : (
                              <span className="text-[11.5px]" style={{ color: glass.textFaint }}>No call link on this event.</span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeView === "notes" && (
            <div
              style={
                {
                  "--ink-muted": glass.textDim,
                  "--hairline-soft": glass.divider,
                  "--surface-2": glass.chipBg,
                  "--accent-blue": glass.accent,
                } as React.CSSProperties
              }
            >
              <h2 className="mb-2 text-[10.5px] font-semibold uppercase" style={{ color: glass.textFaint, letterSpacing: "0.06em" }}>
                Notes
              </h2>
              <div style={{ color: glass.text }}>
                {notes === null ? (
                  <p className="py-6 text-center text-[12.5px]" style={{ color: glass.textDim }}>Loading…</p>
                ) : (
                  <RecentNotesList items={notes} />
                )}
              </div>
            </div>
          )}
      </div>
    </div>
  );
}
