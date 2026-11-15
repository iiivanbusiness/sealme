import { describe, expect, it } from "vitest";
import { docDate, docFailed, docReadiness, ownPointers, setAsideRow, sharingPointerWhere } from "./call-docs";

describe("Which documents belong to which call", () => {
  it("gives a call its old pointer only when no other call that shows shares it", () => {
    const pointer = ownPointers([
      { status: "processed", dealId: "d1" },
      { status: "processed", dealId: "d2" },
      { status: "processing", dealId: "d2" },
      // A skipped call never shows, so it can't take d1 away from the call above.
      { status: "skipped", dealId: "d1" },
    ]);
    expect(pointer({ status: "processed", dealId: "d1" })).toBe("d1");
    expect(pointer({ status: "processed", dealId: "d2" })).toBeNull();
    expect(pointer({ status: "processed", dealId: null })).toBeNull();
  });

  it("lets a set-aside call keep a pointer only no call that shows has, the way Delete call does", () => {
    const pointer = ownPointers([
      { status: "processed", dealId: "d1" },
      { status: "failed", dealId: "d1" },
      { status: "skipped", dealId: "d3" },
    ]);
    // d1 stays under the call with notes, not the failed one.
    expect(pointer({ status: "failed", dealId: "d1" })).toBeNull();
    expect(pointer({ status: "processed", dealId: "d1" })).toBe("d1");
    expect(pointer({ status: "skipped", dealId: "d3" })).toBe("d3");
  });

  it("asks the database the same thing Delete call goes by", () => {
    expect(sharingPointerWhere({ id: "c1", leadId: "l1", dealId: "d1" })).toEqual({
      leadId: "l1",
      dealId: "d1",
      id: { not: "c1" },
      status: { in: ["processed", "processing", "recording"] },
    });
  });

  it("reads a failed automatic document from the call's write-up, whatever shape it's in", () => {
    expect(docFailed({ docFailed: { contract: true } }, "contract")).toBe(true);
    expect(docFailed({ docFailed: { contract: true } }, "proposal")).toBe(false);
    expect(docFailed({ docFailed: { proposal: "yes" } }, "proposal")).toBe(false);
    expect(docFailed({ docFailed: [true] }, "proposal")).toBe(false);
    expect(docFailed({ docFailed: true }, "proposal")).toBe(false);
    expect(docFailed(null, "contract")).toBe(false);
    expect(docFailed("oops", "contract")).toBe(false);
    expect(docFailed([], "contract")).toBe(false);
  });

  it("dates a document by what its status says happened", () => {
    const made = new Date("2026-11-01T10:00:00Z");
    const sent = new Date("2026-11-02T10:00:00Z");
    const viewed = new Date("2026-11-03T10:00:00Z");
    const signed = new Date("2026-11-04T10:00:00Z");
    const contract = (status: string, more: Partial<{ sentAt: Date; viewedAt: Date; signedAt: Date; expiresAt: Date }> = {}) => ({
      status,
      sentAt: null,
      viewedAt: null,
      signedAt: null,
      expiresAt: null,
      ...more,
    });
    expect(docDate({ status: "ready", createdAt: made, contract: null })).toEqual(made);
    expect(docDate({ status: "ready", createdAt: made, contract: contract("draft") })).toEqual(made);
    expect(docDate({ status: "ready", createdAt: made, contract: contract("sent", { sentAt: sent }) })).toEqual(sent);
    expect(docDate({ status: "ready", createdAt: made, contract: contract("sent", { sentAt: sent, viewedAt: viewed }) })).toEqual(viewed);
    expect(docDate({ status: "ready", createdAt: made, contract: contract("signed", { sentAt: sent, viewedAt: viewed, signedAt: signed }) })).toEqual(signed);
    expect(docDate({ status: "ready", createdAt: made, contract: contract("not_signed", { sentAt: sent }) })).toEqual(sent);
    // Still being written: the day it was made, whatever went out before.
    expect(docDate({ status: "processing", createdAt: made, contract: contract("sent", { sentAt: sent }) })).toEqual(made);
  });

  it("lets a proposal go out from the call only when the proposal page would", () => {
    expect(docReadiness({ status: "ready", hasDocument: true, missing: 0 })).toEqual({ ready: true, hint: null });
    expect(docReadiness({ status: "missing_info", hasDocument: false, missing: 2 })).toEqual({ ready: false, hint: "Fill in the missing details first." });
    expect(docReadiness({ status: "ready", hasDocument: true, missing: 1 }).ready).toBe(false);
    expect(docReadiness({ status: "processing", hasDocument: true, missing: 0 })).toEqual({ ready: false, hint: "Ready once SealMe has read the call." });
    expect(docReadiness({ status: "extraction_failed", hasDocument: true, missing: 0 }).ready).toBe(false);
  });

  it("says what happened to a set-aside call, and links to the fix only where the rep can use it", () => {
    const skipLabels = { no_pickup: "They didn't pick up" };
    const call = (status: string, more: Partial<{ transcript: string | null; mode: string; extracted: unknown }> = {}) => ({ status, transcript: "Rep: Hi", mode: "cold", extracted: null, ...more });
    // A call with notes isn't set aside.
    expect(setAsideRow(call("processed"), { onCallsPage: true, skipLabels })).toBeNull();
    expect(setAsideRow(call("processing"), { onCallsPage: true, skipLabels })).toBeNull();

    expect(setAsideRow(call("failed"), { onCallsPage: true, skipLabels })).toEqual({
      label: "Couldn't write this call up",
      chip: "chip-warn",
      reason: null,
      fix: { href: "/calls", label: "Try again in Calls" },
    });
    // Someone else's call isn't on this rep's Calls page.
    expect(setAsideRow(call("failed"), { onCallsPage: false, skipLabels })?.fix).toBeNull();

    expect(setAsideRow(call("skipped", { extracted: { skipped: "no_pickup" } }), { onCallsPage: true, skipLabels })).toEqual({
      label: "Nothing was heard on this call",
      chip: "chip-neutral",
      reason: "They didn't pick up",
      fix: { href: "/calls?tab=history", label: "Process anyway in Calls" },
    });
    // Process anyway needs something to process, in a mode it takes.
    expect(setAsideRow(call("skipped", { transcript: "  " }), { onCallsPage: true, skipLabels })?.fix).toBeNull();
    expect(setAsideRow(call("skipped", { mode: "meeting" }), { onCallsPage: true, skipLabels })?.fix).toBeNull();
    expect(setAsideRow(call("skipped"), { onCallsPage: false, skipLabels })?.fix).toBeNull();
    // A reason SealMe doesn't know, or none, just leaves it out.
    expect(setAsideRow(call("skipped", { extracted: { skipped: "new_reason" } }), { onCallsPage: true, skipLabels })?.reason).toBeNull();
    expect(setAsideRow(call("skipped", { extracted: ["x"] }), { onCallsPage: true, skipLabels })?.reason).toBeNull();
  });
});
