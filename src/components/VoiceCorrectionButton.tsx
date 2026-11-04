"use client";

import type { SyntheticEvent } from "react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import SentConfirmationCard from "./SentConfirmationCard";

type Proposal =
  | { intent: "update_field"; fieldKey: string; fieldLabel: string; currentValue: string | null; proposedValue: string; confirmationText: string }
  | { intent: "send_for_review"; recipientUserId: string; recipientName: string; confirmationText: string }
  | { intent: "unclear"; confirmationText: string };

type ApiResponse = { transcript?: string; proposal?: Proposal; audioBase64?: string | null; error?: string };

type Status = "idle" | "recording" | "processing" | "confirming" | "applying";

const WAVEFORM_BARS = Array.from({ length: 22 }, (_, i) => ({
  delay: (i % 7) * 0.11,
  duration: 0.8 + (i % 5) * 0.15,
}));

// Decorative, always-in-motion waveform — animates continuously regardless
// of whether anything is actually being recorded (the visual is meant to
// read as "alive" at rest, not to reflect real audio levels). Doubles as
// the push-to-talk hit target via onPress. Monochrome on purpose, to match
// the rest of the app rather than stand out as its own themed element.
function VoiceWaveformCard({ recording, onPress }: { recording: boolean; onPress: (e: SyntheticEvent) => void }) {
  return (
    <div
      onMouseDown={onPress}
      onTouchStart={onPress}
      className="relative flex cursor-pointer select-none flex-col items-center gap-4 rounded-[16px] px-6 py-6"
      style={{ background: "var(--surface-2)", border: "1px solid var(--hairline)" }}
    >
      <div
        className="relative flex h-11 w-11 items-center justify-center rounded-full"
        style={{ background: "var(--ink)" }}
      >
        <span
          className="absolute inset-0 rounded-full"
          style={{ border: "1.5px solid var(--ink-muted)", animation: "mic-pulse-ring 2s ease-out infinite" }}
        />
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ position: "relative" }}>
          <rect x="9" y="2" width="6" height="12" rx="3" fill="var(--surface-2)" />
          <path d="M5 11a7 7 0 0 0 14 0" stroke="var(--surface-2)" strokeWidth="2" strokeLinecap="round" fill="none" />
          <path d="M12 18v3" stroke="var(--surface-2)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </div>

      <div className="relative h-1 w-full rounded-full" style={{ background: "var(--hairline)" }}>
        <span
          className="absolute rounded-full"
          style={{ top: -3.5, width: 8, height: 8, background: "var(--ink)", animation: "scrub-drift 3.4s ease-in-out infinite" }}
        />
      </div>

      <div className="flex h-9 w-full items-end justify-center gap-[3px]">
        {WAVEFORM_BARS.map((bar, i) => (
          <span
            key={i}
            className="w-[3px] rounded-full"
            style={{
              height: 28,
              background: recording ? "var(--ink)" : "var(--ink-muted)",
              opacity: recording ? 1 : 0.55,
              animation: `waveform-bar ${bar.duration}s ease-in-out infinite`,
              animationDelay: `${bar.delay}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// Push-to-talk voice control: hold the button, say what should change (or
// who to send this to for review), release. Nothing is written or sent
// until the rep hears the proposal read back and explicitly taps "Yes" —
// see /api/deals/[id]/voice-correction (propose, never writes/sends) and
// applyAction/reviewAction below (apply, only called from that tap) — so a
// misheard word surfaces as an odd-sounding confirmation instead of a
// silently wrong contract or an email to the wrong person.
export default function VoiceCorrectionButton({
  dealId,
  applyAction,
  reviewAction,
}: {
  dealId: string;
  applyAction: (dealId: string, fieldKey: string, newValue: string) => Promise<{ error?: string }>;
  reviewAction: (dealId: string, recipientUserId: string) => Promise<{ error?: string }>;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [justSentTo, setJustSentTo] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setStatus("processing");
    }
  }

  // A "hold" gesture doesn't reliably keep the pointer over the button the
  // whole time — the button's own size/label changes the instant recording
  // starts, which can shift it under the cursor and fire mouseleave mid-hold
  // (ending the clip after a few ms, every time but the first). Listening on
  // window instead of the button catches the actual release wherever it
  // happens, and only while a recording is genuinely in progress.
  useEffect(() => {
    if (status !== "recording") return;
    window.addEventListener("mouseup", stopRecording);
    window.addEventListener("touchend", stopRecording);
    return () => {
      window.removeEventListener("mouseup", stopRecording);
      window.removeEventListener("touchend", stopRecording);
    };
  }, [status]);

  async function startRecording() {
    setError(null);
    setProposal(null);
    // Guard against a leftover recorder from a cycle that didn't clean up
    // properly — stopping it releases its mic stream before we ask for a
    // fresh one, instead of leaving an orphaned stream held open.
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach((t) => t.stop());
      mediaRecorderRef.current = null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void handleClipReady(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setStatus("recording");
    } catch {
      setError("Couldn't access the microphone. Check your browser/system permission");
    }
  }

  async function handleClipReady(blob: Blob) {
    try {
      const res = await fetch(`/api/deals/${dealId}/voice-correction`, {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      const data = (await res.json()) as ApiResponse;

      if (data.error) {
        setError(data.error);
        setStatus("idle");
        return;
      }
      if (data.audioBase64) {
        new Audio(`data:audio/mpeg;base64,${data.audioBase64}`).play().catch(() => {});
      }
      if (data.proposal) {
        setProposal(data.proposal);
        setStatus("confirming");
      } else {
        setStatus("idle");
      }
    } catch {
      setError("Couldn't reach the server. Try again");
      setStatus("idle");
    }
  }

  function handleConfirm() {
    if (!proposal) return;
    setStatus("applying");
    startTransition(async () => {
      try {
        if (proposal.intent === "update_field") {
          // A refusal (say, the contract went to a reviewer meanwhile) says why.
          const result = await applyAction(dealId, proposal.fieldKey, proposal.proposedValue);
          if (result.error) {
            setError(result.error);
            return;
          }
        } else if (proposal.intent === "send_for_review") {
          const result = await reviewAction(dealId, proposal.recipientUserId);
          if (result.error) {
            setError(result.error);
            return;
          }
          setJustSentTo(proposal.recipientName);
          setTimeout(() => setJustSentTo(null), 2200);
        }
        router.refresh();
      } catch {
        setError(
          proposal.intent === "send_for_review"
            ? "Couldn't send that email. Check your Resend setup and try again"
            : "Couldn't save that change. Try editing the field directly"
        );
      } finally {
        setProposal(null);
        setStatus("idle");
      }
    });
  }

  function handleCancel() {
    setProposal(null);
    setStatus("idle");
  }

  return (
    <div className="card flex flex-col gap-3 p-5">
      {error && (
        <div className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          {error}
        </div>
      )}

      {justSentTo ? (
        <SentConfirmationCard title={`Sent to ${justSentTo} for review`} />
      ) : status === "confirming" && proposal ? (
        <div className="flex flex-col gap-2.5">
          <p className="text-[13px] leading-relaxed">{proposal.confirmationText}</p>
          {(proposal.intent === "update_field" || proposal.intent === "send_for_review") && (
            <div className="flex gap-2">
              <button type="button" disabled={isPending} onClick={handleConfirm} className="btn btn-primary btn-sm flex-1 justify-center">
                {isPending ? "Working…" : proposal.intent === "send_for_review" ? "Yes, send" : "Yes, apply"}
              </button>
              <button type="button" disabled={isPending} onClick={handleCancel} className="btn btn-secondary btn-sm flex-1 justify-center">
                Cancel
              </button>
            </div>
          )}
          {proposal.intent === "unclear" && (
            <button type="button" onClick={handleCancel} className="btn btn-secondary btn-sm w-full justify-center">
              Dismiss
            </button>
          )}
        </div>
      ) : (
        <>
          <VoiceWaveformCard
            recording={status === "recording"}
            onPress={(e) => {
              e.preventDefault();
              if (status === "processing" || status === "applying") return;
              startRecording();
            }}
          />
          {(status === "recording" || status === "processing") && (
            <span className="text-center text-[12px]" style={{ color: "var(--ink-muted)" }}>
              {status === "recording" ? "Listening. Release to send" : "Thinking…"}
            </span>
          )}
        </>
      )}
    </div>
  );
}
