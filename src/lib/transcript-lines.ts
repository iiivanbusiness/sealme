// A call transcript as the contract screen shows it: who said what, a line
// per turn, and where a term's quote sits in it. Transcripts are stored as
// one string, a line per turn ("Client: ...", "You: ..."; see
// transcribeWav in deepgram.ts), so this runs in the browser on whatever the
// page has. Free of imports for that reason.

export type TranscriptLine = { speaker: "client" | "you" | "other"; name: string | null; text: string };

// "Client: ..." and "You: ..." from the desktop app; "Speaker 2: ..." or
// "Priya Shah: ..." from a recording's own captions. A speaker is a few
// capitalised words, so a sentence that happens to hold a colon ("So the
// price: four thousand") stays words, not a speaker.
const SPEAKER_LINE = /^([^:\n]{1,40}?):(?:\s+|$)(.*)$/;
const SPEAKER_NAME = /^[\p{Lu}\p{N}][\p{L}\p{N}.'’-]*(?: [\p{Lu}\p{N}][\p{L}\p{N}.'’-]*){0,3}$/u;

function speakerOf(label: string): { speaker: TranscriptLine["speaker"]; name: string | null } | null {
  const name = label.trim();
  if (/^client$/i.test(name)) return { speaker: "client", name: null };
  if (/^you$/i.test(name)) return { speaker: "you", name: null };
  return SPEAKER_NAME.test(name) ? { speaker: "other", name } : null;
}

// Turns in order. A turn cut in two where one minute's chunk ended and the
// next began reads as one; a line with no speaker carries on the one before.
export function parseTranscript(text: string | null | undefined): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = SPEAKER_LINE.exec(line);
    const who = match ? speakerOf(match[1]) : null;
    const words = (who && match ? match[2] : line).trim();
    if (!words) continue;
    const last = lines[lines.length - 1];
    if (!who) {
      if (last) last.text = `${last.text} ${words}`;
      else lines.push({ speaker: "other", name: null, text: words });
      continue;
    }
    if (last && last.speaker === who.speaker && last.name === who.name) {
      last.text = `${last.text} ${words}`;
      continue;
    }
    lines.push({ speaker: who.speaker, name: who.name, text: words });
  }
  return lines;
}

// Text reduced to lower-case words split by single spaces, with where each
// kept character came from, so a match maps back onto the original line.
// Quotes (straight or curly) and other punctuation drop out, dashes and
// slashes split words: "$4,000/month" and "4000 month" read the same.
type Normalized = { text: string; starts: number[]; ends: number[] };

function normalize(source: string): Normalized {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < source.length; ) {
    const ch = String.fromCodePoint(source.codePointAt(i)!);
    const end = i + ch.length;
    if (/[\s\-‐-―−/\\]/.test(ch)) {
      if (text && !text.endsWith(" ")) {
        text += " ";
        starts.push(i);
        ends.push(end);
      }
    } else if (/[\p{L}\p{N}]/u.test(ch)) {
      for (const lower of ch.toLowerCase()) {
        text += lower;
        starts.push(i);
        ends.push(end);
      }
    }
    i = end;
  }
  if (text.endsWith(" ")) {
    text = text.slice(0, -1);
    starts.pop();
    ends.pop();
  }
  return { text, starts, ends };
}

const MIN_QUOTE = 4;

// The latest place q stands as whole words in text, or -1.
function lastWholeMatch(text: string, q: string): number {
  let from = text.length;
  while (from >= 0) {
    const at = text.lastIndexOf(q, from);
    if (at < 0) return -1;
    const before = at === 0 || text[at - 1] === " ";
    const after = at + q.length === text.length || text[at + q.length] === " ";
    if (before && after) return at;
    from = at - 1;
  }
  return -1;
}

// A quote the model started with its speaker ("Client: we can start in
// March") reads without it.
function withoutSpeaker(text: string): string {
  const match = SPEAKER_LINE.exec(text.trim());
  return match && speakerOf(match[1]) ? match[2] : text;
}

// The pieces of a quote the model joined from two turns or shortened with
// "...", for when it isn't found whole. A piece needs a few words of its
// own, so "okay" alone never matches.
function quotePieces(quote: string, whole: string): string[] {
  const pieces = quote
    .split(/\r?\n|\.{3}|\u2026|\s(?=(?:Client|You):\s)/i)
    .map((piece) => normalize(withoutSpeaker(piece)).text)
    .filter((piece) => piece.length >= 8 && piece.includes(" ") && piece !== whole);
  return [...new Set(pieces)];
}

type QuoteAt = { line: number; start: number; end: number };

// The latest line, searching back from the end, where q stands as whole words.
function latestMatch(normalized: Normalized[], q: string): QuoteAt | null {
  for (let line = normalized.length - 1; line >= 0; line--) {
    const n = normalized[line];
    const at = lastWholeMatch(n.text, q);
    if (at >= 0) return { line, start: n.starts[at], end: n.ends[at + q.length - 1] };
  }
  return null;
}

// Where a term's quote (DealField.sourceQuote) sits in the transcript: the
// latest line that has it, and the characters it covers in that line's text.
// The model doesn't always copy word for word, so case, spacing, punctuation
// and quote marks don't count. A quote that spans two turns, or skips words,
// is found by its pieces: the one said last, where the term was settled.
// Null when it isn't there or is too short to tell (under 4 characters).
export function findQuote(lines: TranscriptLine[], quote: string | null | undefined): QuoteAt | null {
  if (!quote) return null;
  const whole = normalize(withoutSpeaker(quote)).text;
  if (whole.length < MIN_QUOTE) return null;
  const normalized = lines.map((l) => normalize(l.text));
  const found = latestMatch(normalized, whole);
  if (found) return found;
  let best: QuoteAt | null = null;
  for (const piece of quotePieces(quote, whole)) {
    const at = latestMatch(normalized, piece);
    if (at && (!best || at.line > best.line || (at.line === best.line && at.start > best.start))) best = at;
  }
  return best;
}
