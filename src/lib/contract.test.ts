import { describe, expect, it } from "vitest";
import { clauseNumbers, contractParty, fillClauses } from "./contract";

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
