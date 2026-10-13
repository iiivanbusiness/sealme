"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { inMobileApp } from "@/lib/native-shell";
import { formatClock, recorder, type RecorderStatus } from "@/lib/native-recorder";

// In the iPhone app: while a meeting is being recorded and you're anywhere
// but the recorder, a bar at the top to get back to it.
export default function RecordingBanner() {
  const pathname = usePathname();
  const [status, setStatus] = useState<RecorderStatus | null>(null);

  useEffect(() => {
    if (!inMobileApp()) return;
    let alive = true;
    const check = () =>
      recorder
        .status()
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    check();
    const timer = setInterval(check, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!status || status.state === "idle" || pathname === "/record") return null;
  const recording = status.state === "recording";
  return (
    <Link href="/record" className="card mx-3.5 mb-3 flex items-center gap-2.5 px-4 py-3 text-[13.5px] font-medium" style={{ color: "var(--ink)" }}>
      <span className={`record-dot inline-block h-2.5 w-2.5 flex-none rounded-full ${recording ? "record-dot-live" : ""}`} style={recording ? undefined : { background: "var(--ink-muted)" }} />
      <span className="flex-1">
        {recording ? "Recording" : "Recording paused"} <span className="font-mono-tab">{formatClock(status.seconds)}</span>
      </span>
      <span style={{ color: "var(--accent-blue)" }}>Back to it</span>
    </Link>
  );
}
