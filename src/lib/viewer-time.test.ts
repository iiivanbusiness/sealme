import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { dayInZone, instantInZone, startOfDayInZone } from "./viewer-time";

describe("viewer time", () => {
  it("knows which calendar day it is in the viewer's zone", () => {
    const lateUtc = new Date("2026-10-04T23:30:00Z");
    expect(dayInZone(lateUtc, "UTC")).toBe("2026-10-04");
    expect(dayInZone(lateUtc, "Europe/Belgrade")).toBe("2026-10-05");
    expect(dayInZone(lateUtc, "America/Los_Angeles")).toBe("2026-10-04");
  });
  it("finds the start of the viewer's day", () => {
    const now = new Date("2026-10-04T12:00:00Z");
    expect(startOfDayInZone(now, "Europe/Belgrade").toISOString()).toBe("2026-10-03T22:00:00.000Z");
    expect(startOfDayInZone(now, "America/New_York").toISOString()).toBe("2026-10-04T04:00:00.000Z");
    expect(startOfDayInZone(now, "UTC").toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
  it("reads a time typed in on the viewer's clock", () => {
    expect(instantInZone("2026-11-14", "14:00", "Europe/Belgrade").toISOString()).toBe("2026-11-14T13:00:00.000Z");
    expect(instantInZone("2026-11-14", "14:00", "America/New_York").toISOString()).toBe("2026-11-14T19:00:00.000Z");
    expect(instantInZone("2026-11-14", "23:30", "America/Los_Angeles").toISOString()).toBe("2026-11-15T07:30:00.000Z");
    expect(instantInZone("2026-11-14", "09:05", "UTC").toISOString()).toBe("2026-11-14T09:05:00.000Z");
  });
  it("gets the day the clocks change right", () => {
    // New York springs forward at 2 AM on March 8, 2026.
    expect(instantInZone("2026-03-08", "01:00", "America/New_York").toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(instantInZone("2026-03-08", "10:00", "America/New_York").toISOString()).toBe("2026-03-08T14:00:00.000Z");
    // Belgrade: forward on March 29, back on October 25.
    expect(instantInZone("2026-03-29", "10:00", "Europe/Belgrade").toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(instantInZone("2026-10-25", "10:00", "Europe/Belgrade").toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });
  it("gives an invalid date for something unreadable", () => {
    expect(Number.isNaN(instantInZone("", "14:00", "UTC").getTime())).toBe(true);
    expect(Number.isNaN(instantInZone("2026-11-14", "", "UTC").getTime())).toBe(true);
  });
});
