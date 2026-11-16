import { describe, expect, it } from "vitest";
import { callInProgress, callIsRecent, dealIsLive, dealTranscript, justHeard, templateVersion } from "./deal-live-state";
import { parseTranscript } from "./transcript-lines";
import type { TermField } from "./contract";

const now = new Date("2026-11-16T12:00:00Z");

describe("Whether a deal's call is still live", () => {
  it("is live while the call it was made on records or is being written up", () => {
    for (const phoneCallStatus of ["recording", "processing"]) {
      // A deal from Start a call leaves "processing" after its first reading and has no Call rows.
      expect(dealIsLive({ status: "missing_info", calls: [], phoneCallStatus }, now)).toBe(true);
    }
    for (const phoneCallStatus of ["processed", "failed", "skipped", "discarded", null]) {
      expect(dealIsLive({ status: "ready", calls: [], phoneCallStatus }, now)).toBe(false);
    }
  });

  it("is live while SealMe reads the call", () => {
    expect(dealIsLive({ status: "processing", calls: [], phoneCallStatus: null }, now)).toBe(true);
  });

  it("is live while a recording on the deal is on, and a couple of minutes after it ends", () => {
    expect(dealIsLive({ status: "ready", calls: [{ startedAt: "2026-11-16T10:00:00Z", endedAt: "2026-11-16T11:00:00Z" }, { startedAt: "2026-11-16T11:30:00Z", endedAt: null }], phoneCallStatus: null }, now)).toBe(true);
    expect(dealIsLive({ status: "ready", calls: [{ startedAt: "2026-11-16T11:30:00Z", endedAt: new Date("2026-11-16T11:59:00Z") }], phoneCallStatus: null }, now)).toBe(true);
    expect(dealIsLive({ status: "ready", calls: [{ startedAt: "2026-11-16T11:30:00Z", endedAt: "2026-11-16T11:57:00Z" }], phoneCallStatus: null }, now)).toBe(false);
  });

  it("stops for a recording that never got its end once nothing can add to it anymore", () => {
    // The desktop app quit mid-call: no endedAt, and its upload token ran out 4 hours in.
    expect(dealIsLive({ status: "ready", calls: [{ startedAt: "2026-11-16T07:00:00Z", endedAt: null }], phoneCallStatus: null }, now)).toBe(false);
    expect(dealIsLive({ status: "ready", calls: [{ startedAt: "2026-11-16T08:30:00Z", endedAt: null }], phoneCallStatus: null }, now)).toBe(true);
  });
});

describe("A recording made on the deal", () => {
  it("is in progress until it ends, or until its 4 hours run out", () => {
    expect(callInProgress({ startedAt: "2026-11-16T11:50:00Z", endedAt: null }, now)).toBe(true);
    expect(callInProgress({ startedAt: "2026-11-16T11:50:00Z", endedAt: "2026-11-16T11:59:00Z" }, now)).toBe(false);
    expect(callInProgress({ startedAt: new Date("2026-11-16T07:59:00Z"), endedAt: null }, now)).toBe(false);
  });

  it("is recent while it's on and for a couple of minutes after", () => {
    expect(callIsRecent({ startedAt: "2026-11-16T11:50:00Z", endedAt: null }, now)).toBe(true);
    expect(callIsRecent({ startedAt: "2026-11-16T11:50:00Z", endedAt: "2026-11-16T11:59:00Z" }, now)).toBe(true);
    expect(callIsRecent({ startedAt: "2026-11-16T11:00:00Z", endedAt: "2026-11-16T11:20:00Z" }, now)).toBe(false);
    expect(callIsRecent({ startedAt: "2026-11-15T09:00:00Z", endedAt: null }, now)).toBe(false);
  });
});

describe("The transcript the contract screen shows", () => {
  const phoneCall = { transcript: "Client: We can do four thousand.", startedAt: "2026-11-16T09:00:00Z" };

  it("is the recording that's on while there is one, not the call the deal was made on", () => {
    const calls = [{ transcript: "Client: Let's push the start to April.", startedAt: "2026-11-16T11:50:00Z", endedAt: null }];
    expect(dealTranscript(phoneCall, calls, now)).toBe("Client: Let's push the start to April.");
  });

  it("is every call in the order they happened once none is on", () => {
    const calls = [
      { transcript: "  ", startedAt: "2026-11-16T10:00:00Z", endedAt: "2026-11-16T10:05:00Z" },
      { transcript: "Client: Let's push the start to April.\n", startedAt: "2026-11-16T11:00:00Z", endedAt: "2026-11-16T11:20:00Z" },
    ];
    expect(dealTranscript(phoneCall, calls, now)).toBe("Client: We can do four thousand.\nClient: Let's push the start to April.");
    expect(dealTranscript(null, calls, now)).toBe("Client: Let's push the start to April.");
    expect(dealTranscript(phoneCall, [], now)).toBe("Client: We can do four thousand.");
  });

  it("goes back to every call once a recording that never ended has run out", () => {
    const calls = [{ transcript: "Client: Hello?", startedAt: "2026-11-16T06:00:00Z", endedAt: null }];
    expect(dealTranscript(phoneCall, calls, now)).toBe("Client: Hello?\nClient: We can do four thousand.");
  });
});

describe("The term the call just filled in", () => {
  const field = (fieldKey: string, value: string | null, status = value ? "extracted" : "missing", sourceQuote: string | null = null): TermField => ({ id: fieldKey, fieldKey, label: fieldKey, value, status, sourceQuote });
  const lines = parseTranscript("Client: The budget is about four thousand.\nYou: OK.\nClient: And we can start March first.");

  it("is a term that went from empty to a value, or changed, by the reading", () => {
    expect(justHeard([field("fee", null)], [field("fee", "$4,000")], lines)).toBe("fee");
    expect(justHeard([field("fee", "$3,000")], [field("fee", "$4,000")], lines)).toBe("fee");
  });

  it("is never one the rep typed, and nothing when nothing new was heard", () => {
    expect(justHeard([field("fee", null)], [field("fee", "$4,000", "confirmed")], lines)).toBeNull();
    expect(justHeard([field("fee", "$3,000")], [field("fee", "$4,000", "user_edited")], lines)).toBeNull();
    expect(justHeard([field("fee", "$4,000")], [field("fee", " $4,000 ", "extracted", "a newer quote")], lines)).toBeNull();
    expect(justHeard([field("fee", "$4,000")], [field("fee", null)], lines)).toBeNull();
  });

  it("is nothing on the first load, with nothing to compare with", () => {
    expect(justHeard([], [field("fee", "$4,000")], lines)).toBeNull();
  });

  it("counts a term that's new since the last poll", () => {
    expect(justHeard([field("fee", null)], [field("fee", null), field("seats", "12")], lines)).toBe("seats");
  });

  it("picks the one said last when one reading filled several", () => {
    const prev = [field("fee", null), field("startDate", null), field("service", null)];
    const next = [field("fee", "$4,000", "extracted", "budget is about four thousand"), field("startDate", "March 1", "extracted", "we can start March first"), field("service", "SEO", "extracted", "not in the transcript")];
    expect(justHeard(prev, next, lines)).toBe("startDate");
    // With no quote found for any, the first in order.
    expect(justHeard(prev, next.map((f) => ({ ...f, sourceQuote: null })), lines)).toBe("fee");
  });
});

describe("A template's version", () => {
  const template = { id: "t1", name: "Service Agreement", clauses: '[{"title":"Fees","body":"{fee}"}]' };
  it("stays the same for the same template and text", () => {
    expect(templateVersion(template)).toBe(templateVersion({ ...template }));
    expect(templateVersion(template).startsWith("t1:")).toBe(true);
  });
  it("changes with another template, a new name, or edited clauses", () => {
    const v = templateVersion(template);
    expect(templateVersion({ ...template, id: "t2" })).not.toBe(v);
    expect(templateVersion({ ...template, name: "MSA" })).not.toBe(v);
    expect(templateVersion({ ...template, clauses: '[{"title":"Fees","body":"{fee} a month"}]' })).not.toBe(v);
  });
});
