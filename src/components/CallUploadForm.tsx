"use client";

import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { CallLeadOption } from "@/app/(app)/leads/search-actions";
import type { StartCallState } from "@/app/(app)/deals/new/actions";
import { transcriptFromCaptionFile } from "@/lib/recording-transcript";
import { formatCallDuration as formatDuration, formatFileSize as formatSize, isRecordingFile, transcribeRecordingFile } from "@/lib/recording-upload";

type Stage = { kind: "idle" } | { kind: "uploading"; progress: number } | { kind: "transcribing" } | { kind: "ready"; seconds: number; turns: number } | { kind: "error"; message: string };

export type TemplateOption = { id: string; name: string };

// Start a call without the desktop app: the recording (transcribed by
// Deepgram, then shown for a check) or the transcript, pasted or loaded from
// a text file. Who it was with and what SealMe makes are asked first: notes
// always, a proposal or a contract when ticked. `phone` (the iPhone app)
// words the file picker for a phone and leaves proposals and contracts to
// the computer. `initialLead`, `who` and `name` fill in "Who's on the call?"
// (a meeting from the calendar, see WhoOnCall). A call that can't be saved
// says why above the button, with everything still filled in.
export default function CallUploadForm({
  templates,
  action,
  searchLeads,
  phone = false,
  who,
  name,
  initialLead,
}: {
  templates: { proposal: TemplateOption[]; contract: TemplateOption[] };
  action: (state: StartCallState, formData: FormData) => Promise<StartCallState>;
  searchLeads: (q: string) => Promise<CallLeadOption[]>;
  phone?: boolean;
  who?: string;
  name?: string;
  initialLead?: CallLeadOption | null;
}) {
  const [make, setMake] = useState<{ proposal: boolean; contract: boolean }>({ proposal: false, contract: false });
  const [source, setSource] = useState<"recording" | "text">("recording");
  const [transcript, setTranscript] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [textFileNote, setTextFileNote] = useState<string | null>(null);
  const recordingInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const [saved, saveAction, saving] = useActionState(action, null);
  // Set on submit, before "Saving the call…" shows, so a double click
  // doesn't save the call twice.
  const submitted = useRef(false);
  useEffect(() => {
    if (!saving) submitted.current = false;
  }, [saving]);

  // onSubmit, not <form action>: React resets a form after its action, and
  // that unticks the Proposal and Contract boxes the form still shows
  // ticked. A call that couldn't be saved is sent again as it was. Enter in
  // "Who's on the call?" submits too, even with no transcript yet.
  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit || submitted.current) return;
    submitted.current = true;
    const data = new FormData(e.currentTarget);
    startTransition(() => saveAction(data));
  }

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
    setTextFileNote(`Loaded ${f.name}. Check it below.`);
    // The recording's transcript is gone, so the call isn't that recording
    // anymore (see heard).
    setFile(null);
    setStage({ kind: "idle" });
  }

  const busy = stage.kind === "uploading" || stage.kind === "transcribing";
  // The transcript came from the recording, even when it's checked or fixed
  // on the Transcript tab: the call is saved as that recording, with its
  // length (and the transcription it took).
  const heard = stage.kind === "ready";
  const seconds = heard ? stage.seconds : 0;
  // Only a transcript on screen is sent: the box isn't there on the
  // Recording tab until a recording is transcribed.
  const showsTranscript = source === "text" || heard;
  const canSubmit = showsTranscript && transcript.trim().length > 0 && !busy;
  const extras = [make.proposal && "proposal", make.contract && "contract"].filter(Boolean).join(" and ");
  const label = extras ? `Write up the call and draft the ${extras}` : "Write up the call";
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
    <form onSubmit={submit} className="card flex max-w-[560px] flex-col gap-5 p-6">
      <input type="hidden" name="source" value={heard ? "recording" : "text"} />
      <input type="hidden" name="seconds" value={seconds} />
      <WhoOnCall search={searchLeads} initial={who} name={name} initialLead={initialLead} />
      {!phone && <WhatToMake templates={templates} make={make} onChange={setMake} />}
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

      {showsTranscript && (
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

      {saved?.error && !saving && (
        <div role="alert" className="chip chip-warn w-full justify-start whitespace-normal px-4 py-2.5 text-[12.5px]">
          {saved.error}
        </div>
      )}

      {canSubmit ? (
        <button type="submit" disabled={saving} aria-busy={saving} className="btn btn-primary w-full justify-center" style={saving ? { opacity: 0.7, cursor: "wait" } : undefined}>
          {saving ? "Saving the call…" : label}
        </button>
      ) : (
        <button type="button" disabled className="btn btn-primary w-full justify-center" style={{ opacity: 0.5 }}>
          {busy ? "Waiting for the transcript…" : label}
        </button>
      )}
    </form>
  );
}

const KIND_LABEL = { proposal: "Proposal", contract: "Contract" } as const;

// "What should SealMe make?": notes always (a fixed row, not a checkbox that
// can't be unticked), and a proposal or a contract only when ticked. The
// template is SealMe's pick from what was said, unless the rep changes it;
// with no template of a kind yet, that box says to add one.
export function WhatToMake({
  templates,
  make,
  onChange,
}: {
  templates: { proposal: TemplateOption[]; contract: TemplateOption[] };
  make: { proposal: boolean; contract: boolean };
  onChange: (next: { proposal: boolean; contract: boolean }) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-[13px] font-medium">What should SealMe make?</legend>
      <div className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2.5" style={{ border: "1px solid var(--hairline)" }}>
        <span className="text-[13.5px] font-medium">Notes</span>
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>always on</span>
      </div>
      {(["proposal", "contract"] as const).map((kind) => (
        <MakeRow
          key={kind}
          kind={kind}
          templates={templates[kind]}
          checked={make[kind]}
          // A call keeps one picked template: with a contract too, it's the
          // contract's, and SealMe picks the proposal's from the call.
          pickable={!(kind === "proposal" && make.contract)}
          onChange={(on) => onChange({ ...make, [kind]: on })}
        />
      ))}
    </fieldset>
  );
}

function MakeRow({ kind, templates, checked, pickable, onChange }: { kind: "proposal" | "contract"; templates: TemplateOption[]; checked: boolean; pickable: boolean; onChange: (on: boolean) => void }) {
  const [changing, setChanging] = useState(false);
  const [templateId, setTemplateId] = useState("");
  const none = templates.length === 0;
  const using = templates.length === 1 ? templates[0].name : ((pickable && templates.find((t) => t.id === templateId)?.name) || "picked from the call");
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] px-3 py-2.5" style={{ border: "1px solid var(--hairline)", opacity: none ? 0.75 : 1 }}>
      <label className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5 text-[13.5px] font-medium">
          <input type="checkbox" name={kind === "proposal" ? "wantsProposal" : "wantsContract"} value="1" checked={checked} disabled={none} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4" />
          {KIND_LABEL[kind]}
        </span>
        {none && (
          <Link href={`/templates?kind=${kind}`} className="text-[12px] font-medium" style={{ color: "var(--accent-blue)" }}>
            Add a {kind} template first
          </Link>
        )}
      </label>
      {checked && !none && (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-[26px] text-[12px]" style={{ color: "var(--ink-muted)" }}>
          {changing && pickable ? (
            <select name={`${kind}TemplateId`} value={templateId} onChange={(e) => setTemplateId(e.target.value)} className="input py-1 text-[12.5px]" aria-label={`${KIND_LABEL[kind]} template`}>
              <option value="">Picked from the call</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <>
              <span className="min-w-0 truncate">Using: {using}</span>
              {templates.length > 1 && pickable && (
                <button type="button" onClick={() => setChanging(true)} className="font-medium" style={{ color: "var(--accent-blue)" }}>
                  · change
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// "Who's on the call?": one field. Typing offers the leads already on file
// (by name, company, email or phone); picking one puts the call under them.
// Anything typed and not picked starts a new lead (an email or phone already
// on a lead goes to that lead), and nothing at all lets the call name the
// lead. Also on the iPhone app's recorder.
// From a meeting: initialLead starts picked (the lead SealMe matched), or
// `initial` is typed in (the attendee's email or name). `name` is the
// meeting's name for that email, so a lead made from it is named; it goes
// only while the email is left as it came.
export function WhoOnCall({
  search,
  initial = "",
  name = "",
  initialLead = null,
}: {
  search: (q: string) => Promise<CallLeadOption[]>;
  initial?: string;
  name?: string;
  initialLead?: CallLeadOption | null;
}) {
  const [lead, setLead] = useState<CallLeadOption | null>(initialLead);
  const [query, setQuery] = useState(initial);
  const [results, setResults] = useState<CallLeadOption[]>([]);
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
  const typed = query.trim();
  const detail = (l: CallLeadOption) => [l.company, l.calls ? `${l.calls} ${l.calls === 1 ? "call" : "calls"}` : null].filter(Boolean).join(" · ");

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor="who-on-call" className="text-[13px] font-medium">
        Who&apos;s on the call?
      </label>
      <input type="hidden" name="leadId" value={lead?.id ?? "new"} />
      <input type="hidden" name="who" value={lead ? "" : typed} />
      <input type="hidden" name="whoName" value={!lead && name && typed === initial.trim() ? name : ""} />
      {lead ? (
        <div className="flex items-center justify-between gap-3 rounded-[10px] px-3 py-2" style={{ border: "1px solid var(--hairline)" }}>
          <span className="min-w-0 truncate text-[13.5px]">
            <span className="font-medium">{lead.name}</span>
            {detail(lead) && <span style={{ color: "var(--ink-muted)" }}> · {detail(lead)}</span>}
            {lead.isClient && <span className="chip chip-success ml-2 align-middle text-[11px]">Client</span>}
          </span>
          <button type="button" onClick={() => setLead(null)} className="flex-none text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
            Change
          </button>
        </div>
      ) : (
        <>
          <input id="who-on-call" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, email or company" className="input" autoComplete="off" />
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
                  className="row-hover flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13.5px]"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-medium">{r.name}</span>
                    {detail(r) && <span style={{ color: "var(--ink-muted)" }}> · {detail(r)}</span>}
                  </span>
                  {r.isClient && <span className="chip chip-success flex-none text-[11px]">Client</span>}
                </button>
              ))}
            </div>
          )}
          <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
            {typed ? "Not on the list? The call starts a new lead." : "Leave it empty and SealMe takes the name from the call."}
          </span>
        </>
      )}
    </div>
  );
}
