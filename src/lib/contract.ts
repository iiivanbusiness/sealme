// label is the number an uploaded document gives the clause ("3", "2.03",
// "IV"); "" means the document leaves it unnumbered. Built-in templates and
// documents without numbers have no labels and are numbered 1, 2, 3.
export type Clause = { title: string; body: string; label?: string };

export function fillClauses(clausesJson: string, fields: { fieldKey: string; value: string | null }[]): Clause[] {
  const values = Object.fromEntries(fields.filter((f) => f.value).map((f) => [f.fieldKey, f.value as string]));
  const clauses = JSON.parse(clausesJson) as Clause[];
  return clauses.map((c) => ({
    title: c.title,
    body: c.body.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`),
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

export function extractPlaceholderKeys(clausesJson: string): string[] {
  const clauses = JSON.parse(clausesJson) as Clause[];
  const keys = new Set<string>();
  for (const clause of clauses) {
    for (const match of clause.body.matchAll(/\{(\w+)\}/g)) keys.add(match[1]);
  }
  return [...keys];
}
