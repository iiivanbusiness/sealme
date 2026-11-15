import { describe, expect, it } from "vitest";
import { isSameCall, meetingsAhead, sameName } from "./meetings-ahead";

// Saturday Nov 14, 2026, 15:00 UTC.
const now = new Date("2026-11-14T15:00:00Z");
const tz = "UTC";
const meeting = (o: Partial<{ id: string; clientName: string | null; attendeeEmail: string | null; startTime: Date; durationMinutes: number }> = {}) => ({
  id: "e1",
  clientName: null,
  attendeeEmail: null,
  startTime: new Date("2026-11-16T10:00:00Z"),
  durationMinutes: 30,
  ...o,
});
const call = (o: Partial<{ id: string; dueDate: Date; dueTime: string | null; lead: { name: string; email?: string | null } | null }> = {}) => ({
  id: "t1",
  dueDate: new Date("2026-11-16T00:00:00Z"),
  dueTime: "10:00" as string | null,
  lead: { name: "Dana Lee", email: "dana@northgate.io" } as { name: string; email?: string | null } | null,
  ...o,
});

describe("sameName", () => {
  it("compares trimmed, in any case, and never matches nothing", () => {
    expect(sameName("  dana LEE ", "Dana Lee")).toBe(true);
    expect(sameName("Dana", "Dana Lee")).toBe(false);
    expect(sameName(null, null)).toBe(false);
    expect(sameName("", "")).toBe(false);
  });
});

describe("isSameCall", () => {
  it("is the same call at the same time with the lead's name", () => {
    expect(isSameCall(meeting({ clientName: "dana lee" }), call(), tz)).toBe(true);
  });

  it("is the same call when the attendee's email is the lead's, whatever the name says", () => {
    expect(isSameCall(meeting({ clientName: "Dana", attendeeEmail: "DANA@northgate.io" }), call(), tz)).toBe(true);
  });

  it("isn't at another time, on another day, or with someone else", () => {
    expect(isSameCall(meeting({ clientName: "Dana Lee" }), call({ dueTime: "11:00" }), tz)).toBe(false);
    expect(isSameCall(meeting({ clientName: "Dana Lee" }), call({ dueDate: new Date("2026-11-17T00:00:00Z") }), tz)).toBe(false);
    expect(isSameCall(meeting({ clientName: "Sam Ortiz", attendeeEmail: "sam@x.com" }), call(), tz)).toBe(false);
    expect(isSameCall(meeting({ clientName: "Dana Lee" }), call({ lead: null }), tz)).toBe(false);
  });

  it("reads the meeting's day and time on the viewer's clock", () => {
    // 23:30 in New York on the 15th is 04:30 UTC on the 16th.
    const late = meeting({ clientName: "Dana Lee", startTime: new Date("2026-11-16T04:30:00Z") });
    expect(isSameCall(late, call({ dueDate: new Date("2026-11-15T00:00:00Z"), dueTime: "23:30" }), "America/New_York")).toBe(true);
  });
});

describe("meetingsAhead", () => {
  it("counts the calendar's meetings and the sales calls, a meeting that's also a call once", () => {
    const events = [meeting({ id: "same", clientName: "Dana Lee" }), meeting({ id: "other", clientName: "Kim Park", startTime: new Date("2026-11-18T09:00:00Z") })];
    const calls = [call({ id: "same" }), call({ id: "own", lead: { name: "Sam Ortiz" }, dueDate: new Date("2026-11-19T00:00:00Z"), dueTime: null })];
    expect(meetingsAhead({ events, calls, now, tz, days: 7 })).toBe(3);
  });

  it("covers the next 7 days, today included, even on a Saturday", () => {
    const events = [
      meeting({ id: "today", startTime: new Date("2026-11-14T17:00:00Z") }),
      meeting({ id: "friday", startTime: new Date("2026-11-20T09:00:00Z") }),
      meeting({ id: "too-far", startTime: new Date("2026-11-21T09:00:00Z") }),
    ];
    expect(meetingsAhead({ events, calls: [], now, tz, days: 7 })).toBe(2);
  });

  it("leaves out what's already over today, but keeps a call with no time all day", () => {
    const events = [meeting({ id: "done", startTime: new Date("2026-11-14T13:00:00Z") }), meeting({ id: "running", startTime: new Date("2026-11-14T14:45:00Z") })];
    const calls = [
      call({ id: "past", dueDate: new Date("2026-11-14T00:00:00Z"), dueTime: "09:00", lead: { name: "Old" } }),
      call({ id: "any", dueDate: new Date("2026-11-14T00:00:00Z"), dueTime: null, lead: { name: "Any" } }),
      call({ id: "late", dueDate: new Date("2026-11-12T00:00:00Z"), dueTime: null, lead: { name: "Late" } }),
    ];
    expect(meetingsAhead({ events, calls, now, tz, days: 7 })).toBe(2);
  });

  it("doesn't count a past meeting's sales call on its own", () => {
    const events = [meeting({ id: "done", clientName: "Dana Lee", startTime: new Date("2026-11-14T13:00:00Z") })];
    const calls = [call({ id: "done", dueDate: new Date("2026-11-14T00:00:00Z"), dueTime: "13:00" })];
    expect(meetingsAhead({ events, calls, now, tz, days: 7 })).toBe(0);
  });
});
