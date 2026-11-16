import { describe, expect, it } from "vitest";
import {
  clauseHeading,
  clauseIndexOf,
  commentsByClause,
  firstSlots,
  formatElapsed,
  initialsOf,
  looksLikeIsoDate,
  nextToAsk,
  normalizeEditedValue,
  numberColumnWidth,
  partiesLine,
  renewalCountdown,
  speakerLabel,
  splitHighlights,
  termProgress,
  termsBadge,
  transcriptHighlights,
} from "./paper-utils";
import type { ContractTerm } from "./types";

const term = (key: string, state: ContractTerm["state"], value: string | null = null): ContractTerm => ({
  key,
  label: key,
  fieldId: null,
  value,
  state,
  onPaper: true,
  sourceQuote: null,
});

describe("formatElapsed", () => {
  it("shows minutes and seconds, and hours past an hour", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(768_400)).toBe("12:48");
    expect(formatElapsed(3_729_000)).toBe("1:02:09");
  });
  it("never goes below zero or breaks on bad input", () => {
    expect(formatElapsed(-5000)).toBe("0:00");
    expect(formatElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("initialsOf", () => {
  it("takes the first letters of the first two words", () => {
    expect(initialsOf("Dana Ruiz")).toBe("DR");
    expect(initialsOf("  mark  ")).toBe("M");
    expect(initialsOf("")).toBe("?");
  });
});

describe("clauseHeading", () => {
  it("adds a period only when the title has no punctuation", () => {
    expect(clauseHeading("Fees")).toBe("Fees.");
    expect(clauseHeading("Fees.")).toBe("Fees.");
    expect(clauseHeading("Term:")).toBe("Term:");
    expect(clauseHeading("   ")).toBe("");
  });
});

describe("partiesLine", () => {
  it("names both sides of a contract", () => {
    expect(partiesLine("contract", "Northpeak", "Harbor Media")).toBe("Northpeak and Harbor Media");
  });
  it("says who a proposal is for", () => {
    expect(partiesLine("proposal", "Northpeak", "Harbor Media")).toBe("Prepared for Harbor Media by Northpeak");
    expect(partiesLine("proposal", "", "Harbor Media")).toBe("Prepared for Harbor Media");
  });
  it("copes with a missing side", () => {
    expect(partiesLine("contract", "Northpeak", " ")).toBe("Northpeak");
  });
});

describe("numberColumnWidth", () => {
  it("is at least 26px and grows with long numbers", () => {
    expect(numberColumnWidth(["1.", "2."])).toBe(26);
    expect(numberColumnWidth(["2.03", "XIV."])).toBeGreaterThan(26);
    expect(numberColumnWidth([])).toBe(26);
  });
});

describe("termProgress and termsBadge", () => {
  it("counts filled and edited terms as in", () => {
    const p = termProgress([term("a", "filled", "x"), term("b", "edited", "y"), term("c", "empty")]);
    expect(p).toMatchObject({ filled: 2, total: 3, complete: false });
    expect(p.missing.map((t) => t.key)).toEqual(["c"]);
  });
  it("is complete only when there is at least one term and none is empty", () => {
    expect(termProgress([]).complete).toBe(false);
    expect(termProgress([term("a", "filled", "x")]).complete).toBe(true);
  });
  it("words the badge", () => {
    expect(termsBadge(3, 9)).toBe("3 terms missing");
    expect(termsBadge(1, 9)).toBe("1 term missing");
    expect(termsBadge(0, 9)).toBe("All 9 terms in");
    expect(termsBadge(0, 1)).toBe("1 term in");
    expect(termsBadge(0, 0)).toBeNull();
  });
});

describe("normalizeEditedValue", () => {
  it("keeps one line without stray spaces", () => {
    expect(normalizeEditedValue("  $3,500 \n per   month ")).toBe("$3,500 per month");
    expect(normalizeEditedValue(" \n ")).toBe("");
  });
});

describe("firstSlots and clauseIndexOf", () => {
  const bodies = ["Intro for {clientName}.", "Pay {fee} by {payment}. Again {fee}.", "No fields."];
  it("finds where each term first appears", () => {
    const slots = firstSlots(bodies);
    expect(slots.get("clientName")).toBe("0:1");
    expect(slots.get("fee")).toBe("1:1");
    expect(slots.get("payment")).toBe("1:3");
    expect(slots.has("missing")).toBe(false);
  });
  it("finds the clause that holds a term", () => {
    expect(clauseIndexOf(bodies, "payment")).toBe(1);
    expect(clauseIndexOf(bodies, "nope")).toBe(-1);
  });
});

describe("speakerLabel", () => {
  it("uses the lead's first name for the client and You for the rep", () => {
    expect(speakerLabel({ speaker: "client", name: null }, "Dana")).toBe("Dana");
    expect(speakerLabel({ speaker: "client", name: null }, null)).toBe("Client");
    expect(speakerLabel({ speaker: "you", name: "Ivan" }, "Dana")).toBe("You");
    expect(speakerLabel({ speaker: "other", name: "Mark" }, "Dana")).toBe("Mark");
    expect(speakerLabel({ speaker: "other", name: null }, "Dana")).toBe("Speaker");
  });
});

describe("splitHighlights", () => {
  const text = "Net 15 by ACH works for us.";
  it("returns the plain text when nothing is highlighted", () => {
    expect(splitHighlights(text, [])).toEqual([{ text, tone: null }]);
    expect(splitHighlights("", [])).toEqual([{ text: "", tone: null }]);
  });
  it("cuts the line into plain and highlighted runs", () => {
    expect(splitHighlights(text, [{ start: 0, end: 18, tone: "green" }])).toEqual([
      { text: "Net 15 by ACH work", tone: "green" },
      { text: "s for us.", tone: null },
    ]);
  });
  it("lets yellow win where ranges overlap and clips to the text", () => {
    const out = splitHighlights(text, [
      { start: 0, end: 10, tone: "green" },
      { start: 4, end: 13, tone: "yellow" },
      { start: 20, end: 400, tone: "green" },
    ]);
    expect(out).toEqual([
      { text: "Net ", tone: null },
      { text: "15 by ACH", tone: "yellow" },
      { text: " works ", tone: null },
      { text: "for us.", tone: "green" },
    ]);
  });
});

describe("looksLikeIsoDate", () => {
  it("tells an ISO date from display text", () => {
    expect(looksLikeIsoDate("2026-11-16T10:00:00.000Z")).toBe(true);
    expect(looksLikeIsoDate("2026-11-16")).toBe(true);
    expect(looksLikeIsoDate("Nov 16, 2026")).toBe(false);
  });
});

describe("transcriptHighlights", () => {
  const lines = [
    { speaker: "you" as const, name: null, text: "For that scope we're at $3,500 a month." },
    { speaker: "client" as const, name: null, text: "$3,500 a month works for us. Could we start on December 1st?" },
  ];
  it("marks heard terms green, the one just heard yellow, and skips typed ones", () => {
    const fee = { ...term("fee", "filled", "$3,500 per month"), sourceQuote: "$3,500 a month works for us." };
    const start = { ...term("start", "filled", "December 1, 2026"), sourceQuote: "Could we start on December 1st?" };
    const typed = { ...term("typed", "edited", "x"), sourceQuote: "For that scope" };
    const out = transcriptHighlights(lines, [fee, start, typed], "start");
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ line: 1, tone: "green" });
    expect(lines[1].text.slice(out[0].start, out[0].end)).toBe("3,500 a month works for us");
    expect(out[1]).toMatchObject({ line: 1, tone: "yellow" });
    expect(lines[1].text.slice(out[1].start, out[1].end)).toBe("Could we start on December 1st");
  });
});

describe("nextToAsk", () => {
  it("picks the first empty term not asked yet, else the first empty one", () => {
    const terms = [term("a", "filled", "x"), term("b", "empty"), term("c", "empty")];
    expect(nextToAsk(terms, new Set())?.key).toBe("b");
    expect(nextToAsk(terms, new Set(["b"]))?.key).toBe("c");
    expect(nextToAsk(terms, new Set(["b", "c"]))?.key).toBe("b");
    expect(nextToAsk([term("a", "filled", "x")], new Set())).toBeNull();
  });
});

describe("commentsByClause", () => {
  const clauses = [{ title: "" }, { title: "Fees" }, { title: "Term" }, { title: "Fees" }];
  const c = (id: string, clauseTitle: string) => ({ id, clauseTitle, comment: `About ${clauseTitle}`, fromName: "Dana" });
  it("puts each comment under the first clause with the title it names, in order", () => {
    const { byClause, loose } = commentsByClause(clauses, [c("a", "Fees"), c("b", "Term"), c("c", "Fees")]);
    expect(byClause.get(1)?.map((x) => x.id)).toEqual(["a", "c"]);
    expect(byClause.get(2)?.map((x) => x.id)).toEqual(["b"]);
    // Not again under the second clause called Fees.
    expect(byClause.has(3)).toBe(false);
    expect(loose).toEqual([]);
  });
  it("keeps a comment whose clause is gone instead of dropping it", () => {
    const { byClause, loose } = commentsByClause(clauses, [c("a", "Payment schedule")]);
    expect(byClause.size).toBe(0);
    expect(loose.map((x) => x.id)).toEqual(["a"]);
  });
});

describe("renewalCountdown", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  it("counts the days left and flags the last 30", () => {
    expect(renewalCountdown("2027-01-15T12:00:00Z", now)).toEqual({ label: "60d left", soon: false });
    expect(renewalCountdown("2026-12-01T12:00:00Z", now)).toEqual({ label: "15d left", soon: true });
  });
  it("says past due once the date went by, and nothing for a bad date", () => {
    expect(renewalCountdown("2026-11-10T12:00:00Z", now)).toEqual({ label: "Past due", soon: true });
    expect(renewalCountdown("not a date", now)).toEqual({ label: "", soon: false });
  });
});
