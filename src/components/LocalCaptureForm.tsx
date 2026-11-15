"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { startLiveCall } from "@/app/(app)/deals/new/live-actions";
import { useInDesktopApp } from "@/lib/native-shell";
import { WhoOnCall, WhatToMake, type TemplateOption } from "@/components/CallUploadForm";
import type { CallLeadOption } from "@/app/(app)/leads/search-actions";
import {
  LOCAL_CAPTURE_STORAGE_KEY,
  LOCAL_CAPTURE_EVENT,
  readCaptureSession,
  useCaptureSession,
  stopCapture,
  discardCapture,
  useLiveCallState,
  type CaptureSession,
} from "@/lib/live-capture-client";

// Defined in live-capture-client now; still importable from here.
export { LOCAL_CAPTURE_STORAGE_KEY, LOCAL_CAPTURE_EVENT, readCaptureSession, type CaptureSession };

// Start a call in the desktop app: who it's with and what SealMe makes
// (notes always, a proposal or contract when ticked), then the recording
// starts. Nothing joins the meeting; the app records the computer's audio.
// initialLead, who and name: the person from a meeting (see WhoOnCall).
// uploadHref: the way to upload instead, keeping that person.
export default function LocalCaptureForm({
  templates,
  searchLeads,
  who,
  name,
  initialLead,
  uploadHref = "/deals/new",
}: {
  templates: { proposal: TemplateOption[]; contract: TemplateOption[] };
  searchLeads: (q: string) => Promise<CallLeadOption[]>;
  who?: string;
  name?: string;
  initialLead?: CallLeadOption | null;
  uploadHref?: string;
}) {
  const router = useRouter();
  const isTauri = useInDesktopApp();
  const open = useCaptureSession();
  const [make, setMake] = useState<{ proposal: boolean; contract: boolean }>({ proposal: false, contract: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState<"stop" | "discard" | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  // Set before any await, so a second click on Start never gets through
  // while the first is still asking the app to record.
  const submitting = useRef(false);
  // While this form starts a call it keeps showing "Starting…", not the
  // still-recording view, until it has moved on to the lead.
  const showOpen = open !== null && !busy;
  const live = useLiveCallState(showOpen ? open.phoneCallId : null);
  // A call that ended or started somewhere else (the bar at the top, the
  // floating panel): a half-open "Discard this recording?" or an old error
  // was about the call before.
  const openToken = open?.token ?? null;
  const [shownToken, setShownToken] = useState(openToken);
  if (openToken !== shownToken) {
    setShownToken(openToken);
    setConfirmingDiscard(false);
    setError(null);
  }

  // onSubmit, not <form action>: an action runs as a transition, so neither
  // "Starting…" nor the disabled button showed until it was all over, and a
  // second click asked the app for a second recording.
  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current) return;
    // Another call still recording (the app closed mid-call, say): starting
    // now would take over its session and leave it on its lead as
    // "Recording now" with nothing to stop or discard it.
    if (readCaptureSession()) {
      setError("A call is still recording. Stop or discard it first");
      return;
    }
    const formData = new FormData(e.currentTarget);
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        await invoke("start_local_capture");
      } catch (err) {
        setError(typeof err === "string" ? err : "Couldn't start recording. Check your microphone and screen-recording permissions");
        setBusy(false);
        return;
      }
      try {
        const result = await startLiveCall(formData);
        if ("error" in result) {
          await invoke("discard_local_capture").catch(() => {});
          setError(result.error);
          setBusy(false);
          return;
        }
        // Sends a chunk of the recording about once a minute until Stop.
        await invoke("begin_live_updates", { token: result.token });
        const session: CaptureSession = { phoneCallId: result.phoneCallId, leadId: result.leadId, token: result.token, startedAt: Date.now() };
        localStorage.setItem(LOCAL_CAPTURE_STORAGE_KEY, JSON.stringify(session));
        window.dispatchEvent(new Event(LOCAL_CAPTURE_EVENT));
        router.push(`/leads/${result.leadId}`);
      } catch (err) {
        await invoke("discard_local_capture").catch(() => {});
        setError(err instanceof Error ? err.message : "Couldn't start recording");
        setBusy(false);
      }
    } finally {
      submitting.current = false;
    }
  }

  async function handleStop() {
    if (!open) return;
    setEnding("stop");
    setError(null);
    const { error } = await stopCapture(open);
    setEnding(null);
    // A stale session needs nothing more: `open` is already the current one.
    if (error) setError(error);
  }

  async function handleDiscard() {
    if (!open) return;
    setEnding("discard");
    setError(null);
    const { error } = await discardCapture(open);
    setEnding(null);
    setConfirmingDiscard(false);
    if (error) setError(error);
  }

  if (isTauri === null) return null;

  if (!isTauri) {
    return (
      <div className="card flex max-w-[560px] flex-col items-start gap-3 p-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        <div>Recording a call live works in the SealMe desktop app, for Mac and Windows. In the browser, upload the recording or paste the transcript once the call is over.</div>
        <Link href={uploadHref} className="btn btn-secondary btn-sm">
          Upload a recording or paste a transcript
        </Link>
      </div>
    );
  }

  const errorChip = error && <div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>;

  // Only one call records at a time. This is also the way out of a call
  // left behind by an app that closed mid-call.
  if (showOpen) {
    return (
      <div className="card flex max-w-[560px] flex-col gap-4 p-6">
        <div className="flex flex-col gap-1">
          <div className="text-[14px] font-semibold" style={{ color: "var(--ink)" }}>
            A call is still recording{live?.leadName ? ` · ${live.leadName}` : ""}
          </div>
          <div className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            Finish it or discard it to start the next one.
          </div>
        </div>
        {errorChip}
        {confirmingDiscard ? (
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>
              Discard this recording?
            </span>
            <button type="button" disabled={ending !== null} onClick={handleDiscard} className="btn btn-sm" style={{ background: "var(--warn)", color: "var(--on-primary, #fff)" }}>
              {ending === "discard" ? "Discarding…" : "Yes, discard"}
            </button>
            <button type="button" disabled={ending !== null} onClick={() => setConfirmingDiscard(false)} className="btn btn-secondary btn-sm">
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5">
            <button type="button" disabled={ending !== null} onClick={handleStop} className="btn btn-primary btn-sm">
              {ending === "stop" ? "Finishing…" : "Stop & finish"}
            </button>
            <button type="button" disabled={ending !== null} onClick={() => setConfirmingDiscard(true)} className="btn btn-secondary btn-sm">
              Discard
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="card flex max-w-[560px] flex-col gap-5 p-6">
      <WhoOnCall search={searchLeads} initial={who} name={name} initialLead={initialLead} />
      <WhatToMake templates={templates} make={make} onChange={setMake} />
      {errorChip}
      <div className="flex flex-col gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary w-full justify-center">
          {busy ? "Starting…" : "Start recording"}
        </button>
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          Let them know you&apos;re recording. Nothing joins the meeting. You can make a proposal or contract during the call, from the bar at the top.
        </span>
      </div>
    </form>
  );
}
