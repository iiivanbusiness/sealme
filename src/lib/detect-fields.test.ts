import { describe, expect, it } from "vitest";
import { placeFields, promptDocument } from "./detect-fields";
import { buildClauses } from "./template-fields";

const clauses = [
  { title: "Parties", body: "This Agreement is made between Northpeak Creative LLC (“Agency”) and Harbor Media Inc. (“Client”)." },
  { title: "Fees", body: "Client will pay Agency a fee of $______ per month, starting on ______ and ending on ______." },
  { title: "Signatures", body: "For Client: Harbor Media Inc., by Mark Ellison, CFO." },
];

describe("placeFields", () => {
  it("turns the model's places into fields without touching any other words", () => {
    const placed = placeFields(clauses, [
      { key: "clientName", spans: [{ clause: 0, text: "Harbor Media Inc.", before: "Creative LLC (“Agency”) and" }, { clause: 2, text: "Harbor Media Inc.", before: "For Client:" }] },
      { key: "fee", spans: [{ clause: 1, text: "$______ per month", before: "Agency a fee of" }] },
    ]);
    expect(placed.dropped).toBe(0);
    expect(placed.fields.map((f) => [f.key, f.label, f.places, f.sample])).toEqual([
      ["clientName", "Client", 2, "Harbor Media Inc."],
      ["fee", "Fee", 1, "$______ per month"],
    ]);
    const saved = buildClauses(placed.clauses, new Set());
    expect(saved[0].body).toBe("This Agreement is made between Northpeak Creative LLC (“Agency”) and {clientName} (“Client”).");
    expect(saved[1].body).toBe("Client will pay Agency a fee of {fee}, starting on ______ and ending on ______.");
    expect(saved[2].body).toBe("For Client: {clientName}, by Mark Ellison, CFO.");
  });

  it("uses the words before a blank to tell identical blanks apart", () => {
    const placed = placeFields(clauses, [
      { key: "endDate", spans: [{ clause: 1, text: "______", before: "and ending on" }] },
      { key: "startDate", spans: [{ clause: 1, text: "______", before: "per month, starting on" }] },
    ]);
    const saved = buildClauses(placed.clauses, new Set());
    expect(saved[1].body).toBe("Client will pay Agency a fee of $______ per month, starting on {startDate} and ending on {endDate}.");
  });

  it("tolerates curly quotes and extra spaces in the words before", () => {
    const placed = placeFields(clauses, [{ key: "clientName", spans: [{ clause: 0, text: "Harbor Media Inc.", before: "LLC  (\"Agency\") and" }] }]);
    expect(placed.dropped).toBe(0);
    expect(buildClauses(placed.clauses, new Set())[0].body).toContain("and {clientName} (");
  });

  it("leaves identical blanks alone when the words before match none of them", () => {
    const placed = placeFields(clauses, [{ key: "startDate", spans: [{ clause: 1, text: "______", before: "something else entirely" }] }]);
    expect(placed.dropped).toBe(1);
    expect(buildClauses(placed.clauses, new Set())[1].body).toBe(clauses[1].body);
  });

  it("leaves identical blanks alone when the model gave no words before", () => {
    const placed = placeFields(clauses, [{ key: "fee", spans: [{ clause: 1, text: "$______ per month", before: "" }] }, { key: "startDate", spans: [{ clause: 1, text: "______", before: "" }] }]);
    expect(buildClauses(placed.clauses, new Set())[1].body).toBe("Client will pay Agency a fee of {fee}, starting on ______ and ending on ______.");
    expect(placed.dropped).toBe(1);
  });

  it("leaves a blank alone when the words before fit two places equally", () => {
    const placed = placeFields(
      [{ title: "Signatures", body: "AGENCY By: ____ Date: ____\nCLIENT By: ____ Date: ____" }],
      [{ key: "clientSignatureDate", spans: [{ clause: 0, text: "____", before: "Date:" }] }]
    );
    expect(placed.fields).toEqual([]);
    expect(placed.dropped).toBe(1);
  });

  it("finds a place in another clause when the model gave the wrong clause number", () => {
    const placed = placeFields(clauses, [{ key: "fee", spans: [{ clause: 2, text: "$______ per month", before: "a fee of" }] }]);
    expect(buildClauses(placed.clauses, new Set())[1].body).toContain("a fee of {fee}, starting");
    expect(placed.dropped).toBe(0);
  });

  it("covers the whole blank when the model copied too few underscores", () => {
    const placed = placeFields([{ title: "Fees", body: "A fee of $__________ per month, due by ....... each month." }], [
      { key: "fee", spans: [{ clause: 0, text: "$______ per month", before: "" }] },
      { key: "paymentTerms", spans: [{ clause: 0, text: "...", before: "due by" }] },
    ]);
    expect(buildClauses(placed.clauses, new Set())[0].body).toBe("A fee of $__________ per month, due by {paymentTerms} each month.".replace("$__________ per month", "{fee}"));
    expect(placed.fields[0].sample).toBe("$__________ per month");
  });

  it("never puts a field inside a word or number", () => {
    const placed = placeFields([{ title: "Term", body: "Signed in 2012. The term is 12 months." }], [{ key: "duration", spans: [{ clause: 0, text: "12 months", before: "" }, { clause: 0, text: "12", before: "" }] }]);
    expect(buildClauses(placed.clauses, new Set())[0].body).toBe("Signed in 2012. The term is {duration}.");
    expect(placed.dropped).toBe(1);
  });

  it("finds words the model typed with straight quotes where the file has curly ones", () => {
    const placed = placeFields([{ title: "Signatures", body: "For Client: O’Brien Media LLC, by its CEO." }], [{ key: "clientName", spans: [{ clause: 0, text: "O'Brien Media LLC", before: "For Client:" }] }]);
    expect(buildClauses(placed.clauses, new Set())[0].body).toBe("For Client: {clientName}, by its CEO.");
    expect(placed.fields[0].sample).toBe("O’Brien Media LLC");
  });

  it("joins places when the model lists the same key twice", () => {
    const placed = placeFields(clauses, [
      { key: "clientName", spans: [{ clause: 0, text: "Harbor Media Inc.", before: "" }] },
      { key: "fee", spans: [{ clause: 1, text: "$______ per month", before: "" }] },
      { key: "clientName", spans: [{ clause: 2, text: "Harbor Media Inc.", before: "For Client:" }] },
    ]);
    expect(placed.fields.map((f) => [f.key, f.places])).toEqual([["clientName", 2], ["fee", 1]]);
    expect(buildClauses(placed.clauses, new Set())[2].body).toBe("For Client: {clientName}, by Mark Ellison, CFO.");
  });

  it("drops places it can't find, invalid or reserved keys and overlaps", () => {
    const placed = placeFields(clauses, [
      { key: "fee", spans: [{ clause: 1, text: "$______ per month", before: "" }, { clause: 1, text: "$4,000", before: "" }] },
      { key: "Fee Amount", spans: [{ clause: 1, text: "per month", before: "" }] },
      { key: "constructor", spans: [{ clause: 0, text: "Agreement", before: "" }] },
      { key: "monthlyFee", spans: [{ clause: 1, text: "______ per month", before: "" }] },
      { key: "clientName", spans: [{ clause: 7, text: "Northwind", before: "" }, { clause: 0, text: "{x}", before: "" }, { clause: 0, text: "  ", before: "" }] },
    ]);
    expect(placed.fields.map((f) => f.key)).toEqual(["fee"]);
    expect(placed.dropped).toBe(7);
  });

  it("marks every other copy of the last client's name, even ones the model missed", () => {
    const placed = placeFields(clauses, [{ key: "clientName", spans: [{ clause: 0, text: "Harbor Media Inc.", before: "" }] }]);
    expect(placed.fields[0].places).toBe(2);
    expect(buildClauses(placed.clauses, new Set())[2].body).toBe("For Client: {clientName}, by Mark Ellison, CFO.");
  });

  it("marks the client's name in a signature block in capitals too", () => {
    const placed = placeFields(
      [{ title: "Parties", body: "Between Halcyon Group, Inc. and Ridgeway Analytics, Inc." }, { title: "Signatures", body: "HALCYON GROUP, INC.\nBy: Dana\n\nRIDGEWAY ANALYTICS, INC.\nBy: Marcus" }],
      [{ key: "clientName", spans: [{ clause: 0, text: "Ridgeway Analytics, Inc.", before: "Inc. and" }] }]
    );
    expect(buildClauses(placed.clauses, new Set())[1].body).toBe("HALCYON GROUP, INC.\nBy: Dana\n\n{clientName}\nBy: Marcus");
    expect(placed.fields[0].places).toBe(2);
  });

  it("doesn't copy plain words or anonymous blanks to other places", () => {
    const placed = placeFields(
      [{ title: "Term", body: "The term is 12 months. Confidentiality lasts 12 months. Fee: ______. Deposit: ______." }],
      [{ key: "duration", spans: [{ clause: 0, text: "12 months", before: "The term is" }] }, { key: "fee", spans: [{ clause: 0, text: "______", before: "Fee:" }] }]
    );
    expect(buildClauses(placed.clauses, new Set())[0].body).toBe("The term is {duration}. Confidentiality lasts 12 months. Fee: {fee}. Deposit: ______.");
  });

  it("turns merge tags from other tools into fields", () => {
    const placed = placeFields(
      [{ title: "Parties", body: "Between Agency and {{Client Name}} ({{client.email}}), signed by {{Client Name}}. Fee: {fee}." }],
      [{ key: "clientName", spans: [{ clause: 0, text: "{{Client Name}}", before: "Between Agency and" }] }, { key: "clientEmail", spans: [{ clause: 0, text: "{{client.email}}", before: "" }] }]
    );
    expect(buildClauses(placed.clauses, new Set())[0].body).toBe("Between Agency and {clientName} ({clientEmail}), signed by {clientName}. Fee: {fee}.");
  });

  it("keeps at most 30 fields", () => {
    const body = Array.from({ length: 35 }, (_, i) => `Item${i}: value${i}.`).join(" ");
    const proposed = Array.from({ length: 35 }, (_, i) => ({ key: `item${i}`, spans: [{ clause: 0, text: `value${i}`, before: "" }] }));
    const placed = placeFields([{ title: "List", body }], proposed);
    expect(placed.fields).toHaveLength(30);
    expect(placed.dropped).toBe(5);
  });

  it("keeps placeholders already in the file as fields that can't be removed", () => {
    const placed = placeFields([{ title: "Fees", body: "Client pays {fee} by {paymentTerms}." }], [{ key: "fee", spans: [{ clause: 0, text: "Client", before: "" }] }]);
    expect(placed.fields.map((f) => [f.key, f.sample])).toEqual([["fee", "Client"], ["paymentTerms", null]]);
    const saved = buildClauses(placed.clauses, new Set(["fee", "paymentTerms"]));
    expect(saved[0].body).toBe("Client pays {fee} by {paymentTerms}.");
  });

  it("puts the file's own words back for a removed field", () => {
    const placed = placeFields(clauses, [
      { key: "clientName", spans: [{ clause: 0, text: "Harbor Media Inc.", before: "" }, { clause: 2, text: "Harbor Media Inc.", before: "" }] },
      { key: "clientSignerName", spans: [{ clause: 2, text: "Mark Ellison", before: "by" }] },
    ]);
    const saved = buildClauses(placed.clauses, new Set(["clientName"]));
    expect(saved.map((c) => c.body)).toEqual([clauses[0].body, clauses[1].body, "For Client: Harbor Media Inc., by {clientSignerName}, CFO."]);
  });

  it("with nothing proposed, gives back the contract unchanged", () => {
    const placed = placeFields(clauses, []);
    expect(placed.fields).toEqual([]);
    expect(buildClauses(placed.clauses, new Set())).toEqual(clauses);
  });
});

describe("the contract as the model reads it", () => {
  it("keeps every clause of a normal contract", () => {
    const doc = promptDocument([{ title: "Fees", body: "Pay $5,000." }, { title: 'The "Term"', body: "One year." }]);
    expect(doc).toBe('<clause n="1" title="Fees">\nPay $5,000.\n</clause>\n\n<clause n="2" title="The \'Term\'">\nOne year.\n</clause>\n\n');
  });

  it("sends the start of a clause too long to fit instead of nothing", () => {
    const huge = "Client Name: ________. ".repeat(500);
    const doc = promptDocument([{ title: "", body: huge }], 5000);
    expect(doc.length).toBeLessThanOrEqual(5000);
    expect(doc).toContain("Client Name: ________.");
    expect(doc.endsWith("</clause>\n\n")).toBe(true);
  });

  it("stops at the clause that crosses the limit", () => {
    const doc = promptDocument([{ title: "A", body: "a".repeat(3000) }, { title: "B", body: "b".repeat(3000) }, { title: "C", body: "c" }], 4000);
    expect(doc).toContain('n="1"');
    expect(doc).not.toContain('n="2"');
    expect(doc).not.toContain('n="3"');
  });
});

describe("clause numbers through the review screen", () => {
  it("keeps each clause's own number from upload to save", () => {
    const clauses = [
      { title: "", body: "This Agreement is between Agency and Acme.", label: "" },
      { title: "Fees", body: "Client pays $5,000 per month.", label: "2.03" },
      { title: "Term", body: "One year." },
    ];
    const placed = placeFields(clauses, [{ key: "fee", spans: [{ clause: 1, text: "$5,000 per month", before: "Client pays" }] }]);
    expect(placed.clauses.map((c) => c.label)).toEqual(["", "2.03", undefined]);
    expect(buildClauses(placed.clauses, new Set())).toEqual([
      { title: "", body: "This Agreement is between Agency and Acme.", label: "" },
      { title: "Fees", body: "Client pays {fee}.", label: "2.03" },
      { title: "Term", body: "One year." },
    ]);
  });
});
