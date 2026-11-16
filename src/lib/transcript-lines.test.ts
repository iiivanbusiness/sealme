import { describe, expect, it } from "vitest";
import { findQuote, parseTranscript, type TranscriptLine } from "./transcript-lines";

describe("Reading a call transcript", () => {
  it("splits it into turns by speaker, skipping the leading newline and blank lines", () => {
    expect(parseTranscript("\nClient: Hi there.\n\nYou: Hello!\n")).toEqual([
      { speaker: "client", name: null, text: "Hi there." },
      { speaker: "you", name: null, text: "Hello!" },
    ]);
  });

  it("joins a turn cut in two where one chunk ended and the next began", () => {
    expect(parseTranscript("\nClient: We can start\nClient: in March.\nYou: Great.\nYou: Thanks.")).toEqual([
      { speaker: "client", name: null, text: "We can start in March." },
      { speaker: "you", name: null, text: "Great. Thanks." },
    ]);
  });

  it("keeps other speakers by name, and a sentence with a colon as words", () => {
    expect(parseTranscript("Speaker 2: Hello\nPriya Shah: Hi\nPriya Shah: again\nSo the price: four thousand")).toEqual([
      { speaker: "other", name: "Speaker 2", text: "Hello" },
      { speaker: "other", name: "Priya Shah", text: "Hi again So the price: four thousand" },
    ]);
  });

  it("reads a line with no speaker on its own, and nothing from nothing", () => {
    expect(parseTranscript("just words")).toEqual([{ speaker: "other", name: null, text: "just words" }]);
    expect(parseTranscript(null)).toEqual([]);
    expect(parseTranscript(undefined)).toEqual([]);
    expect(parseTranscript("\n\nClient: \nYou:")).toEqual([]);
  });

  it("keeps a colon inside a turn", () => {
    expect(parseTranscript("Client: Time: 10am works")).toEqual([{ speaker: "client", name: null, text: "Time: 10am works" }]);
  });
});

describe("Finding a term's quote", () => {
  const lines: TranscriptLine[] = parseTranscript(
    [
      "Client: We'd want to start on March 1st, if that works.",
      "You: Sure. And the budget?",
      "Client: About $4,000 a month \u2014 net-30 payment is fine.",
      "You: Got it, so four thousand.",
      "Client: Yes. Actually, we’d want to start on March 1st for sure.",
    ].join("\n"),
  );

  it("finds the latest line with it and the characters it covers", () => {
    const at = findQuote(lines, "we'd want to start on March 1st");
    expect(at).toEqual({ line: 4, start: lines[4].text.indexOf("we’d"), end: lines[4].text.indexOf(" for sure") });
    expect(lines[4].text.slice(at!.start, at!.end)).toBe("we’d want to start on March 1st");
  });

  it("ignores case, spacing, punctuation and quote marks", () => {
    const at = findQuote(lines, '"about 4000 a month,  net 30 payment"');
    expect(at?.line).toBe(2);
    expect(lines[2].text.slice(at!.start, at!.end)).toBe("About $4,000 a month \u2014 net-30 payment");
  });

  it("reads past a speaker the model put in front, and finds a piece of a quote that joined two turns", () => {
    expect(findQuote(lines, "Client: About $4,000 a month")?.line).toBe(2);
    const joined = findQuote(lines, "You: Sure. And the budget? Client: About $4,000 a month");
    expect(joined?.line).toBe(2);
    expect(lines[2].text.slice(joined!.start, joined!.end)).toBe("About $4,000 a month");
  });

  it("matches whole words only", () => {
    expect(findQuote(parseTranscript("Client: fourteen days"), "four")).toBeNull();
    expect(findQuote(parseTranscript("Client: fourteen days"), "fourteen")).toEqual({ line: 0, start: 0, end: 8 });
  });

  it("finds nothing for a quote that isn't there, is too short, or is empty", () => {
    expect(findQuote(lines, "we'll pay in euros")).toBeNull();
    expect(findQuote(lines, "Yes")).toBeNull();
    expect(findQuote(lines, "  ...  ")).toBeNull();
    expect(findQuote(lines, null)).toBeNull();
    expect(findQuote([], "about four thousand")).toBeNull();
  });
});
