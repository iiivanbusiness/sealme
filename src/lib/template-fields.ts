import { fieldMeta } from "@/lib/field-meta";

// The shapes an uploaded contract goes through between "found the fields"
// and "saved as a template". Kept free of server-only imports so the review
// screen in the browser can use buildClauses too.

export type Clause = { title: string; body: string; label?: string };

// A clause cut into plain text and fields, so the review screen can show
// each field where it sits and put the file's own words back if the user
// says a field is wrong. original is null for a {placeholder} that was
// already in the uploaded file: there's nothing to put back. signature
// marks the file's own signature block, which is left out on save unless
// the user keeps it (SealMe adds its own signature section).
export type Segment =
  | { kind: "text"; text: string; signature?: boolean }
  | { kind: "field"; key: string; original: string | null; signature?: boolean };
export type ReviewClause = { title: string; segments: Segment[]; label?: string };
// One field as the review screen lists it: where it first appears, how many
// places it fills, and an example of the words it replaces.
export type FoundField = { key: string; label: string; places: number; sample: string | null };
export type PlacedFields = { clauses: ReviewClause[]; fields: FoundField[]; dropped: number };

// What the model proposes. clause is 0-based here (the prompt numbers them
// from 1); text must be copied exactly from that clause; before is the few
// words right ahead of it, to tell apart two identical blanks.
export type ProposedField = { key: string; spans: { clause: number; text: string; before: string }[] };

// dropSignature: leave out the file's signature block, and any clause that
// was nothing but signature block.
export type BuildOptions = { dropSignature?: boolean };

// The template as it gets saved: kept fields become {key}, removed ones go
// back to the file's own words. A field that was already a {placeholder}
// in the file always stays one.
export function buildClauses(clauses: ReviewClause[], removed: ReadonlySet<string>, { dropSignature = false }: BuildOptions = {}): Clause[] {
  const out: Clause[] = [];
  for (const c of clauses) {
    const parts = dropSignature ? c.segments.filter((s) => !s.signature) : c.segments;
    let body = parts.map((s) => (s.kind === "text" ? s.text : s.original === null || !removed.has(s.key) ? `{${s.key}}` : s.original)).join("");
    if (parts.length !== c.segments.length) {
      body = body.replace(/\s+$/, "");
      if (!body.trim()) continue;
    }
    out.push(c.label === undefined ? { title: c.title, body } : { title: c.title, body, label: c.label });
  }
  return out;
}

// Fields in the order they first appear in the contract. With
// dropSignature, a field only in the file's signature block isn't listed.
export function listFields(clauses: ReviewClause[], { dropSignature = false }: BuildOptions = {}): FoundField[] {
  const byKey = new Map<string, FoundField>();
  for (const c of clauses) {
    for (const s of c.segments) {
      if (s.kind !== "field" || (dropSignature && s.signature)) continue;
      const f = byKey.get(s.key);
      if (f) {
        f.places++;
        if (!f.sample && s.original) f.sample = s.original;
      } else {
        byKey.set(s.key, { key: s.key, label: fieldMeta(s.key).label, places: 1, sample: s.original });
      }
    }
  }
  return [...byKey.values()];
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

// Where these exact words sit in plain text (not inside a field), never in
// the middle of a word: "12" is not the "12" in "2012".
function placesIn(text: string, words: string): number[] {
  const out: number[] = [];
  if (!words) return out;
  for (let at = text.indexOf(words); at !== -1; at = text.indexOf(words, at + words.length)) {
    const end = at + words.length;
    const cutsStart = WORD_CHAR.test(text[at]) && WORD_CHAR.test(text[at - 1] ?? "");
    const cutsEnd = WORD_CHAR.test(text[end - 1]) && WORD_CHAR.test(text[end] ?? "");
    if (!cutsStart && !cutsEnd) out.push(at);
  }
  return out;
}

// How many other places in the contract's plain text have the same words.
// With dropSignature, places in the file's removed signature block don't
// count: they aren't part of the contract that gets saved.
export function otherPlaces(clauses: ReviewClause[], words: string, { dropSignature = false }: BuildOptions = {}): number {
  let n = 0;
  for (const c of clauses) {
    for (const seg of c.segments) {
      if (seg.kind === "text" && !(dropSignature && seg.signature)) n += placesIn(seg.text, words).length;
    }
  }
  return Math.max(0, n - 1);
}

export type TextPick = { clause: number; segment: number; start: number; end: number };

// The user marked words in the contract as a field: they become the field
// where they were picked, and with everywhere, wherever the same words sit
// in plain text too. The words are kept as the field's original, so taking
// the field back out puts them back.
export function addField(clauses: ReviewClause[], key: string, pick: TextPick, everywhere = false): ReviewClause[] {
  const at = clauses[pick.clause]?.segments[pick.segment];
  if (!at || at.kind !== "text") return clauses;
  const words = at.text.slice(pick.start, pick.end);
  if (!words.trim()) return clauses;

  return clauses.map((c, ci) => {
    let changed = false;
    const segments: Segment[] = [];
    for (const [j, seg] of c.segments.entries()) {
      const starts = seg.kind !== "text" ? [] : everywhere ? placesIn(seg.text, words) : ci === pick.clause && j === pick.segment ? [pick.start] : [];
      if (seg.kind !== "text" || !starts.length) {
        segments.push(seg);
        continue;
      }
      changed = true;
      const extra = seg.signature ? { signature: true } : {};
      let pos = 0;
      for (const start of starts) {
        if (start > pos) segments.push({ kind: "text", text: seg.text.slice(pos, start), ...extra });
        segments.push({ kind: "field", key, original: words, ...extra });
        pos = start + words.length;
      }
      if (pos < seg.text.length) segments.push({ kind: "text", text: seg.text.slice(pos), ...extra });
    }
    return changed ? { ...c, segments } : c;
  });
}

const KEY = /^[a-z][a-zA-Z0-9]{1,39}$/;
const RESERVED = new Set(Object.getOwnPropertyNames(Object.prototype));

// The key for a field the user names: an existing field or a standard one
// when the name matches it ("fee", "Start date"), otherwise the name in
// lowerCamelCase ("Setup fee" is setupFee). Null when it can't be a key.
export function keyForName(name: string, known: { key: string; label: string }[]): string | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const hit = known.find((f) => f.label.toLowerCase() === wanted || f.key.toLowerCase() === wanted);
  if (hit) return hit.key;
  const words = name.replace(/['’]s\b/gi, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return null;
  let key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join("");
  if (!/^[a-z]/.test(key)) key = `field${key[0].toUpperCase()}${key.slice(1)}`;
  key = key.slice(0, 40);
  return KEY.test(key) && !RESERVED.has(key) ? key : null;
}
