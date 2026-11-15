"use client";

import { CopyButton } from "@/components/LeadCalls";
import { noteLines } from "@/lib/note-lines";

// "Where things stand" across all of a lead's calls, above the calls
// themselves. Closed until opened: it's there before a second or fifth
// conversation, without pushing the calls down the rest of the time.
// since: the first call's day, already in the viewer's timezone.
export default function LeadOverview({ overview, calls, since }: { overview: string; calls: number; since: string }) {
  const lines = noteLines(overview);
  const first = since;
  return (
    <details className="card group min-w-0 overflow-hidden">
      <summary className="flex cursor-pointer select-none flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-5 py-4 sm:px-6">
        <span className="flex items-center gap-2 text-[14px] font-medium">
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden className="flex-none transition-transform group-open:rotate-90" style={{ color: "var(--ink-muted)" }}>
            <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Where things stand
        </span>
        <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          {calls} calls since {first}
        </span>
      </summary>
      <div className="flex flex-col gap-2 px-5 pb-5 sm:px-6">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[13.5px] leading-snug">
          {lines.map((l, i) => (
            <li key={i} className="break-words">{l}</li>
          ))}
        </ul>
        <div>
          <CopyButton text={() => lines.map((l) => `- ${l}`).join("\n")} />
        </div>
      </div>
    </details>
  );
}
