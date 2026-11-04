import { describe, expect, it } from "vitest";
import { endOfDayInZone } from "./delegation-dates";

describe("endOfDayInZone", () => {
  it("ends the chosen day on the chooser's clock", () => {
    expect(endOfDayInZone("2026-11-10", "America/New_York")?.toISOString()).toBe("2026-11-11T04:59:59.999Z");
    expect(endOfDayInZone("2026-11-10", "UTC")?.toISOString()).toBe("2026-11-10T23:59:59.999Z");
    expect(endOfDayInZone("2026-11-10", "Asia/Tokyo")?.toISOString()).toBe("2026-11-10T14:59:59.999Z");
    expect(endOfDayInZone("2026-11-10", "Pacific/Kiritimati")?.toISOString()).toBe("2026-11-10T09:59:59.999Z");
  });
  it("still shows as the chosen day there", () => {
    const end = endOfDayInZone("2026-11-10", "America/Los_Angeles")!;
    expect(end.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" })).toBe("11/10/2026");
  });
  it("handles days next to a clock change", () => {
    expect(endOfDayInZone("2026-03-08", "America/New_York")?.toISOString()).toBe("2026-03-09T03:59:59.999Z");
    expect(endOfDayInZone("2026-03-28", "Europe/Belgrade")?.toISOString()).toBe("2026-03-28T22:59:59.999Z");
    expect(endOfDayInZone("2026-10-24", "Europe/Belgrade")?.toISOString()).toBe("2026-10-24T21:59:59.999Z");
  });
  it("rejects what isn't a real date", () => {
    expect(endOfDayInZone("2026-02-30", "UTC")).toBeNull();
    expect(endOfDayInZone("next friday", "UTC")).toBeNull();
  });
});
