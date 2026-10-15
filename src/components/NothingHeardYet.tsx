"use client";

import { useEffect, useState } from "react";

// A recording is sent for transcription about once a minute. If a couple of
// those have gone by and not a word came back, the Mac most likely isn't
// letting SealMe hear the meeting: say so while the call can still be saved.
const AFTER_SECONDS = 150;

export default function NothingHeardYet({ startedAt }: { startedAt: Date }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const check = () => setShow(Date.now() - new Date(startedAt).getTime() > AFTER_SECONDS * 1000);
    check();
    const timer = setInterval(check, 10_000);
    return () => clearInterval(timer);
  }, [startedAt]);

  if (!show) return null;
  return (
    <div className="mt-2 rounded-[8px] px-3 py-2 text-[12px] leading-relaxed" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
      SealMe hasn&apos;t heard anyone on this call yet. Check that the meeting&apos;s sound plays on this Mac, and that SealMe is allowed in System Settings, Privacy &amp; Security, under both Microphone and Screen &amp; System Audio Recording.
    </div>
  );
}
