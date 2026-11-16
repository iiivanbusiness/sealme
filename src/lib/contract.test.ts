import { describe, expect, it } from "vitest";
import { clauseNumbers, clauseParts, contractParty, contractTerms, extractPlaceholderKeys, fillClauses, type TermField } from "./contract";

describe("contract", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    const clauses = JSON.stringify([{ title: "Parties", body: "Between Agency and {clientName}, starting {startDate}." }]);
    expect(fillClauses(clauses, [{ fieldKey: "clientName", value: "Brightline Software" }, { fieldKey: "startDate", value: null }])[0].body).toBe(
      "Between Agency and Brightline Software, starting {startDate}.",
    );
  });

  it("names the party from the contract, then the client's company, then the person", () => {
    const client = { name: "Priya Shah", company: "Brightline Software" };
    expect(contractParty([{ fieldKey: "clientName", value: "Brightline Software Inc." }], client)).toBe("Brightline Software Inc.");
    expect(contractParty([], client)).toBe("Brightline Software");
    expect(contractParty([{ fieldKey: "clientName", value: " " }], { name: "Mark Ellis", company: null })).toBe("Mark Ellis");
  });
});

describe("clause numbers", () => {
  it("counts clauses 1, 2, 3 when the template has no numbers of its own", () => {
    expect(clauseNumbers([{}, {}, {}])).toEqual(["1.", "2.", "3."]);
  });

  it("keeps an uploaded document's own numbers, with none on its opening paragraph and exhibits", () => {
    expect(clauseNumbers([{ label: "" }, { label: "1" }, { label: "2" }, { label: "" }])).toEqual(["", "1.", "2.", ""]);
    expect(clauseNumbers([{ label: "1.01" }, { label: "IV" }])).toEqual(["1.01", "IV."]);
  });

  it("shows no number on a clause added in SealMe to a document with its own numbers", () => {
    expect(clauseNumbers([{ label: "1" }, {}, { label: "2" }])).toEqual(["1.", "", "2."]);
  });

  it("counts a document whose clauses are all unnumbered", () => {
    expect(clauseNumbers([{ label: "" }, {}, {}])).toEqual(["", "1.", "2."]);
  });

  it("carries the number through filling", () => {
    const clauses = JSON.stringify([{ title: "Intro", body: "Hi {clientName}", label: "" }, { title: "Fees", body: "Pay", label: "2.03" }, { title: "Extra", body: "x" }]);
    expect(fillClauses(clauses, [{ fieldKey: "clientName", value: "Acme" }])).toEqual([
      { title: "Intro", body: "Hi Acme", label: "" },
      { title: "Fees", body: "Pay", label: "2.03" },
      { title: "Extra", body: "x" },
    ]);
  });
});

describe("clause parts", () => {
  it("cuts a body into its words and the terms in it, in order", () => {
    expect(clauseParts("Fee: {fee}, paid {paymentTerms}.")).toEqual([
      { kind: "text", text: "Fee: " },
      { kind: "field", key: "fee" },
      { kind: "text", text: ", paid " },
      { kind: "field", key: "paymentTerms" },
      { kind: "text", text: "." },
    ]);
  });

  it("handles terms side by side, at either end, and the same key twice", () => {
    expect(clauseParts("{a}{b} and {a}")).toEqual([
      { kind: "field", key: "a" },
      { kind: "field", key: "b" },
      { kind: "text", text: " and " },
      { kind: "field", key: "a" },
    ]);
    expect(clauseParts("")).toEqual([]);
    expect(clauseParts("No terms here.")).toEqual([{ kind: "text", text: "No terms here." }]);
  });

  it("leaves what isn't a term as words, line breaks included", () => {
    expect(clauseParts("Keep {{this}} and { spaced }\n(a) {fee}")).toEqual([
      { kind: "text", text: "Keep {" },
      { kind: "field", key: "this" },
      { kind: "text", text: "} and { spaced }\n(a) " },
      { kind: "field", key: "fee" },
    ]);
  });

  it("reads the same terms as filling and the key list, every time", () => {
    const body = "Between {clientName} and us, {fee} from {startDate}.";
    const json = JSON.stringify([{ title: "T", body }]);
    for (let i = 0; i < 2; i++) {
      expect(clauseParts(body).filter((p) => p.kind === "field").map((p) => (p as { key: string }).key)).toEqual(extractPlaceholderKeys(json));
    }
    expect(fillClauses(json, [{ fieldKey: "fee", value: "$4,000" }])[0].body).toBe("Between {clientName} and us, $4,000 from {startDate}.");
  });
});

describe("contract terms", () => {
  const field = (fieldKey: string, over: Partial<TermField> = {}): TermField => ({ id: `f-${fieldKey}`, fieldKey, label: fieldKey, value: null, status: "missing", sourceQuote: null, ...over });
  const clauses = [
    { title: "Parties", body: "Between Agency and {clientName}." },
    { title: "Fees", body: "{fee} a month, paid {paymentTerms}. Again: {fee}." },
    { title: "Term", body: "Starts {startDate}.", label: "3" },
  ];

  it("lists the text's terms where they first appear, then the deal's other terms", () => {
    const fields = [field("clientEmail", { label: "Client email" }), field("fee", { label: "Fee" }), field("clientName", { label: "Client", value: "Acme", status: "extracted" })];
    const terms = contractTerms(clauses, fields);
    expect(terms.map((t) => t.key)).toEqual(["clientName", "fee", "paymentTerms", "startDate", "clientEmail"]);
    expect(terms.map((t) => t.onPaper)).toEqual([true, true, true, true, false]);
  });

  it("says which are heard, typed in by the rep, or still empty", () => {
    const fields = [
      field("clientName", { value: "Acme", status: "extracted", sourceQuote: "We're Acme" }),
      field("fee", { value: "$4,000", status: "user_edited", sourceQuote: "three thousand" }),
      field("paymentTerms", { value: "Net 30", status: "confirmed" }),
      field("startDate", { value: "  ", status: "extracted", sourceQuote: "soon" }),
    ];
    const terms = contractTerms(clauses, fields);
    expect(terms.map((t) => [t.key, t.state, t.value, t.sourceQuote])).toEqual([
      ["clientName", "filled", "Acme", "We're Acme"],
      // A quote from before the rep changed it would be out of date.
      ["fee", "edited", "$4,000", null],
      ["paymentTerms", "edited", "Net 30", null],
      ["startDate", "empty", null, null],
    ]);
  });

  it("counts a term the text has but the deal has no row for as empty, labelled for people", () => {
    const [term] = contractTerms([{ title: "Seats", body: "{seatCount} seats" }], []);
    expect(term).toEqual({ key: "seatCount", label: "Seat count", fieldId: null, value: null, state: "empty", onPaper: true, sourceQuote: null });
    expect(contractTerms([{ title: "Seats", body: "{sdrCount}" }], [], (key) => (key === "sdrCount" ? "SDR count" : key))[0].label).toBe("SDR count");
  });

  it("uses the row's own label, and ties the term to its row", () => {
    const [term] = contractTerms(clauses.slice(0, 1), [field("clientName", { id: "row1", label: "Client" })], () => "Ignored");
    expect(term).toMatchObject({ label: "Client", fieldId: "row1" });
  });

  it("lists only the deal's terms when there's no text", () => {
    expect(contractTerms([], [field("clientName"), field("clientEmail", { value: "a@b.co", status: "extracted" })]).map((t) => [t.key, t.state, t.onPaper])).toEqual([
      ["clientName", "empty", false],
      ["clientEmail", "filled", false],
    ]);
  });
});
