"use client";

import { useEffect, useRef, useState } from "react";
import SubmitButton from "@/components/SubmitButton";
import { transcriptFromCaptionFile } from "@/lib/recording-transcript";
import { formatCallDuration as formatDuration, formatFileSize as formatSize, isRecordingFile, transcribeRecordingFile } from "@/lib/recording-upload";

type Stage = { kind: "idle" } | { kind: "uploading"; progress: number } | { kind: "transcribing" } | { kind: "ready"; seconds: number; turns: number } | { kind: "error"; message: string };

export type LeadOption = { id: string; name: string; company: string | null };

// "Recording or transcript" on Start a call: upload the call's video or
// audio (transcribed by Deepgram, then shown for a check) or paste the
// transcript / load it from a text file. Then either the deal terms are
// read and a contract drafted, or (Notes only) the call is written up on a
// lead and nothing else. On the Notes page it's notes only (notesOnly:
// `action` writes the call up, no templates, no choice to make), and
// `back` is where the person lands after. `phone` (the iPhone app) words
// the file picker for a phone, where nothing is dragged in.
export default function CallUploadForm({
  templates,
  action,
  notesAction,
  searchLeads,
  notesOnly = false,
  back,
  phone = false,
}: {
  templates: { id: string; name: string }[];
  action: (formData: FormData) => Promise<void>;
  notesAction?: (formData: FormData) => Promise<void>;
  searchLeads?: (q: string) => Promise<LeadOption[]>;
  notesOnly?: boolean;
  back?: string;
  phone?: boolean;
}) {
  const [need, setNeed] = useState<"contract" | "notes">("contract");
  const notes = notesOnly || (need === "notes" && Boolean(notesAction));
  const [source, setSource] = useState<"recording" | "text">("recording");
  const [transcript, setTranscript] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [textFileNote, setTextFileNote] = useState<string | null>(null);
  const recordingInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLInputElement>(null);

  async function transcribe(f: File) {
    setFile(f);
    setTranscript("");
    setStage({ kind: "uploading", progress: 0 });
    try {
      const result = await transcribeRecordingFile(f, {
        onProgress: (progress) => setStage({ kind: "uploading", progress }),
        onUploaded: () => setStage({ kind: "transcribing" }),
      });
      setTranscript(result.transcript);
      setStage({ kind: "ready", seconds: result.seconds, turns: result.turns });
    } catch (err) {
      setStage({ kind: "error", message: err instanceof Error ? `${err.message}.` : "Couldn't transcribe that recording." });
    }
  }

  function pickRecording(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    if (!isRecordingFile(f)) {
      setStage({ kind: "error", message: "That isn't an audio or video file." });
      return;
    }
    void transcribe(f);
  }

  async function pickTextFile(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    const raw = await f.text();
    const isCaptions = /\.(vtt|srt)$/i.test(f.name) || raw.trimStart().startsWith("WEBVTT");
    setTranscript(isCaptions ? transcriptFromCaptionFile(raw) : raw.trim());
    setTextFileNote(`Loaded ${f.name}. Check it below${notes ? "" : ", then pick a template"}.`);
  }

  const busy = stage.kind === "uploading" || stage.kind === "transcribing";
  const seconds = stage.kind === "ready" ? stage.seconds : 0;
  const canSubmit = transcript.trim().length > 0 && !busy;
  const tab = (key: "recording" | "text", label: string) => (
    <button
      type="button"
      onClick={() => setSource(key)}
      disabled={busy}
      aria-pressed={source === key}
      className="btn btn-sm flex-1 justify-center"
      style={source === key ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "transparent", color: "var(--ink-muted)" }}
    >
      {label}
    </button>
  );

  return (
    <form action={notes && !notesOnly ? notesAction : action} className="card flex max-w-[560px] flex-col gap-4 p-6">
      <input type="hidden" name="source" value={source === "recording" ? "recording" : "text"} />
      <input type="hidden" name="seconds" value={seconds} />
      {back && <input type="hidden" name="back" value={back} />}
      {notesAction && !notesOnly && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">What you need</span>
          <div className="flex rounded-full p-[3px] text-[13px]" style={{ background: "var(--surface-2)" }} role="radiogroup" aria-label="What you need">
            {(["contract", "notes"] as const).map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={need === n}
                onClick={() => setNeed(n)}
                className="flex-1 rounded-full px-3 py-1.5 font-medium"
                style={need === n ? { background: "var(--surface-1)", color: "var(--ink)", boxShadow: "0 0 0 1px var(--hairline)" } : { color: "var(--ink-muted)" }}
              >
                {n === "contract" ? "Notes and contract" : "Notes only"}
              </button>
            ))}
          </div>
          <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
            {notes ? "SealMe writes up the call on the lead and sets up the next step. No deal, no contract." : "SealMe reads the agreed terms and drafts the contract for you to check."}
          </span>
        </div>
      )}
      <div className="flex gap-1 rounded-full border p-1" style={{ borderColor: "var(--hairline)", background: "var(--surface-1)" }}>
        {tab("recording", "Recording")}
        {tab("text", "Transcript")}
      </div>

      {source === "recording" ? (
        <div className="flex flex-col gap-3">
          <input
            ref={recordingInput}
            type="file"
            accept="audio/*,video/*,.mp4,.mov,.m4a,.mp3,.wav,.webm,.mkv"
            className="hidden"
            onChange={(e) => {
              pickRecording(e.target.files);
              e.target.value = "";
            }}
          />
          {stage.kind === "idle" || stage.kind === "error" ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickRecording(e.dataTransfer.files);
              }}
              className="flex flex-col items-center gap-2.5 rounded-[14px] border border-dashed px-5 py-8 text-center transition-colors"
              style={{ borderColor: dragging ? "var(--accent-blue)" : "var(--hairline)", background: dragging ? "var(--canvas)" : undefined }}
            >
              <div className="text-[14px] font-medium">{phone ? "Add the call recording" : "Drop the call recording here"}</div>
              <div className="max-w-[380px] text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
                {phone
                  ? "A video from Photos or a recording from Files. SealMe turns it into a transcript you can check before anything else happens."
                  : "Video or audio from Zoom, Meet, Teams or your phone: MP4, MOV, M4A, MP3, WAV or WEBM. SealMe turns it into a transcript you can check before anything else happens."}
              </div>
              <button type="button" onClick={() => recordingInput.current?.click()} className="btn btn-secondary btn-sm mt-1">
                Choose a file
              </button>
              {stage.kind === "error" && <div className="chip chip-warn mt-1 whitespace-normal px-3 py-2 text-left text-[12.5px]">{stage.message}</div>}
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-[14px] border px-4 py-3.5" style={{ borderColor: "var(--hairline)" }}>
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate font-medium" title={file?.name}>{file?.name}</span>
                <span className="flex-none" style={{ color: "var(--ink-muted)" }}>{file ? formatSize(file.size) : ""}</span>
              </div>
              {stage.kind === "uploading" && (
                <>
                  <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--canvas)" }}>
                    <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${stage.progress}%`, background: "var(--primary)" }} />
                  </div>
                  <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Uploading… {stage.progress}%</div>
                </>
              )}
              {stage.kind === "transcribing" && (
                <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
                  Transcribing the call. A long recording can take a minute or two.
                </div>
              )}
              {stage.kind === "ready" && (
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>
                  <span>
                    Transcript ready · {formatDuration(stage.seconds)} of audio{stage.turns ? ` · ${stage.turns} ${stage.turns === 1 ? "turn" : "turns"}` : ""}
                  </span>
                  <button type="button" onClick={() => recordingInput.current?.click()} className="font-medium" style={{ color: "var(--accent-blue)" }}>
                    Use a different file
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{textFileNote ?? "Paste it below, or load a .txt, .vtt or .srt file."}</div>
          <input
            ref={textInput}
            type="file"
            accept=".txt,.vtt,.srt,.md,text/plain,text/vtt"
            className="hidden"
            onChange={(e) => {
              void pickTextFile(e.target.files);
              e.target.value = "";
            }}
          />
          <button type="button" onClick={() => textInput.current?.click()} className="btn btn-secondary btn-sm flex-none">
            Upload a text file
          </button>
        </div>
      )}

      {(source === "text" || stage.kind === "ready") && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">{source === "recording" ? "Transcript (you can fix names or anything misheard)" : "Call transcript"}</span>
          <textarea
            name="transcript"
            required
            rows={12}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            placeholder={"Agency: Hey, thanks for hopping on...\nClient: Of course, excited to talk about..."}
            className="input font-mono-tab text-[12.5px]"
          />
        </label>
      )}

      {notes && searchLeads ? (
        <LeadPicker search={searchLeads} />
      ) : (
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Template</span>
        <select name="templateId" required className="input" defaultValue="">
          <option value="" style={{ background: "var(--surface-1)" }}>
            Choose a template
          </option>
          {templates.map((t) => (
            <option key={t.id} value={t.id} style={{ background: "var(--surface-1)" }}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      )}

      {canSubmit ? (
        <SubmitButton className="btn btn-primary mt-2 w-full justify-center" pendingText={notes ? "Saving the call…" : "Reading the call, this can take up to a minute…"}>
          {notes ? "Write up the call" : "Extract deal terms"}
        </SubmitButton>
      ) : (
        <button type="button" disabled className="btn btn-primary mt-2 w-full justify-center" style={{ opacity: 0.5 }}>
          {busy ? "Waiting for the transcript…" : notes ? "Write up the call" : "Extract deal terms"}
        </button>
      )}
    </form>
  );
}

// Who a notes-only call was with: a new lead the call fills in (the
// default), or one already in Leads. Also on the iPhone app's recorder.
export function LeadPicker({ search }: { search: (q: string) => Promise<LeadOption[]> }) {
  const [lead, setLead] = useState<LeadOption | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LeadOption[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (lead || query.trim().length < 2) return;
    timer.current = setTimeout(() => {
      search(query.trim())
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, lead, search]);
  const shown = lead || query.trim().length < 2 ? [] : results;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">Lead</span>
      <input type="hidden" name="leadId" value={lead?.id ?? "new"} />
      {lead ? (
        <div className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2" style={{ border: "1px solid var(--hairline)" }}>
          <span className="min-w-0 truncate text-[13.5px]">
            <span className="font-medium">{lead.name}</span>
            {lead.company && <span style={{ color: "var(--ink-muted)" }}> · {lead.company}</span>}
          </span>
          <button type="button" onClick={() => setLead(null)} className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
            Change
          </button>
        </div>
      ) : (
        <>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search your leads" className="input" autoComplete="off" />
          {shown.length > 0 && (
            <div className="overflow-hidden rounded-[10px]" style={{ border: "1px solid var(--hairline)", background: "var(--surface-1)" }}>
              {shown.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    setLead(r);
                    setQuery("");
                  }}
                  className="row-hover block w-full px-3 py-2 text-left text-[13.5px]"
                >
                  <span className="font-medium">{r.name}</span>
                  {r.company && <span style={{ color: "var(--ink-muted)" }}> · {r.company}</span>}
                </button>
              ))}
            </div>
          )}
          <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
            No lead picked: SealMe finds the client from the call, or makes a new lead.
          </span>
        </>
      )}
    </div>
  );
}
