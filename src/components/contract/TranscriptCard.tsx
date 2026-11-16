"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TranscriptLine } from "./types";
import { speakerLabel, splitHighlights, type TranscriptHighlight } from "./paper-utils";
import s from "./contract.module.css";

// What was said on the call, the client under their first name and the rep
// as "You". Phrases a term was taken from are marked green, the one just
// heard yellow. While the call is live it stays on the newest line, unless
// the rep scrolled up to read something.

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type { TranscriptHighlight };

export type TranscriptCardProps = {
  lines: TranscriptLine[];
  live: boolean;
  title?: string;
  clientFirstName: string | null;
  highlights: TranscriptHighlight[];
};

export default function TranscriptCard({ lines, live, title, clientFirstName, highlights }: TranscriptCardProps) {
  const headingId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  // Lines already there when the card first showed don't animate in.
  const [firstCount] = useState(lines.length);

  const byLine = useMemo(() => {
    const map = new Map<number, TranscriptHighlight[]>();
    for (const h of highlights) map.set(h.line, [...(map.get(h.line) ?? []), h]);
    return map;
  }, [highlights]);

  useIsoLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && live && pinned.current) body.scrollTop = body.scrollHeight;
  }, [lines, live]);

  const hasLines = lines.length > 0;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (live && pinned.current) body.scrollTop = body.scrollHeight;
    });
    ro.observe(body);
    return () => ro.disconnect();
  }, [live, hasLines]);

  if (!live && lines.length === 0) return null;

  return (
    <section className={s.card} aria-labelledby={headingId}>
      <div className={s.cardH}>
        <h2 id={headingId} className={s.cardTitle}>
          {title ?? (live ? "Live transcript" : "Call transcript")}
        </h2>
        {live && (
          <span className={s.listen}>
            <span className={s.eq} aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            Listening
          </span>
        )}
      </div>
      {lines.length === 0 ? (
        <p className={s.cardEmpty}>Words show up here about a minute after they&apos;re said.</p>
      ) : (
        <div
          ref={bodyRef}
          className={s.trBody}
          tabIndex={0}
          aria-label="Transcript"
          onScroll={(e) => {
            const b = e.currentTarget;
            pinned.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
          }}
        >
          {lines.map((line, i) => (
            <p key={i} className={s.ln} data-who={line.speaker} data-new={i >= firstCount ? "" : undefined}>
              <b>{speakerLabel(line, clientFirstName)}</b>
              {splitHighlights(line.text, byLine.get(i) ?? []).map((seg, j) =>
                seg.tone ? (
                  <span key={j} className={s.hl} data-tone={seg.tone}>
                    {seg.text}
                  </span>
                ) : (
                  <span key={j}>{seg.text}</span>
                ),
              )}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
