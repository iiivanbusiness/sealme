"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type { GetStartedStep } from "@/lib/get-started";
import { useGuideSeen } from "@/lib/guide-seen";

// The setup guide at the top of the Dashboard (see lib/get-started.ts).
// The first step that isn't done is the one with the button; the rest are
// a tap on the row. Each step opens the place it's done, where a short tip
// says what happens there (GuideTip). Hide puts it away; "Setup guide" in
// the menu brings it back. userId: whose "seen" steps these are, so another
// account in the same browser doesn't see them ticked.
export default function GetStarted({ steps, userId, hideAction }: { steps: GetStartedStep[]; userId: string; hideAction: () => Promise<void> }) {
  const seen = useGuideSeen(userId);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isDone = (s: GetStartedStep) => s.done || (Boolean(s.seenDone) && seen.includes(s.id));
  const required = steps.filter((s) => !s.optional);
  const optional = steps.filter((s) => s.optional);
  const done = required.filter(isDone).length;
  const next = required.find((s) => !isDone(s));
  if (hidden || !next) return null;

  function hide() {
    setError(null);
    startTransition(async () => {
      try {
        await hideAction();
        setHidden(true);
      } catch {
        setError("Couldn't hide it. Try again.");
      }
    });
  }

  return (
    <section id="setup" aria-labelledby="get-started-title" className="glass-card glass-card-solid mb-6 scroll-mt-4 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h2 id="get-started-title" className="text-[15px] font-medium">Set up SealMe</h2>
        <button type="button" disabled={pending} onClick={hide} className="text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
          {pending ? "Hiding…" : "Hide"}
        </button>
      </div>
      <div className="mb-1 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
        A few minutes. Each step opens the place it&apos;s done, with a short note on what happens there.
      </div>
      <div className="mb-4 mt-2.5 flex items-center gap-3">
        <div className="h-1.5 w-28 overflow-hidden rounded-full" style={{ background: "var(--hairline)" }} aria-hidden>
          <div className="h-1.5 rounded-full" style={{ width: `${Math.round((done / required.length) * 100)}%`, background: "var(--ink)" }} />
        </div>
        <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          {done} of {required.length} done
        </span>
      </div>

      <ol className="overflow-hidden rounded-[14px]" style={{ border: "1px solid var(--hairline)", background: "var(--surface-1)" }}>
        {[...required, ...optional].map((s, i) => {
          const finished = isDone(s);
          const isNext = s.id === next.id;
          return (
            <li key={s.id} style={i ? { borderTop: "1px solid var(--hairline-soft)" } : undefined}>
              <Link href={s.href} className="row-hover flex items-center gap-3 px-4 py-3 sm:px-5" style={{ color: "inherit" }} aria-label={finished ? `${s.title} (done)` : s.title}>
                {s.optional ? (
                  <span aria-hidden className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full text-[13px]" style={{ color: "var(--ink-muted)" }}>
                    +
                  </span>
                ) : (
                  <span
                    aria-hidden
                    className="flex h-[22px] w-[22px] flex-none items-center justify-center rounded-full"
                    style={finished ? { background: "var(--ink)", color: "var(--surface-1)" } : { boxShadow: `inset 0 0 0 1.5px ${isNext ? "var(--ink)" : "var(--hairline)"}` }}
                  >
                    {finished && (
                      <svg viewBox="0 0 16 16" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3.5 8.5 6.5 11.5 12.5 5" />
                      </svg>
                    )}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 text-[14px] font-medium" style={finished ? { color: "var(--ink-muted)" } : undefined}>
                    {s.title}
                    {s.optional && <span className="text-[11.5px] font-normal" style={{ color: "var(--ink-muted)" }}>Optional</span>}
                  </span>
                  {!finished && <span className="block text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{s.hint}</span>}
                  {/* On a phone the button sits under the text instead of squeezing it. */}
                  {isNext && (
                    <span className="mt-2 block sm:hidden">
                      <span className="btn btn-primary btn-sm whitespace-nowrap">{s.cta}</span>
                    </span>
                  )}
                </span>
                {isNext && (
                  <span className="hidden flex-none sm:block">
                    <span className="btn btn-primary btn-sm whitespace-nowrap">{s.cta}</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ol>
      {error && <div className="chip chip-warn mt-3 w-fit">{error}</div>}
    </section>
  );
}
