import { describe, expect, it } from "vitest";
import { addField, buildClauses, keyForName, otherPlaces, type ReviewClause } from "@/lib/template-fields";

const clauses: ReviewClause[] = [
  { title: "Parties", segments: [{ kind: "text", text: "This Agreement is between Harbor Media LLC and " }, { kind: "field", key: "clientName", original: "Acme Inc." }, { kind: "text", text: "." }] },
  { title: "Fees", segments: [{ kind: "text", text: "Client pays a setup fee of $2,000 and a monthly fee of $5,000. The $2,000 is due on signing." }] },
  { title: "Notices", segments: [{ kind: "text", text: "Notices go to Jane Doe, who approves invoices of $2,0000 or more.", signature: true }] },
];

describe("addField", () => {
  it("makes the picked words a field and keeps them to put back", () => {
    const text = (clauses[1].segments[0] as { text: string }).text;
    const start = text.indexOf("$2,000");
    const out = addField(clauses, "setupFee", { clause: 1, segment: 0, start, end: start + 6 });
    expect(out[1].segments).toEqual([
      { kind: "text", text: "Client pays a setup fee of " },
      { kind: "field", key: "setupFee", original: "$2,000" },
      { kind: "text", text: " and a monthly fee of $5,000. The $2,000 is due on signing." },
    ]);
    expect(out[0]).toBe(clauses[0]);
    expect(buildClauses(out, new Set())[1].body).toBe("Client pays a setup fee of {setupFee} and a monthly fee of $5,000. The $2,000 is due on signing.");
    expect(buildClauses(out, new Set(["setupFee"]))[1].body).toBe((clauses[1].segments[0] as { text: string }).text);
  });

  it("marks every place with the same words, never part of a longer number, and keeps the signature mark", () => {
    const text = (clauses[1].segments[0] as { text: string }).text;
    const start = text.indexOf("$2,000");
    expect(otherPlaces(clauses, "$2,000")).toBe(1);
    expect(otherPlaces(clauses, "invoices")).toBe(0);
    expect(otherPlaces([...clauses, { title: "Billing", segments: [{ kind: "text", text: "Jane Doe approves invoices." }] }], "invoices")).toBe(1);
    expect(otherPlaces([...clauses, { title: "Billing", segments: [{ kind: "text", text: "Jane Doe approves invoices." }] }], "invoices", { dropSignature: true })).toBe(0);
    const out = addField(clauses, "setupFee", { clause: 1, segment: 0, start, end: start + 6 }, true);
    expect(buildClauses(out, new Set())[1].body).toBe("Client pays a setup fee of {setupFee} and a monthly fee of $5,000. The {setupFee} is due on signing.");
    expect(out[2]).toBe(clauses[2]);
    const named = addField(clauses, "clientContactName", { clause: 2, segment: 0, start: 14, end: 22 }, true);
    expect(named[2].segments.every((s) => s.signature)).toBe(true);
    expect(buildClauses(named, new Set())[2].body).toBe("Notices go to {clientContactName}, who approves invoices of $2,0000 or more.");
  });

  it("does nothing for a pick that isn't plain text", () => {
    expect(addField(clauses, "fee", { clause: 0, segment: 1, start: 0, end: 4 })).toBe(clauses);
    expect(addField(clauses, "fee", { clause: 1, segment: 0, start: 3, end: 3 })).toBe(clauses);
  });
});

describe("keyForName", () => {
  const known = [{ key: "clientName", label: "Client" }, { key: "fee", label: "Fee" }, { key: "startDate", label: "Start date" }];

  it("reuses a field the name matches, by label or key", () => {
    expect(keyForName("fee", known)).toBe("fee");
    expect(keyForName(" Start Date ", known)).toBe("startDate");
    expect(keyForName("clientname", known)).toBe("clientName");
  });

  it("makes a lowerCamelCase key from a new name", () => {
    expect(keyForName("Setup fee", known)).toBe("setupFee");
    expect(keyForName("Client's CFO", known)).toBe("clientCfo");
    expect(keyForName("SDR count", known)).toBe("sdrCount");
    expect(keyForName("2nd payment date", known)).toBe("field2ndPaymentDate");
  });

  it("refuses names that can't be a key", () => {
    expect(keyForName("", known)).toBeNull();
    expect(keyForName("x", known)).toBeNull();
    expect(keyForName("!!!", known)).toBeNull();
    expect(keyForName("constructor", known)).toBeNull();
  });
});
