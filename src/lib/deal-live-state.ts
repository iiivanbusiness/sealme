// What the contract screen works out from each poll while a call is on:
// whether it's still live, and which term the call just filled in. Free of
// server-only imports, the screen runs it in the browser.
import type { TermField } from "@/lib/contract";
import { findQuote, type TranscriptLine } from "@/lib/transcript-lines";

// The call that made the deal is still recording, or its last chunk is in
// and SealMe is still reading the terms and writing the notes.
const LIVE_CALL_STATUSES = new Set(["recording", "processing"]);
// After a recording made with "Record another call" ends, its action items
// and highlights land in the background, so the page keeps checking a while.
const AFTER_CALL_MS = 2 * 60 * 1000;
// A recording made on the deal can only add to its call (or end it) while
// its upload token lasts: 4 hours from the start (mintLocalCaptureToken).
const RECORDING_WINDOW_MS = 4 * 60 * 60 * 1000;

type CallTiming = { startedAt: Date | string; endedAt: Date | string | null };
type TranscriptSource = { transcript: string; startedAt: Date | string; endedAt?: Date | string | null };

const timeOf = (date: Date | string) => new Date(date).getTime();

// A recording made on the deal ("Record another call") that's still going.
// One that never got its end (the desktop app quit mid-call, and nothing
// else sets endedAt on a Call) stops counting once its token ran out, since
// nothing can add to it or end it after that.
export function callInProgress(call: CallTiming, now: Date = new Date()): boolean {
  if (call.endedAt) return false;
  const started = timeOf(call.startedAt);
  return !Number.isFinite(started) || now.getTime() - started < RECORDING_WINDOW_MS;
}

// Still going, or ended a moment ago: what's said about a call (a mic that
// heard nothing) belongs at the top of the screen only while it is.
export function callIsRecent(call: CallTiming, now: Date = new Date()): boolean {
  if (!call.endedAt) return callInProgress(call, now);
  return now.getTime() - timeOf(call.endedAt) < AFTER_CALL_MS;
}

// Live while the call it came from (Deal.phoneCall, "Start a call") records
// or is being written up, while SealMe reads the call (status processing),
// or while a recording made on the deal itself is on or just ended. The
// call's status matters most: a deal from Start a call leaves "processing"
// after its first reading and has no Call rows, so the deal alone would stop
// the page mid-call.
export function dealIsLive(input: { status: string; calls: CallTiming[]; phoneCallStatus: string | null }, now: Date = new Date()): boolean {
  if (input.phoneCallStatus && LIVE_CALL_STATUSES.has(input.phoneCallStatus)) return true;
  if (input.status === "processing") return true;
  const last = input.calls[input.calls.length - 1];
  if (!last) return false;
  return callIsRecent(last, now);
}

// The transcript the screen shows. While a recording made on the deal is
// on ("Record another call"), that recording's own words: the live
// transcript is the call that's on, even on a deal made with Start a call,
// which has that first call's words too. Otherwise every call on the deal,
// in the order they happened.
export function dealTranscript(phoneCall: TranscriptSource | null, calls: TranscriptSource[], now: Date = new Date()): string {
  const last = calls[calls.length - 1];
  if (last && callInProgress({ startedAt: last.startedAt, endedAt: last.endedAt ?? null }, now)) return last.transcript;
  return [...(phoneCall ? [phoneCall] : []), ...calls]
    .filter((c) => c.transcript.trim())
    .sort((a, b) => timeOf(a.startedAt) - timeOf(b.startedAt))
    .map((c) => c.transcript.trim())
    .join("\n");
}

function filled(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

// The term the call just filled in or changed between two polls: one the
// extraction wrote (status "extracted"), never one the rep typed. Readings
// come every few minutes and often fill several terms at once; the one whose
// quote comes latest in the transcript is the one just said. Null when
// nothing new was heard, or when there's nothing to compare with yet (the
// first load).
export function justHeard(prev: TermField[], next: TermField[], lines: TranscriptLine[]): string | null {
  if (prev.length === 0) return null;
  const before = new Map(prev.map((f) => [f.fieldKey, filled(f.value)]));
  const changed = next.filter((f) => {
    const value = filled(f.value);
    return f.status === "extracted" && value !== null && value !== before.get(f.fieldKey);
  });
  if (changed.length <= 1) return changed[0]?.fieldKey ?? null;

  let best = changed[0];
  let bestAt: { line: number; start: number } | null = findQuote(lines, best.sourceQuote);
  for (const field of changed.slice(1)) {
    const at = findQuote(lines, field.sourceQuote);
    if (!at) continue;
    if (!bestAt || at.line > bestAt.line || (at.line === bestAt.line && at.start > bestAt.start)) {
      best = field;
      bestAt = at;
    }
  }
  return best.fieldKey;
}

// A short key for the text a template gives the document: its id and a
// hash of its name and clauses. The screen sends the key of the template it
// has with every poll, and the poll leaves the clauses out while it still
// matches, so a call doesn't carry tens of KB of the same clauses every few
// seconds. A template picked again (a new id) or edited meanwhile (a new
// hash) comes back whole.
export function templateVersion(template: { id: string; name: string; clauses: string }): string {
  // FNV-1a over the UTF-16 code units: cheap, and a change anywhere moves it.
  let hash = 0x811c9dc5;
  const text = `${template.name}\u0000${template.clauses}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${template.id}:${(hash >>> 0).toString(36)}`;
}
