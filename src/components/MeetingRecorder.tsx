"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { LeadPicker, type LeadOption } from "@/components/CallUploadForm";
import { formatClock, recorder, recorderError, type RecorderStatus, type SavedRecording } from "@/lib/native-recorder";
import { transcriptFromListenResponse } from "@/lib/recording-transcript";
import { formatCallDuration, formatFileSize } from "@/lib/recording-upload";

// Shorter than this isn't a meeting (usually Record tapped by mistake), and
// isn't written up; matches MIN_PROCESS_SECONDS in lib/call-inbox.ts.
const MIN_SECONDS = 30;

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "live"; status: RecorderStatus }
  | { kind: "sending"; step: "uploading" | "transcribing" | "saving"; progress: number }
  | { kind: "error"; message: string; recording: SavedRecording | null }
  | { kind: "too-short"; recording: SavedRecording };

const STATE_LINE: Record<string, string> = {
  recording: "Recording",
  paused: "Paused",
  interrupted: "Paused for a call. It carries on by itself after.",
};

// The iPhone app's "Record a meeting": the phone's own recorder (Swift,
// see lib/native-recorder.ts) runs it, so it goes on with the screen locked.
// Stop sends the recording straight to transcription, then saves it as
// notes on the client's lead (picked here, or found from the call) and only
// then deletes it from the phone. A recording that didn't make it (no
// signal, the app closed) stays on the phone and is offered here again.
export default function MeetingRecorder({ save, searchLeads }: { save: (formData: FormData) => Promise<void>; searchLeads: (q: string) => Promise<LeadOption[]> }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [unsent, setUnsent] = useState<SavedRecording[]>([]);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  // Opening the page: back to a recording that's running, and whatever
  // wasn't sent.
  useEffect(() => {
    let cancelled = false;
    Promise.all([recorder.status(), recorder.pending()])
      .then(([status, pending]) => {
        if (cancelled) return;
        setUnsent(pending);
        setPhase(status.state === "idle" ? { kind: "ready" } : { kind: "live", status });
      })
      .catch((err) => !cancelled && setPhase({ kind: "error", message: recorderError(err).message, recording: null }));
    return () => {
      cancelled = true;
    };
  }, []);

  // The clock and the level while it records.
  const live = phase.kind === "live";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      recorder
        .status()
        .then((status) => setPhase((p) => (p.kind === "live" ? { kind: "live", status } : p)))
        .catch(() => {});
    }, 500);
    return () => clearInterval(timer);
  }, [live]);

  async function run(step: () => Promise<RecorderStatus>) {
    setBusy(true);
    try {
      setPhase({ kind: "live", status: await step() });
    } catch (err) {
      setPhase({ kind: "error", message: recorderError(err).message, recording: null });
    } finally {
      setBusy(false);
    }
  }

  async function stopAndSend() {
    setBusy(true);
    let saved: SavedRecording;
    try {
      saved = await recorder.stop();
    } catch (err) {
      setPhase({ kind: "error", message: recorderError(err).message, recording: null });
      return;
    } finally {
      setBusy(false);
    }
    await send(saved);
  }

  async function send(recording: SavedRecording) {
    if (recording.seconds < MIN_SECONDS) {
      setPhase({ kind: "too-short", recording });
      return;
    }
    const leadId = form.current ? String(new FormData(form.current).get("leadId") ?? "new") : "new";
    setPhase({ kind: "sending", step: "uploading", progress: 0 });
    const progress = setInterval(() => {
      recorder
        .status()
        .then((s) => {
          // Not there until the upload has started.
          if (typeof s.uploadProgress !== "number" || !Number.isFinite(s.uploadProgress)) return;
          const sent = s.uploadProgress;
          setPhase((p) => (p.kind === "sending" && p.step !== "saving" ? { kind: "sending", step: sent >= 0.999 ? "transcribing" : "uploading", progress: sent } : p));
        })
        .catch(() => {});
    }, 500);
    try {
      const tokenRes = await fetch("/api/recordings/token", { method: "POST" });
      const grant = (await tokenRes.json()) as { mode?: string; token?: string; listenUrl?: string; error?: string };
      if (!tokenRes.ok) throw new Error(grant.error || "Recordings can't be sent right now");
      if (grant.mode !== "direct" || !grant.token || !grant.listenUrl) throw new Error("Recordings can't be sent right now. Try again in a minute");
      const res = await recorder.upload({ path: recording.path, url: grant.listenUrl, token: grant.token, contentType: "audio/aac" });
      clearInterval(progress);
      if (res.status < 200 || res.status >= 300) throw new Error(`The recording couldn't be transcribed (error ${res.status}). Try again`);
      const result = transcriptFromListenResponse(JSON.parse(res.body));
      if (!result.transcript.trim()) throw new Error("No one could be heard on the recording");

      setPhase({ kind: "sending", step: "saving", progress: 1 });
      const data = new FormData();
      data.set("transcript", result.transcript);
      data.set("seconds", String(Math.round(recording.seconds || result.seconds)));
      data.set("leadId", leadId);
      await save(data);
      // Saved: the recording can go from the phone.
      await recorder.discard(recording.path).catch(() => {});
      router.push("/notes?added=1");
    } catch (err) {
      clearInterval(progress);
      setPhase({ kind: "error", message: err instanceof Error ? err.message : recorderError(err).message, recording });
    }
  }

  async function remove(recording: SavedRecording) {
    if (deleting !== recording.path) return setDeleting(recording.path);
    await recorder.discard(recording.path).catch(() => {});
    setDeleting(null);
    setUnsent((list) => list.filter((r) => r.path !== recording.path));
  }

  const status = phase.kind === "live" ? phase.status : null;

  return (
    <form ref={form} onSubmit={(e) => e.preventDefault()} className="flex max-w-[560px] flex-col gap-4">
      {phase.kind === "loading" && <div className="card px-6 py-10 text-center text-[13.5px]" style={{ color: "var(--ink-muted)" }}>Getting the recorder ready…</div>}

      {phase.kind === "ready" && (
        <div className="card flex flex-col items-center gap-3 px-6 py-8 text-center">
          <button
            type="button"
            onClick={() => run(recorder.start)}
            disabled={busy}
            aria-label="Start recording"
            className="record-button flex h-[88px] w-[88px] items-center justify-center rounded-full"
            style={{ opacity: busy ? 0.6 : 1 }}
          >
            <span className="block h-[30px] w-[30px] rounded-full" style={{ background: "#fff" }} />
          </button>
          <div className="text-[15px] font-medium">{busy ? "Starting…" : "Start recording"}</div>
          <div className="max-w-[320px] text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            Let everyone know the meeting is being recorded. You can lock the phone; it keeps recording.
          </div>
        </div>
      )}

      {status && (
        <div className="card flex flex-col items-center gap-4 px-6 py-8 text-center">
          <div className="flex items-center gap-2 text-[13.5px] font-medium" style={{ color: status.state === "recording" ? "var(--ink)" : "var(--ink-muted)" }}>
            <span className={`record-dot inline-block h-2.5 w-2.5 rounded-full ${status.state === "recording" ? "record-dot-live" : ""}`} style={status.state === "recording" ? undefined : { background: "var(--ink-muted)" }} />
            {STATE_LINE[status.state] ?? "Recording"}
          </div>
          <div className="font-mono-tab text-[52px] font-medium leading-none" style={{ letterSpacing: "-1.5px" }} aria-live="off">
            {formatClock(status.seconds)}
          </div>
          {/* How loud the room is, so you can see it's picking people up. */}
          <div className="h-1.5 w-full max-w-[240px] overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }} aria-hidden="true">
            <div className="h-full rounded-full transition-[width] duration-200" style={{ width: `${Math.round(status.level * 100)}%`, background: "var(--ink)" }} />
          </div>
          <div className="mt-2 flex w-full gap-2.5">
            {status.state === "recording" ? (
              <button type="button" onClick={() => run(recorder.pause)} disabled={busy} className="btn btn-secondary flex-1 justify-center">
                Pause
              </button>
            ) : (
              <button type="button" onClick={() => run(recorder.resume)} disabled={busy} className="btn btn-secondary flex-1 justify-center">
                Resume
              </button>
            )}
            <button type="button" onClick={stopAndSend} disabled={busy} className="btn btn-primary flex-1 justify-center">
              Stop and get notes
            </button>
          </div>
        </div>
      )}

      {phase.kind === "sending" && (
        <div className="card flex flex-col gap-3 px-6 py-6" role="status">
          <div className="text-[14px] font-medium">
            {phase.step === "uploading" ? `Sending the recording… ${Math.round(phase.progress * 100)}%` : phase.step === "transcribing" ? "Turning it into a transcript…" : "Saving the notes…"}
          </div>
          <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }}>
            <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${phase.step === "uploading" ? Math.round(phase.progress * 100) : 100}%`, background: "var(--primary)" }} />
          </div>
          <div className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            Keep the app open until it&apos;s sent. If it doesn&apos;t make it, the recording stays on this phone and you can send it again.
          </div>
        </div>
      )}

      {phase.kind === "error" && (
        <div className="card flex flex-col gap-3 px-6 py-6">
          <div className="chip chip-warn whitespace-normal px-3 py-2 text-left text-[13px]">{phase.message}</div>
          <div className="flex gap-2.5">
            {phase.recording ? (
              <>
                <button type="button" onClick={() => send(phase.recording!)} className="btn btn-primary flex-1 justify-center">
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUnsent((list) => [phase.recording!, ...list.filter((r) => r.path !== phase.recording!.path)]);
                    setPhase({ kind: "ready" });
                  }}
                  className="btn btn-secondary flex-1 justify-center"
                >
                  Later
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setPhase({ kind: "ready" })} className="btn btn-secondary flex-1 justify-center">
                Back
              </button>
            )}
          </div>
        </div>
      )}

      {phase.kind === "too-short" && (
        <div className="card flex flex-col gap-3 px-6 py-6">
          <div className="text-[14px] font-medium">That was {formatCallDuration(Math.round(phase.recording.seconds))}</div>
          <div className="text-[13px]" style={{ color: "var(--ink-muted)" }}>
            Recordings under {MIN_SECONDS} seconds are too short to write up.
          </div>
          <button
            type="button"
            onClick={async () => {
              await recorder.discard(phase.recording.path).catch(() => {});
              setUnsent((list) => list.filter((r) => r.path !== phase.recording.path));
              setPhase({ kind: "ready" });
            }}
            className="btn btn-secondary justify-center"
          >
            Delete it
          </button>
        </div>
      )}

      {(phase.kind === "ready" || phase.kind === "live") && (
        <div className="card p-5">
          <LeadPicker search={searchLeads} />
        </div>
      )}

      {phase.kind === "ready" && unsent.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 pb-1 pt-4 text-[13px] font-medium">Not sent yet</div>
          {unsent.map((r, i) => (
            <div key={r.path} className="flex items-center gap-3 px-5 py-3" style={i ? { borderTop: "1px solid var(--hairline-soft)" } : undefined}>
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="font-medium">{new Date(r.startedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>
                <div style={{ color: "var(--ink-muted)" }}>
                  {formatCallDuration(Math.round(r.seconds))} · {formatFileSize(r.bytes)}
                </div>
              </div>
              <button type="button" onClick={() => remove(r)} className="text-[12.5px] font-medium" style={{ color: deleting === r.path ? "#c0392b" : "var(--ink-muted)" }}>
                {deleting === r.path ? "Tap to delete" : "Delete"}
              </button>
              <button type="button" onClick={() => send(r)} className="btn btn-secondary btn-sm">
                Get notes
              </button>
            </div>
          ))}
        </div>
      )}
    </form>
  );
}
