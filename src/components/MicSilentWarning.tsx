"use client";

import { useEffect, useState } from "react";

// A local recording's transcript has the Mac's sound on "Client:" lines and
// the mic on "You:" lines (see deepgram.ts). LiveDealView shows this when the
// other side comes through and the mic hasn't given a single word: a whole
// minute of that most likely means macOS isn't letting SealMe use the
// microphone (permission off, or the input device went away), and nothing
// else says so. Saying it while the call is still going lets the rep fix it.
const AFTER_SECONDS = 60;

export default function MicSilentWarning({ startedAt, endedAt }: { startedAt: Date; endedAt: Date | null }) {
  // Timestamps, not the Dates: every poll brings new Date objects.
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : null;
  const [show, setShow] = useState(false);
  useEffect(() => {
    const check = () => setShow((end ?? Date.now()) - start > AFTER_SECONDS * 1000);
    check();
    if (end !== null) return;
    const timer = setInterval(check, 10_000);
    return () => clearInterval(timer);
  }, [start, end]);

  if (!show) return null;
  return (
    <div className="mt-2 rounded-[8px] px-3 py-2 text-[12px] leading-relaxed" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
      {end === null ? "We can hear the other side but not you." : "We heard the other side but not you."} Check your microphone in System Settings &gt; Privacy &amp; Security &gt; Microphone.
    </div>
  );
}
