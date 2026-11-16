"use client";

import { useEffect, useRef, useState } from "react";
import { faqCategoriesFor } from "@/lib/faq-content";

type FaqMessage = { role: "assistant" | "user"; text: string };
type AiMessage = { role: "assistant" | "user"; text: string };
type Mode = "faq" | "ai";
type VoiceStatus = "idle" | "recording" | "transcribing";

const FAQ_GREETING = "Hi! What do you need help with?";
const AI_GREETING = "Ask me anything about SealMe. I can't see your account or deals, just how the product works.";

// Two independent chat modes sharing one floating widget: a canned FAQ
// (zero cost, no AI call) and a freeform AI chat backed by /api/support-chat,
// plus a mic button that transcribes a short clip via /api/support-chat/transcribe
// (Deepgram) instead of typing. Rendered globally from AppShell so it's
// available on every authenticated page. Neither mode has access to the
// caller's account data by design.
//
// overscroll-contain on the internally-scrollable regions isn't enough on
// its own — it only stops chaining once a region actually has overflow and
// the browser correctly honors the property. Hovering over any non-
// scrolling part of the panel (header, input bar, a message list too short
// to scroll) still lets the wheel event fall straight through to the
// dashboard behind it. panelWheelGuard below intercepts every wheel event
// over the whole panel via a native (non-passive) listener — React's own
// onWheel is attached passively and can't call preventDefault — and only
// lets it through to native scrolling when the pointer is genuinely over a
// scrollable region that isn't already at the boundary in that direction.
export default function FaqChatWidget({ prospecting = false }: { prospecting?: boolean }) {
  // Leads and phone questions only where Leads is turned on.
  const categories = faqCategoriesFor(prospecting);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("faq");
  const panelRef = useRef<HTMLDivElement>(null);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [faqMessages, setFaqMessages] = useState<FaqMessage[]>([{ role: "assistant", text: FAQ_GREETING }]);

  const [aiMessages, setAiMessages] = useState<AiMessage[]>([{ role: "assistant", text: AI_GREETING }]);
  const [aiInput, setAiInput] = useState("");
  const [aiSending, setAiSending] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>("idle");
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const category = categoryId ? categories.find((c) => c.id === categoryId) ?? null : null;

  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;

    function handleWheel(e: WheelEvent) {
      const target = e.target as HTMLElement;
      const scrollable = target.closest(".overscroll-contain") as HTMLElement | null;
      if (scrollable && scrollable.scrollHeight > scrollable.clientHeight) {
        const atTop = scrollable.scrollTop <= 0;
        const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1;
        const leavingTop = e.deltaY < 0 && atTop;
        const leavingBottom = e.deltaY > 0 && atBottom;
        if (!leavingTop && !leavingBottom) return; // let the region scroll itself
      }
      e.preventDefault();
    }

    panel.addEventListener("wheel", handleWheel, { passive: false });
    return () => panel.removeEventListener("wheel", handleWheel);
  }, [open]);

  function pickQuestion(question: string, answer: string) {
    setFaqMessages((prev) => [...prev, { role: "user", text: question }, { role: "assistant", text: answer }]);
  }

  async function sendAiMessage(overrideText?: string) {
    const text = (overrideText ?? aiInput).trim();
    if (!text || aiSending) return;

    const nextMessages = [...aiMessages, { role: "user" as const, text }];
    setAiMessages(nextMessages);
    setAiInput("");
    setAiSending(true);
    setAiError(null);

    try {
      const res = await fetch("/api/support-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages.map((m) => ({ role: m.role, content: m.text })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Something went wrong");
      setAiMessages((prev) => [...prev, { role: "assistant", text: data.reply }]);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "Something went wrong answering that");
    } finally {
      setAiSending(false);
    }
  }

  async function startVoiceInput() {
    setAiError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void handleVoiceClipReady(new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" }));
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setVoiceStatus("recording");
    } catch {
      setAiError("Couldn't access the microphone, check your browser or system permission");
    }
  }

  function stopVoiceInput() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setVoiceStatus("transcribing");
    }
  }

  async function handleVoiceClipReady(blob: Blob) {
    try {
      const res = await fetch("/api/support-chat/transcribe", {
        method: "POST",
        headers: { "Content-Type": blob.type || "audio/webm" },
        body: blob,
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setAiError(data?.error ?? "Couldn't transcribe that clip");
        return;
      }
      if (data.transcript) await sendAiMessage(data.transcript);
    } catch {
      setAiError("Couldn't reach the server, try again");
    } finally {
      setVoiceStatus("idle");
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? "Close help" : "Open help"}
        className="faq-launcher fixed bottom-24 right-5 z-50 flex h-12 w-12 flex-none items-center justify-center rounded-full md:bottom-6 md:right-6"
        style={{ background: "var(--primary)", color: "var(--on-primary)", boxShadow: "var(--shadow-pop)" }}
      >
        {open ? (
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" width={18} height={18}>
            <path d="M5 5l10 10M15 5L5 15" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" width={20} height={20}>
            <path d="M3 5.5c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2v6.2c0 1.1-.9 2-2 2H9.4L5.5 17v-3.3H5c-1.1 0-2-.9-2-2V5.5z" />
          </svg>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="faq-panel card fixed bottom-40 right-5 z-50 flex max-h-[min(560px,70vh)] w-[min(380px,calc(100vw-2.5rem))] flex-col overflow-hidden md:bottom-24 md:right-6">
          <div className="flex flex-none items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--hairline)" }}>
            <div className="flex items-center gap-1 rounded-[10px] p-0.5" style={{ background: "var(--surface-2)" }}>
              <button
                type="button"
                onClick={() => setMode("faq")}
                className="rounded-[8px] px-2.5 py-1 text-[12px] font-medium"
                style={mode === "faq" ? { background: "var(--surface-1)", color: "var(--ink)" } : { color: "var(--ink-muted)" }}
              >
                FAQ
              </button>
              <button
                type="button"
                onClick={() => setMode("ai")}
                className="rounded-[8px] px-2.5 py-1 text-[12px] font-medium"
                style={mode === "ai" ? { background: "var(--surface-1)", color: "var(--ink)" } : { color: "var(--ink-muted)" }}
              >
                Ask AI
              </button>
            </div>
            {mode === "faq" && category && (
              <button
                type="button"
                onClick={() => setCategoryId(null)}
                className="text-[12px] font-medium"
                style={{ color: "var(--ink-muted)" }}
              >
                ← Topics
              </button>
            )}
          </div>

          {mode === "faq" ? (
            <>
              <div className="overscroll-contain flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
                {faqMessages.map((m, i) => (
                  <ChatBubble key={i} role={m.role} text={m.text} />
                ))}
              </div>

              <div className="flex-none border-t px-3.5 py-3" style={{ borderColor: "var(--hairline)" }}>
                <div className="overscroll-contain flex max-h-[168px] flex-col gap-1 overflow-y-auto">
                  {!category
                    ? categories.map((c) => (
                        <OptionButton key={c.id} onClick={() => setCategoryId(c.id)}>
                          {c.label}
                        </OptionButton>
                      ))
                    : category.questions.map((q) => (
                        <OptionButton key={q.question} onClick={() => pickQuestion(q.question, q.answer)}>
                          {q.question}
                        </OptionButton>
                      ))}
                </div>
              </div>
            </>
          ) : (
            <>
              {aiMessages.length === 1 ? (
                <div className="overscroll-contain flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-6 text-center">
                  <span className="faq-orb faq-orb-hero h-20 w-20 flex-none rounded-full" />
                  <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>{aiMessages[0].text}</p>
                  {aiError && (
                    <div className="max-w-full rounded-[14px] px-3 py-2 text-[13px]" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                      {aiError}
                    </div>
                  )}
                </div>
              ) : (
                <div className="overscroll-contain flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3.5">
                  {aiMessages.map((m, i) => (
                    <ChatBubble key={i} role={m.role} text={m.text} />
                  ))}
                  {aiSending && <ChatBubble role="assistant" text="…" />}
                  {voiceStatus !== "idle" && (
                    <div className="self-start text-[12px]" style={{ color: "var(--ink-muted)" }}>
                      {voiceStatus === "recording" ? "Listening… tap the mic again to send" : "Transcribing…"}
                    </div>
                  )}
                  {aiError && (
                    <div className="max-w-[85%] rounded-[14px] px-3 py-2 text-[13px]" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                      {aiError}
                    </div>
                  )}
                </div>
              )}

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void sendAiMessage();
                }}
                className="flex-none px-3.5 py-3"
              >
                <div
                  className="flex items-center gap-1.5 rounded-[24px] px-2 py-1.5"
                  style={{ background: "var(--surface-2)" }}
                >
                  <button
                    type="button"
                    onClick={() => (voiceStatus === "recording" ? stopVoiceInput() : startVoiceInput())}
                    disabled={aiSending || voiceStatus === "transcribing"}
                    aria-label={voiceStatus === "recording" ? "Stop recording" : "Record a voice message"}
                    className="flex h-8 w-8 flex-none items-center justify-center rounded-full"
                    style={
                      voiceStatus === "recording"
                        ? { background: "#e0455c", color: "#fff" }
                        : { background: "var(--surface-1)", color: "var(--ink-muted)" }
                    }
                  >
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" width={15} height={15}>
                      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" />
                      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0" />
                      <path d="M10 15v2.5" />
                    </svg>
                  </button>
                  <input
                    type="text"
                    value={aiInput}
                    onChange={(e) => setAiInput(e.target.value)}
                    placeholder="Type a question…"
                    disabled={aiSending || voiceStatus !== "idle"}
                    maxLength={2000}
                    className="min-w-0 flex-1 bg-transparent px-1 text-[13px] outline-none"
                    style={{ color: "var(--ink)" }}
                  />
                  <button
                    type="submit"
                    disabled={aiSending || !aiInput.trim()}
                    aria-label="Send"
                    className="flex h-8 w-8 flex-none items-center justify-center rounded-full disabled:opacity-40"
                    style={{ background: "var(--ink)", color: "var(--canvas)" }}
                  >
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" width={14} height={14}>
                      <path d="M10 16V4M4.5 9.5 10 4l5.5 5.5" />
                    </svg>
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      )}
    </>
  );
}

function ChatBubble({ role, text }: { role: "assistant" | "user"; text: string }) {
  if (role === "user") {
    return (
      <div
        className="max-w-[85%] self-end rounded-[14px] px-3 py-2 text-[13px] leading-relaxed"
        style={{ background: "var(--primary)", color: "var(--on-primary)" }}
      >
        {text}
      </div>
    );
  }
  return (
    <div className="flex max-w-[90%] items-start gap-2 self-start">
      <span className="faq-orb mt-0.5 h-6 w-6 flex-none rounded-full" />
      <div className="rounded-[14px] px-3 py-2 text-[13px] leading-relaxed" style={{ background: "var(--surface-2)", color: "var(--ink)" }}>
        {text}
      </div>
    </div>
  );
}

function OptionButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[10px] px-3 py-2 text-left text-[12.5px] font-medium"
      style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink)" }}
    >
      {children}
    </button>
  );
}
