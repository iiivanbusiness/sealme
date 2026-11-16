"use client";

import { useEffect, useRef, useState } from "react";
import { useNowSeconds } from "./use-ticker";
import { formatElapsed, initialsOf } from "./paper-utils";
import { HangUpIcon, PersonIcon } from "./icons";
import { WaitingDots } from "./NextCard";
import s from "./contract.module.css";

// The call this contract is being written on: LIVE with how long it's been
// going and who's on it, and End call. After the call, while SealMe writes
// the notes, ENDED and "Finishing up". No mute: SealMe only listens, it
// can't mute anyone in the meeting.

export type CallPillProps = {
  state: "live" | "ended";
  // ISO time the call started (PhoneCall.startedAt).
  startedAt: string | null;
  // Who the call is with; null while nobody knows yet (a cold call to a
  // lead with no name), shown as "New lead" with no initials.
  name: string | null;
  // The person's title, else their company.
  sub?: string | null;
  // "contract" or "proposal", for what End call says stays a draft.
  documentLabel?: string;
  // Stops the recording. Only where it can be stopped from here (the
  // desktop app's own session); without it the pill shows `hint`.
  onEnd?: () => Promise<void> | void;
  onDiscard?: () => Promise<void> | void;
  hint?: string | null;
};

export default function CallPill({ state, startedAt, name, sub, documentLabel = "contract", onEnd, onDiscard, hint }: CallPillProps) {
  const live = state === "live";
  const startMs = startedAt ? Date.parse(startedAt) : Number.NaN;
  const nowSec = useNowSeconds(live && Number.isFinite(startMs));
  const timer = live && nowSec !== null && Number.isFinite(startMs) ? formatElapsed(nowSec * 1000 - startMs) : "";

  const [open, setOpen] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState<"end" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const endBtnRef = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Closes on a click outside or Escape (not while it's working).
  useEffect(() => {
    if (open) keepRef.current?.focus();
  }, [open, confirmDiscard]);
  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => {
      if (busyRef.current) return;
      setOpen(false);
      setConfirmDiscard(false);
      setError(null);
      if (refocus) endBtnRef.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close(true);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async (which: "end" | "discard") => {
    const action = which === "end" ? onEnd : onDiscard;
    if (!action) return;
    setBusy(which);
    setError(null);
    try {
      await action();
      setOpen(false);
      setConfirmDiscard(false);
    } catch (err) {
      // The action's own words when it gave some (the desktop app says why
      // it couldn't stop), else a plain retry.
      const said = err instanceof Error && err.message.trim() ? err.message.trim() : null;
      setError(said ?? (which === "end" ? "Couldn't end the call. Try again." : "Couldn't discard the recording. Try again."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={s.pill} data-state={state}>
      <span className={s.live} data-off={live ? undefined : ""}>
        <i aria-hidden="true" />
        {live ? "LIVE" : "ENDED"}
      </span>
      {live ? (
        <span className={s.timer} aria-label={timer ? `Call time ${timer}` : undefined}>
          {timer}
        </span>
      ) : (
        <span className={s.finishing}>
          Finishing up
          <WaitingDots />
        </span>
      )}
      <span className={s.vsep} aria-hidden="true" />
      <div className={s.who}>
        <span className={s.av} aria-hidden="true">
          {name?.trim() ? initialsOf(name) : <PersonIcon size={17} />}
        </span>
        <div className={s.whoText}>
          <b className={s.whoName}>{name?.trim() || "New lead"}</b>
          {sub && <span className={s.whoSub}>{sub}</span>}
        </div>
      </div>
      {live && (onEnd || hint) && (
        <>
          <span className={s.vsep} aria-hidden="true" />
          <div ref={boxRef} className={s.cbtns}>
            {onEnd ? (
              <button ref={endBtnRef} type="button" className={s.endBtn} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((o) => !o)} disabled={busy !== null}>
                <HangUpIcon />
                <span>{busy === "end" ? "Ending..." : "End call"}</span>
              </button>
            ) : (
              <span className={s.hint}>{hint}</span>
            )}
            {open && onEnd && (
              <div className={s.pop} role="dialog" aria-label="End the call">
                {confirmDiscard ? (
                  <>
                    <b className={s.popTitle}>Discard this recording?</b>
                    <p className={s.popText}>The recording and everything SealMe made from this call are thrown away. This can&apos;t be undone.</p>
                    {error && <p className={s.popError}>{error}</p>}
                    <div className={s.popRow}>
                      <button ref={keepRef} type="button" className={s.cbtn} onClick={() => setConfirmDiscard(false)} disabled={busy !== null}>
                        Back
                      </button>
                      <button type="button" className={s.cbtn} data-variant="danger" onClick={() => run("discard")} disabled={busy !== null} aria-busy={busy === "discard" || undefined}>
                        {busy === "discard" ? "Discarding..." : "Discard"}
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <b className={s.popTitle}>End the call?</b>
                    <p className={s.popText}>The {documentLabel} stays a draft. You can still fill in terms and send it after.</p>
                    {error && <p className={s.popError}>{error}</p>}
                    <div className={s.popRow}>
                      <button ref={keepRef} type="button" className={s.cbtn} onClick={() => setOpen(false)} disabled={busy !== null}>
                        Keep talking
                      </button>
                      <button type="button" className={s.cbtn} data-variant="danger" onClick={() => run("end")} disabled={busy !== null} aria-busy={busy === "end" || undefined}>
                        {busy === "end" ? "Ending..." : "End call"}
                      </button>
                    </div>
                    {onDiscard && (
                      <div className={s.popFoot}>
                        <button type="button" className={s.linkBtn} onClick={() => setConfirmDiscard(true)} disabled={busy !== null}>
                          Discard recording
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
