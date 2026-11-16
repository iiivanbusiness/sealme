import { findQuote } from "@/lib/transcript-lines";
import { clauseParts, type ContractTerm, type TranscriptLine } from "./types";

// Pure helpers for the contract screen's components. No React, no DOM, so
// they can be tested on their own.

// "12:04", or "1:02:09" past an hour.
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// "Dana Ruiz" -> "DR", the same rule as the app's avatars.
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const second = parts[1] ? (Array.from(parts[1])[0] ?? "") : "";
  return (first + second).toUpperCase();
}

// The bold run-in title before a clause's text: "Fees." A title that
// already ends in punctuation keeps it, so there is never "Fees.." or
// "Term:." An empty title has no heading at all.
export function clauseHeading(title: string): string {
  const t = title.trim();
  if (!t) return "";
  return /[.:;?!]$/.test(t) ? t : `${t}.`;
}

// The italic line under the title: who the document is between.
export function partiesLine(kind: string, agencyName: string, partyName: string): string {
  const agency = agencyName.trim();
  const party = partyName.trim();
  if (kind === "proposal") {
    if (party && agency) return `Prepared for ${party} by ${agency}`;
    return party ? `Prepared for ${party}` : agency ? `Prepared by ${agency}` : "";
  }
  if (party && agency) return `${agency} and ${party}`;
  return party || agency;
}

// Width of the clause number column, wide enough for the longest number
// ("10.", "2.03", "XIV.") so every clause's text starts at the same edge.
export function numberColumnWidth(numbers: string[]): number {
  const longest = numbers.reduce((max, n) => Math.max(max, n.length), 0);
  return Math.max(26, Math.ceil(longest * 7.2 + 8));
}

export type TermProgress = { filled: number; total: number; complete: boolean; missing: ContractTerm[] };

export function termProgress(terms: ContractTerm[]): TermProgress {
  const missing = terms.filter((t) => t.state === "empty");
  const total = terms.length;
  const filled = total - missing.length;
  return { filled, total, complete: total > 0 && missing.length === 0, missing };
}

// The badge on the send button: "3 terms missing", "All 9 terms in".
export function termsBadge(missingCount: number, total: number): string | null {
  if (total <= 0) return null;
  if (missingCount > 0) return `${missingCount} ${missingCount === 1 ? "term" : "terms"} missing`;
  return total === 1 ? "1 term in" : `All ${total} terms in`;
}

// What the rep typed into a field, as it is saved: one line, no stray
// spaces. "" means the field was cleared.
export function normalizeEditedValue(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// The first place each placeholder appears in the text, as "clause:part",
// which is where the editor opens when a term is picked from the list.
export function firstSlots(bodies: string[]): Map<string, string> {
  const first = new Map<string, string>();
  bodies.forEach((body, ci) => {
    clauseParts(body).forEach((part, pi) => {
      if (part.kind === "field" && !first.has(part.key)) first.set(part.key, `${ci}:${pi}`);
    });
  });
  return first;
}

// The index of the clause that holds a term (first appearance), or -1.
export function clauseIndexOf(bodies: string[], key: string): number {
  return bodies.findIndex((body) => clauseParts(body).some((p) => p.kind === "field" && p.key === key));
}

// Who said a transcript line: the lead's first name for the client, "You"
// for the rep.
export function speakerLabel(line: Pick<TranscriptLine, "speaker" | "name">, clientFirstName: string | null): string {
  if (line.speaker === "you") return "You";
  if (line.speaker === "client") return clientFirstName?.trim() || line.name?.trim() || "Client";
  return line.name?.trim() || "Speaker";
}

export type HighlightTone = "green" | "yellow";
export type TextSegment = { text: string; tone: HighlightTone | null };

// Cuts one transcript line into plain and highlighted runs. Ranges are
// clipped to the text; where two overlap, yellow (just heard) wins over
// green, and of two the same color the earlier one wins.
export function splitHighlights(text: string, ranges: { start: number; end: number; tone: HighlightTone }[]): TextSegment[] {
  const clipped = ranges
    .map((r) => ({ start: Math.max(0, Math.min(text.length, r.start)), end: Math.max(0, Math.min(text.length, r.end)), tone: r.tone }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => (a.tone === b.tone ? a.start - b.start : a.tone === "yellow" ? -1 : 1));
  const kept: typeof clipped = [];
  for (const r of clipped) {
    if (!kept.some((k) => r.start < k.end && k.start < r.end)) kept.push(r);
  }
  kept.sort((a, b) => a.start - b.start);
  const out: TextSegment[] = [];
  let pos = 0;
  for (const r of kept) {
    if (r.start > pos) out.push({ text: text.slice(pos, r.start), tone: null });
    out.push({ text: text.slice(r.start, r.end), tone: r.tone });
    pos = r.end;
  }
  if (pos < text.length || out.length === 0) out.push({ text: text.slice(pos), tone: null });
  return out;
}

export type TranscriptHighlight = { line: number; start: number; end: number; tone: HighlightTone };

// Where each heard term's quote sits in the transcript, for TranscriptCard:
// green, and yellow for the term just heard. Terms the rep typed have no
// quote. Memoize on lines and terms; it scans the transcript once per term.
export function transcriptHighlights(lines: TranscriptLine[], terms: ContractTerm[], heardKey: string | null = null, heardQuote: string | null = null): TranscriptHighlight[] {
  const out: TranscriptHighlight[] = [];
  for (const term of terms) {
    if (term.state !== "filled") continue;
    const heard = term.key === heardKey;
    const quote = (heard && heardQuote) || term.sourceQuote;
    const at = quote ? findQuote(lines, quote) : null;
    if (at) out.push({ ...at, tone: heard ? "yellow" : "green" });
  }
  return out;
}

// The term to ask for next during a call: the first empty one not asked
// yet, else the first empty one. Null when every term is in.
export function nextToAsk(terms: ContractTerm[], askedKeys: ReadonlySet<string>): ContractTerm | null {
  const empty = terms.filter((t) => t.state === "empty");
  return empty.find((t) => !askedKeys.has(t.key)) ?? empty[0] ?? null;
}

// A date given as ISO ("2026-11-16T10:00:00.000Z") is shown in the viewer's
// own format; anything else is taken as text that is ready to show.
export function looksLikeIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T|$)/.test(value) && !Number.isNaN(Date.parse(value));
}

// A client's change request from the sign page, on the clause it names.
export type PaperComment = { id: string; clauseTitle: string; comment: string; fromName: string };

// Which clause each comment goes under: the first clause with the title it
// names (the sign page names clauses by title). One whose clause is gone
// (the template changed since) is loose, shown after the clauses rather
// than lost.
export function commentsByClause<C extends PaperComment>(clauses: { title: string }[], comments: C[]): { byClause: Map<number, C[]>; loose: C[] } {
  const firstByTitle = new Map<string, number>();
  clauses.forEach((c, i) => {
    if (!firstByTitle.has(c.title)) firstByTitle.set(c.title, i);
  });
  const byClause = new Map<number, C[]>();
  const loose: C[] = [];
  for (const comment of comments) {
    const at = firstByTitle.get(comment.clauseTitle);
    if (at === undefined) {
      loose.push(comment);
      continue;
    }
    if (!byClause.has(at)) byClause.set(at, []);
    byClause.get(at)!.push(comment);
  }
  return { byClause, loose };
}

// "12d left" until a contract's term ends or renews, or "Past due"; soon
// within 30 days.
export function renewalCountdown(dateIso: string, now: Date = new Date()): { label: string; soon: boolean } {
  const days = Math.ceil((new Date(dateIso).getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  if (!Number.isFinite(days)) return { label: "", soon: false };
  return { label: days > 0 ? `${days}d left` : "Past due", soon: days <= 30 };
}
