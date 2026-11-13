export async function extractText(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  if (name.endsWith(".pdf")) {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      // No "-- 2 of 5 --" page markers: pdf-parse adds them by default and
      // they'd land in the middle of whatever clause runs across the page
      // break. A page break comes through as a blank line instead.
      const result = await parser.getText({ pageJoiner: "" });
      return withoutRunningLines(result.pages.map((p) => p.text));
    } finally {
      await parser.destroy();
    }
  }
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  // .txt or anything else: treat as plain text
  return buffer.toString("utf-8");
}

// label is the clause's number as the document writes it ("3", "2.03",
// "IV"), so the contract shows the numbers its own cross-references use.
// "" means no number: the opening paragraph and the exhibits. Left out when
// the document doesn't number its clauses (ALL-CAPS headings), and they're
// numbered 1, 2, 3 (see clauseNumbers in contract.ts).
export type ParsedClause = { title: string; body: string; label?: string };

// Splits an uploaded contract into clauses at its top-level headings, in
// whichever style the document uses:
//   "1. Services" / "2) Fees"            numbered
//   "Section 1. Services"               Section N
//   "ARTICLE IV" / "Article 4 - Fees"   articles, roman numerals or digits
//   "1. Services. The Agency shall..."  heading with the clause text on the same line
//   "CONFIDENTIALITY"                   ALL-CAPS headings, when nothing is numbered
// Subsections ("1.1 Definitions", "Section 2.03") stay inside their parent
// clause on lines of their own, and exhibits after the last section become
// clauses of their own.
//
// No text is ever dropped: whatever comes before the first heading (the
// "This Agreement is made as of ... between ..." part) becomes the first
// clause, nothing is cut to a length, and a document with no recognizable
// headings comes back whole as a single clause. The only things removed are
// the heading numbers themselves ("1.", "Section 2.", "ARTICLE IV"), since the
// contract numbers its clauses on its own, and the whitespace of lines the PDF
// wrapped mid-sentence (paragraph breaks and list items keep their own lines).
export function splitIntoClauses(text: string): ParsedClause[] {
  const lines = toLines(text);
  const layout = layoutOf(lines);
  const headings = detectHeadings(lines, layout);
  const top = pickTopLevel(headings, lines);

  // Headings that don't start a clause (subsections, a title page in capitals)
  // keep their own line inside the clause text.
  const topLines = new Set(top.map((h) => h.line));
  const breakBefore = new Set<number>();
  const breakAfter = new Set<number>();
  for (const h of headings) {
    if (topLines.has(h.line)) continue;
    for (let i = h.line; i < h.next; i++) breakBefore.add(i);
    if (!h.rest) breakAfter.add(h.next - 1);
  }
  const body = (from: number, to: number, lead?: Piece) => {
    const pieces: Piece[] = lead ? [lead] : [];
    let gap = false;
    for (let i = from; i < to; i++) {
      if (!lines[i]) {
        gap = pieces.length > 0;
        continue;
      }
      pieces.push({ text: lines[i], len: lines[i].length, before: breakBefore.has(i), after: breakAfter.has(i), gap });
      gap = false;
    }
    return reflow(pieces, layout);
  };

  if (top.length === 0) {
    return [{ title: FALLBACK_TITLE, body: body(0, lines.length) || EMPTY_BODY }];
  }

  const clauses: ParsedClause[] = [];
  const preamble = body(0, top[0].line);
  if (preamble) {
    const named = top.some((h) => h.title.toLowerCase() === "introduction");
    clauses.push({ title: named ? "Preamble" : "Introduction", body: preamble, label: "" });
  }
  top.forEach((h, k) => {
    const end = k + 1 < top.length ? top[k + 1].line : lines.length;
    const lead = h.rest ? { text: h.rest, len: lines[h.line].length, before: false, after: false, gap: false } : undefined;
    const clause: ParsedClause = { title: h.title, body: body(h.next, end, lead) };
    if (h.label !== undefined) clause.label = h.label;
    clauses.push(clause);
  });
  return distinctTitles(clauses);
}

const FALLBACK_TITLE = "Agreement Text";
const EMPTY_BODY = "Paste or edit the agreement text here.";

function toLines(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\f\v\u2028\u2029]/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0\u2007\u202f]+/g, " ").trim());
}

// ---------------------------------------------------------------------------
// Headings
// ---------------------------------------------------------------------------

type Family = "article" | "section" | "exhibit" | "numbered" | "caps";

type Heading = {
  line: number; // the heading's line
  next: number; // first line after it (a name on the line below counts as part of it)
  family: Family;
  depth: number; // 1 for "3." / "Section 3" / "Article III", 2 for "3.1", 3 for "3.1.2"
  num: number; // its top-level number, 0 when it has none
  title: string;
  rest: string; // clause text on the heading's own line ("1. Services. The Agency shall ...")
  style: string; // how it's written, so real headings can be told from a numbered list
  label: string | undefined; // the number as written ("3", "2.03", "IV"); "" for an exhibit, none for an ALL-CAPS heading
};

const ARTICLE_RE = /^(?:ARTICLE|Article)\s+([IVXLCDM]{1,7}|\d{1,3})(?![\p{L}\d])\.?\s*(?:[-–—:]\s*)?(.*)$/u;
const SECTION_RE = /^(?:SECTION|Section|SEC\.|Sec\.|§§?)\s*(\d{1,3}(?:\.\d{1,3})*)\.?(?=[\s\-–—:)]|$)\s*(?:[-–—:)]\s*)?(.*)$/u;
const EXHIBIT_RE =
  /^((?:EXHIBIT|SCHEDULE|APPENDIX|ANNEX|ATTACHMENT|ADDENDUM|Exhibit|Schedule|Appendix|Annex|Attachment|Addendum)\s+(?:[A-Z]{1,2}|\d{1,3}|[IVX]{1,5})(?:[-.]\d{1,2})?)(?![\p{L}\d])\.?\s*(?:[-–—:]\s*)?(.*)$/u;
const NUMBERED_RE = /^(\d{1,3}(?:\.\d{1,3})*)([.)])?(?=\s|$)\s*(.*)$/;
// Anything that starts like a heading or list item of its own, so it's never
// taken for the name of the heading above it.
const LABEL_RE =
  /^(?:(?:ARTICLE|Article|SECTION|Section|EXHIBIT|Exhibit|SCHEDULE|Schedule|APPENDIX|Appendix|ANNEX|Annex|ATTACHMENT|Attachment|ADDENDUM|Addendum)\s|(?:SEC|Sec)\.|§|\d{1,3}(?:\.\d{1,3})*[.)]?(?:\s|$)|\(?[a-z]{1,3}\)\s)/;
// Table-of-contents dot leaders, and signature lines.
const LEADER_RE = /(?:\.{4,}|…{2,}|(?:\.\s){3,}|_{4,})\s*\d*\s*$/;
const INLINE_RE = /^(.{2,100}?)(?:\.\s+|:\s+|\s+[-–—]\s+)(\S.*)$/u;
const TITLE_START_RE = /^["“'(\[]?\p{Lu}/u;
// "NOTE: Backups are kept for 30 days." is a remark inside a clause.
const NOTE_RE = /^(?:NOTE|NOTES|PLEASE NOTE|IMPORTANT|WARNING|CAUTION|ATTENTION)$/;

const MINOR_WORDS = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "nor", "of", "on", "or", "per", "the", "to", "upon", "via", "vs", "with", "without"]);
const ABBREVIATIONS = new Set(["inc", "co", "corp", "ltd", "llc", "llp", "lp", "no", "nos", "mr", "mrs", "ms", "dr", "st", "sec", "art", "vs", "etc", "u.s", "e.g", "i.e"]);

function detectHeadings(lines: string[], layout: Layout): Heading[] {
  const headings: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines, i, layout);
    if (!h) continue;
    headings.push(h);
    i = h.next - 1;
  }
  return headings;
}

function headingAt(lines: string[], i: number, layout: Layout): Heading | null {
  const line = lines[i];
  if (!line || LEADER_RE.test(line)) return null;
  let m: RegExpExecArray | null;

  if ((m = ARTICLE_RE.exec(line))) {
    const named = resolveTitle(lines, i, m[2], true);
    if (named) return heading(i, named, "article", 1, toNumber(m[1]), line, m[1]);
  }
  if ((m = SECTION_RE.exec(line))) {
    const parts = m[1].split(".");
    const named = resolveTitle(lines, i, m[2], true);
    if (named) return heading(i, named, "section", parts.length, Number(parts[0]), line, m[1]);
  }
  // The rest of a sentence the PDF wrapped, not a heading: the line above
  // runs to the margin without ending ("...attached as" over "Exhibit A.",
  // "...FITNESS FOR A" over "PARTICULAR PURPOSE.").
  const prev = i > 0 ? lines[i - 1] : "";
  const continues =
    layout.kind === "wrapped" &&
    !!prev &&
    !/[.:;!?)\]"”’'_]$/.test(prev) &&
    (isAllCaps(prev) ? wordCount(prev) > 8 : prev.length >= 0.7 * layout.width && !isTitleCase(prev));
  if (!continues && (m = EXHIBIT_RE.exec(line))) {
    // Exhibits keep their label: "Exhibit B" is how the contract refers to it.
    const label = m[1];
    if (m[2] && standaloneTitle(m[2])) return heading(i, { title: cleanTitle(line), rest: "", next: i + 1 }, "exhibit", 1, 0, line, "");
    if (!m[2]) {
      const named = resolveTitle(lines, i, "", true)!;
      return heading(i, { ...named, title: named.title ? `${label} - ${named.title}` : label }, "exhibit", 1, 0, line, "");
    }
  }
  if ((m = NUMBERED_RE.exec(line))) {
    const parts = m[1].split(".");
    // A lone "30" starting a line is a wrapped sentence ("30 days after ..."),
    // not a heading; "30." or "30)" or "3.1" is.
    if (parts.length > 1 || m[2]) {
      const named = resolveTitle(lines, i, m[3], false);
      if (named) return heading(i, named, "numbered", parts.length, Number(parts[0]), line, m[1]);
    }
  }

  if (continues) return null;
  // An ALL-CAPS heading, but not the last line of a paragraph in capitals
  // ("NO OTHER WARRANTIES ARE GIVEN."), a line with a number in it, or the
  // first line of an address ("ACME CORPORATION" over "1200 MARKET STREET").
  const capitals = line.match(/\p{Lu}/gu)?.length ?? 0;
  const next = lines[i + 1] ?? "";
  if (isAllCaps(line) && capitals >= 3 && line.length <= 80 && wordCount(line) <= 8 && !/[,;.!?]$/.test(line) && !/\d/.test(line) && !(isAllCaps(next) && /\d/.test(next))) {
    const title = cleanTitle(line);
    if (title) return heading(i, { title, rest: "", next: i + 1 }, "caps", 1, 0, line, undefined);
  }
  const inline = inlineTitle(line);
  if (inline && isAllCaps(inline.title) && (inline.title.match(/\p{Lu}/gu)?.length ?? 0) >= 3 && /\p{Ll}/u.test(inline.rest) && !NOTE_RE.test(inline.title)) {
    return heading(i, { ...inline, next: i + 1 }, "caps", 1, 0, line, undefined);
  }
  return null;
}

type Named = { title: string; rest: string; next: number };

function heading(i: number, named: Named, family: Family, depth: number, num: number, line: string, label: string | undefined): Heading {
  const title = named.title || cleanTitle(line);
  const lettering = isAllCaps(title) ? "caps" : isTitleCase(title) ? "title" : "sentence";
  return { line: i, next: named.next, family, depth, num, title, rest: named.rest, style: `${named.rest ? "inline" : "own-line"} ${lettering}`, label };
}

// The name that goes with a heading label, from what follows the label on its
// line (`rest`), or from the line below when the label stands alone
// ("ARTICLE IV" over "INDEMNIFICATION"). `bare` accepts a label with no name
// at all ("Section 7"); the label itself becomes the title then.
function resolveTitle(lines: string[], i: number, rest: string, bare: boolean): Named | null {
  if (rest) {
    const title = standaloneTitle(rest);
    if (title) return { title, rest: "", next: i + 1 };
    const inline = inlineTitle(rest);
    return inline ? { ...inline, next: i + 1 } : null;
  }
  let j = i + 1;
  if (j < lines.length && !lines[j]) j++;
  const below = lines[j];
  if (below && !LABEL_RE.test(below)) {
    const title = standaloneTitle(below);
    if (title && (isAllCaps(title) || isTitleCase(title))) {
      // A long name in capitals wrapped onto a second line:
      // "REPRESENTATIONS AND WARRANTIES OF" over "THE COMPANY".
      const more = lines[j + 1];
      if (isAllCaps(title) && /\s(?:OF|AND|OR|THE|FOR|TO|IN|ON|WITH|BY)$/.test(title) && more && isAllCaps(more) && wordCount(more) <= 6 && !LABEL_RE.test(more)) {
        return { title: `${title} ${cleanTitle(more)}`, rest: "", next: j + 2 };
      }
      return { title, rest: "", next: j + 1 };
    }
  }
  return bare ? { title: "", rest: "", next: i + 1 } : null;
}

// A heading's whole text: "Fees and Payment", "CONFIDENTIALITY", "Governing law".
function standaloneTitle(s: string): string | null {
  const title = cleanTitle(s);
  if (!title || title.length > 100 || !TITLE_START_RE.test(title) || wordCount(title) > 14) return null;
  // "Definitions 1": a table-of-contents entry with its page number.
  if (/\s\d{1,3}$/.test(title)) return null;
  if (isAllCaps(title) || isTitleCase(title)) return title;
  // Sentence-case headings, as long as the line doesn't read like a sentence.
  return wordCount(title) <= 6 && !/[.,;:]$/.test(s.trim()) ? title : null;
}

// "Services. The Agency shall ...": a heading with the clause's first
// sentence on the same line.
function inlineTitle(s: string): { title: string; rest: string } | null {
  const m = INLINE_RE.exec(s);
  if (!m) return null;
  const title = m[1].trim();
  if (!TITLE_START_RE.test(title) || wordCount(title) > 14 || !(isAllCaps(title) || isTitleCase(title))) return null;
  // "Acme Inc. shall ..." or "Exhibit A. The ...": a period that doesn't end a heading.
  const last = title.split(" ").pop() ?? "";
  if (ABBREVIATIONS.has(last.toLowerCase().replace(/[^a-z.]/g, "")) || /^\p{Lu}$/u.test(last)) return null;
  return { title: cleanTitle(title), rest: m[2] };
}

function cleanTitle(s: string): string {
  return s.replace(/[\s.:;,\-–—]+$/u, "").trim();
}

function wordCount(s: string): number {
  return s.split(" ").filter(Boolean).length;
}

function isAllCaps(s: string): boolean {
  return !/\p{Ll}/u.test(s) && (s.match(/\p{Lu}/gu)?.length ?? 0) >= 2;
}

function isTitleCase(s: string): boolean {
  const words = s
    .split(" ")
    .map((w) => w.replace(/^[^\p{L}\d]+/u, ""))
    .filter((w) => /\p{L}/u.test(w));
  return words.length > 0 && words.every((w, i) => /^[\p{Lu}\d]/u.test(w) || (i > 0 && MINOR_WORDS.has(w.replace(/[^\p{L}]/gu, "").toLowerCase())));
}

function toNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let k = 0; k < s.length; k++) {
    const value = values[s[k].toUpperCase()];
    const following = k + 1 < s.length ? values[s[k + 1].toUpperCase()] : 0;
    total += value < following ? -value : value;
  }
  return total;
}

// The headings that start clauses: the outermost numbering the document uses
// (articles over sections over plain numbers), then ALL-CAPS headings when
// nothing is numbered, plus any exhibits after the last numbered heading.
function pickTopLevel(headings: Heading[], lines: string[]): Heading[] {
  const nextText = (from: number) => {
    let j = from;
    while (j < lines.length && !lines[j]) j++;
    return j;
  };
  // A list of exhibits inside a clause ("Exhibit A - SOW" over "Exhibit B -
  // Pricing"): an exhibit with nothing in it before the next one starts.
  const allExhibits = headings.filter((h) => h.family === "exhibit");
  const exhibits = allExhibits.filter((e, k) => !(k + 1 < allExhibits.length && nextText(e.next) === allExhibits[k + 1].line));
  // A numbered list after a line ending in ":" ("used only for:" over "1. Due
  // Diligence" and "2. Integration Planning"), with nothing between its
  // items: list items, not headings, even when the list is longer than the
  // run of real headings.
  const listItems = new Set<number>();
  const numbered = headings.filter((h) => h.family === "numbered" && h.depth === 1);
  numbered.forEach((h, k) => {
    if (listItems.has(h.line) || h.rest || h.num !== 1) return;
    let p = h.line - 1;
    while (p >= 0 && !lines[p]) p--;
    if (p < 0 || !/:$/.test(lines[p])) return;
    const run = [h];
    for (let n = k + 1; n < numbered.length; n++) {
      const cur = run[run.length - 1];
      const nx = numbered[n];
      if (nx.rest || nx.num !== cur.num + 1 || nextText(cur.next) !== nx.line) break;
      run.push(nx);
    }
    if (run.length >= 2) run.forEach((r) => listItems.add(r.line));
  });
  headings = headings.filter((h) => !listItems.has(h.line));
  const withExhibits = (run: Heading[]) => {
    const last = run[run.length - 1].line;
    return [...run, ...exhibits.filter((e) => e.line > last)];
  };
  for (const family of ["article", "section", "numbered"] as const) {
    const run = longestRun(headings.filter((h) => h.family === family && h.depth === 1));
    if (run.length >= 2) return withExhibits(run);
  }
  // Only subsections ("Section 1.01", "Section 2.03" with no parent headings):
  // each one is a clause of its own.
  for (const family of ["section", "numbered"] as const) {
    const subsections = headings.filter((h) => h.family === family && h.depth === 2);
    if (subsections.length >= 2) return withExhibits(subsections);
  }
  const capitals = headings.filter((h) => h.family === "caps" || exhibits.includes(h));
  return capitals.length >= 2 ? capitals : [];
}

// The longest run of headings numbered 1, 2, 3, ... in document order. A
// numbered list inside a clause ("1. ... 2. ... 3.") restarts the count, so it
// can't stretch the run and stays in the clause text. One missing number is
// bridged ("7. [intentionally omitted]" isn't a heading), so a single heading
// we can't read doesn't cut the run in two. Among equally long runs, the one
// with fewer gaps wins, then the one written most consistently, then the one
// that starts first.
function longestRun(candidates: Heading[]): Heading[] {
  type Link = { len: number; gaps: number; alike: number; start: number; prev: number };
  const compare = (a: Link, b: Link) => a.len - b.len || b.gaps - a.gaps || a.alike - b.alike;
  const links: Link[] = [];
  candidates.forEach((h, i) => {
    let best: Link = { len: 1, gaps: 0, alike: 0, start: i, prev: -1 };
    for (let j = 0; j < i; j++) {
      const step = h.num - candidates[j].num;
      if (step !== 1 && step !== 2) continue;
      const from = links[j];
      const link = { len: from.len + 1, gaps: from.gaps + step - 1, alike: from.alike + (candidates[j].style === h.style ? 1 : 0), start: from.start, prev: j };
      // On a full tie, the nearest heading before this one is its predecessor.
      if ((compare(link, best) || best.start - link.start) >= 0) best = link;
    }
    links.push(best);
  });

  let end = -1;
  const span = (k: number) => candidates[k].line - candidates[links[k].start].line;
  links.forEach((link, i) => {
    if (end < 0 || (compare(link, links[end]) || span(i) - span(end)) > 0) end = i;
  });
  const run: Heading[] = [];
  for (let k = end; k >= 0; k = links[k].prev) run.unshift(candidates[k]);
  return run;
}

// Two clauses with the same title would share comments and change requests
// (they're keyed by title), so a repeat gets a number.
function distinctTitles(clauses: ParsedClause[]): ParsedClause[] {
  const seen = new Map<string, number>();
  return clauses.map((clause) => {
    const key = clause.title.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? clause : { ...clause, title: `${clause.title} (${count})` };
  });
}

// ---------------------------------------------------------------------------
// Clause text: keeping paragraphs and lists, undoing a PDF's line wrapping
// ---------------------------------------------------------------------------

type Piece = { text: string; len: number; before: boolean; after: boolean; gap: boolean };

// "paragraphs": a .docx (one paragraph per line, blank lines between) or a
// tidy .txt, where every line break is meant. "wrapped": a PDF or a .txt
// wrapped at a fixed width, where most line breaks just fall wherever the
// line ran out. "lines": long lines with nothing between them, kept as is.
type Layout = { kind: "paragraphs" | "wrapped" | "lines"; width: number };

function layoutOf(lines: string[]): Layout {
  let adjacent = 0;
  let gapped = 0;
  let last = -1;
  const lengths: number[] = [];
  lines.forEach((line, i) => {
    if (!line) return;
    if (last >= 0) {
      if (i === last + 1) adjacent++;
      else gapped++;
    }
    last = i;
    if (line.length >= 20) lengths.push(line.length);
  });
  if (gapped > adjacent) return { kind: "paragraphs", width: 0 };
  lengths.sort((a, b) => a - b);
  const width = lengths.length > 0 ? lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * 0.75))] : 0;
  return { kind: width >= 30 && width <= 150 ? "wrapped" : "lines", width };
}

const LIST_START_RE = /^(?:\((?:[a-z]{1,2}|[ivxlc]{1,6}|\d{1,3})\)|(?:[a-z]|[ivxlc]{1,6}|\d{1,3}(?:\.\d{1,3})*)[.)](?=\s)|\d{1,3}\.\d{1,3}(?:\.\d{1,3})*(?=\s)|[•●▪◦·*–—-](?=\s))/i;
const ENDS_CLAUSE_RE = /(?:[.:;!?]["'”’)\]]*|\b(?:and|or))$/i;
const ENDS_SENTENCE_RE = /[.:;!?]["'”’)\]]*$/;
const STARTS_SENTENCE_RE = /^["“'(\[]?[\p{Lu}\d]/u;

function reflow(pieces: Piece[], layout: Layout): string {
  let out = "";
  pieces.forEach((piece, k) => {
    out += k === 0 ? piece.text : separator(pieces[k - 1], piece, layout) + piece.text;
  });
  return out;
}

function separator(prev: Piece, cur: Piece, { kind, width }: Layout): string {
  const lineBreak = cur.gap ? "\n\n" : "\n";
  if (kind !== "wrapped") return lineBreak;
  const keep =
    prev.after ||
    cur.before ||
    // A line that stops well short of the margin ended on purpose: the end of
    // a paragraph, a heading, an address or signature line.
    prev.len < 0.7 * width ||
    (LIST_START_RE.test(cur.text) && ENDS_CLAUSE_RE.test(prev.text)) ||
    (isAllCaps(cur.text) && cur.len < 0.6 * width) ||
    // A sentence that ends short of a full line most likely ends its paragraph
    // (pdf-parse doesn't mark the space between paragraphs).
    (ENDS_SENTENCE_RE.test(prev.text) && prev.len < 0.9 * width && STARTS_SENTENCE_RE.test(cur.text));
  if (keep) return lineBreak;
  // "non-" + "exclusive" across a line break: rejoined without a space, the
  // hyphen kept, since it can't be told from a word the PDF hyphenated.
  return /\p{L}-$/u.test(prev.text) && /^\p{Ll}/u.test(cur.text) ? "" : " ";
}

// Page headers and footers ("CONFIDENTIAL", "Page 2 of 5", a bare page
// number): lines that repeat, digits aside, among the first or last two
// lines of at least half the pages. Left in, they'd sit in the middle of a
// sentence that runs across the page break, or become clauses of their own.
function withoutRunningLines(pages: string[]): string {
  if (pages.length < 2) return pages.join("\n");
  const key = (l: string) => l.trim().replace(/\d+/g, "#");
  const edges = (p: string) => {
    const filled = p.split("\n").filter((l) => l.trim());
    return [...filled.slice(0, 2), ...filled.slice(-2)];
  };
  const count = new Map<string, number>();
  for (const p of pages) for (const k of new Set(edges(p).map(key))) count.set(k, (count.get(k) ?? 0) + 1);
  const min = Math.max(2, Math.ceil(pages.length / 2));
  return pages
    .map((p) => {
      const edge = new Set(edges(p));
      return p
        .split("\n")
        .filter((l) => !(edge.has(l) && (count.get(key(l)) ?? 0) >= min))
        .join("\n");
    })
    .join("\n");
}
