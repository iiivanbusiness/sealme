import { describe, expect, it } from "vitest";
import { dropMicEcho, type TranscriptWord } from "./deepgram";

const client = (text: string, start: number): TranscriptWord => ({ text, start, speaker: "Client" });
const you = (text: string, start: number): TranscriptWord => ({ text, start, speaker: "You" });

describe("dropMicEcho", () => {
  it("drops the client's words coming back through the mic", () => {
    const words = [client("We", 10), you("we", 10.04), client("can", 10.3), you("can", 10.35), client("start", 10.6), client("Monday.", 10.9), you("Monday", 10.95)];
    expect(dropMicEcho(words)).toEqual([client("We", 10), client("can", 10.3), client("start", 10.6), client("Monday.", 10.9)]);
  });

  it("keeps what the rep says at another time", () => {
    const words = [client("Can", 4), client("we", 4.2), client("start", 4.4), client("Monday?", 4.6), you("Yes,", 6), you("we", 6.3), you("can", 6.5), you("start", 6.7), you("Monday.", 7)];
    expect(dropMicEcho(words)).toEqual(words);
  });

  it("keeps a word the rep repeats well after the client said it", () => {
    const words = [client("Five", 20), client("thousand", 20.3), you("Five", 22), you("thousand", 22.3), you("works.", 22.6)];
    expect(dropMicEcho(words)).toEqual(words);
  });

  it("keeps the rep's word when it starts before the client's", () => {
    const words = [you("okay", 3), client("Okay.", 3.2)];
    expect(dropMicEcho(words)).toEqual(words);
  });
});
