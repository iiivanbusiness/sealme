// label is the number an uploaded document gives the clause ("3", "2.03",
// "IV"); "" means the document leaves it unnumbered. Built-in templates and
// documents without numbers have no labels and are numbered 1, 2, 3.
export type Clause = { title: string; body: string; label?: string };

// A term in a clause body: {fee}, {startDate}. The one pattern every reader
// of a template uses (filling, the paper on the contract screen, the list of
// terms), so they never disagree on where a term sits. Global, so only use it
// with replace and matchAll, which don't keep state between calls.
const PLACEHOLDER = /\{(\w+)\}/g;

export function fillClauses(clausesJson: string, fields: { fieldKey: string; value: string | null }[]): Clause[] {
  const values = Object.fromEntries(fields.filter((f) => f.value).map((f) => [f.fieldKey, f.value as string]));
  const clauses = JSON.parse(clausesJson) as Clause[];
  return clauses.map((c) => ({
    title: c.title,
    body: c.body.replace(PLACEHOLDER, (_, key: string) => values[key] ?? `{${key}}`),
    ...(typeof c.label === "string" ? { label: c.label } : {}),
  }));
}

// The number shown before each clause title ("3.", "2.03", "IV."). A
// document that numbers its own clauses keeps its numbers, so "see Section 2"
// in the text still points at the right clause; a clause added in SealMe
// shows none there. Everything else is counted 1, 2, 3. "" means no number.
export function clauseNumbers(clauses: { label?: string }[]): string[] {
  const own = clauses.some((c) => c.label);
  let n = 0;
  const shown = (label: string) => (!label || label.includes(".") ? label : `${label}.`);
  return clauses.map((c) => shown(typeof c.label === "string" ? c.label : own ? "" : String(++n)));
}

// Who a contract is with: the party its Parties clause names (the client's
// company when one was heard, else the person), or the client on file.
export function contractParty(fields: { fieldKey: string; value: string | null }[], client: { name: string; company?: string | null }): string {
  return fields.find((f) => f.fieldKey === "clientName")?.value?.trim() || client.company?.trim() || client.name;
}

function bodyKeys(clauses: Clause[]): string[] {
  const keys = new Set<string>();
  for (const clause of clauses) {
    for (const match of clause.body.matchAll(PLACEHOLDER)) keys.add(match[1]);
  }
  return [...keys];
}

export function extractPlaceholderKeys(clausesJson: string): string[] {
  return bodyKeys(JSON.parse(clausesJson) as Clause[]);
}

// A clause body cut into its own words and the terms in it, in order, so the
// contract screen can draw each term where it sits. Every place one key
// appears is the same term.
export type ClausePart = { kind: "text"; text: string } | { kind: "field"; key: string };

export function clauseParts(body: string): ClausePart[] {
  const parts: ClausePart[] = [];
  let at = 0;
  for (const match of body.matchAll(PLACEHOLDER)) {
    const start = match.index ?? 0;
    if (start > at) parts.push({ kind: "text", text: body.slice(at, start) });
    parts.push({ kind: "field", key: match[1] });
    at = start + match[0].length;
  }
  if (at < body.length) parts.push({ kind: "text", text: body.slice(at) });
  return parts;
}

// What the contract screen needs of a deal term. A DealField row has these.
export type TermField = { id: string; fieldKey: string; label: string; value: string | null; status: string; sourceQuote: string | null };
// filled: heard on the call (or there from the start); edited: typed or
// changed by the rep; empty: no value yet, or no row for a term the text has.
export type TermState = "filled" | "edited" | "empty";
// onPaper: the term is in the text. One that isn't (the client's email, or
// the client's name when the template doesn't print it) is still needed to
// send, so it's edited in the list instead. sourceQuote is what the call said
// for a heard term only: an edited or empty one has nothing current to quote.
export type ContractTerm = { key: string; label: string; fieldId: string | null; value: string | null; state: TermState; onPaper: boolean; sourceQuote: string | null };

const EDITED_STATUSES = new Set(["confirmed", "user_edited"]);

// "billingCycle" reads as "Billing cycle". field-meta.ts has the full rules
// (and the standard labels); this keeps the file free of imports.
function humanizeKey(key: string): string {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

// Every term of a document: the ones in its text in the order they first
// appear, then the deal's other terms in the order given. The same list the
// send check counts: a term with no value, or one the text has but the deal
// has no row for, is empty and holds the send.
export function contractTerms(clauses: Clause[], fields: TermField[], labelFor: (key: string) => string = humanizeKey): ContractTerm[] {
  const byKey = new Map<string, TermField>();
  for (const f of fields) if (!byKey.has(f.fieldKey)) byKey.set(f.fieldKey, f);
  const onPaper = bodyKeys(clauses);
  const inText = new Set(onPaper);
  const keys = [...onPaper, ...[...byKey.keys()].filter((key) => !inText.has(key))];

  return keys.map((key) => {
    const field = byKey.get(key) ?? null;
    const value = field?.value?.trim() ? field.value : null;
    const state: TermState = value === null ? "empty" : EDITED_STATUSES.has(field?.status ?? "") ? "edited" : "filled";
    return {
      key,
      label: field?.label?.trim() || labelFor(key),
      fieldId: field?.id ?? null,
      value,
      state,
      onPaper: inText.has(key),
      sourceQuote: state === "filled" ? field?.sourceQuote?.trim() || null : null,
    };
  });
}
