"use client";

import Link from "next/link";
import { useInDesktopApp } from "@/lib/native-shell";

// The one big button on the page (.btn's own padding wins over utilities).
const BIG = { padding: "13px 24px", fontSize: 15 };

// The top of the Dashboard. In the desktop app a call is recorded right
// there, so Start a call goes straight to recording, with uploading a
// recording as the other way in. A browser can't record a call, so it says
// where that happens and offers the upload or paste for after the call
// (there's no download link to give yet). The server can't tell the two
// apart: until the page knows (null), both are in the page and globals.css
// shows the right one (the inline script in app/layout.tsx sets
// data-desktop before the first paint), so neither flashes. The iPhone app has its own pair on the Dashboard page.
export default function StartCallCard() {
  const desktop = useInDesktopApp();
  return (
    <section className="glass-card glass-card-solid p-5 sm:p-6" aria-label="Start a call">
      {desktop !== false && (
        <div className="desktop-app-only flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1 basis-[260px]">
            <h2 className="text-[19px] font-medium" style={{ letterSpacing: "-0.4px" }}>Start a call</h2>
            <p className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
              SealMe records the call on this computer and writes the notes, and a proposal or contract if you want one. Nothing joins the meeting.
            </p>
          </div>
          <div className="flex w-full flex-wrap gap-2.5 sm:w-auto">
            <Link href="/deals/new?mode=local" className="btn btn-primary flex-1 justify-center sm:flex-none" style={BIG}>
              <span aria-hidden className="record-dot inline-block h-2.5 w-2.5 rounded-full" />
              Start a call
            </Link>
            <Link href="/deals/new" className="btn btn-secondary flex-1 justify-center sm:flex-none" style={{ padding: "13px 20px" }}>
              Upload a recording
            </Link>
          </div>
        </div>
      )}
      {desktop !== true && (
        <div className="browser-only flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1 basis-[260px]">
            <h2 className="text-[19px] font-medium" style={{ letterSpacing: "-0.4px" }}>Start a call</h2>
            <p className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
              Calls are recorded live in the SealMe desktop app, for Mac and Windows. After a call, upload the recording or paste the transcript here.
            </p>
          </div>
          <Link href="/deals/new" className="btn btn-primary w-full justify-center sm:w-auto" style={BIG}>
            Upload or paste a call
          </Link>
        </div>
      )}
    </section>
  );
}
