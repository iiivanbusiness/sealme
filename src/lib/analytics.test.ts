import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { ANALYTICS_PERIODS, analyticsPeriod, callBuckets, COUNTED_CALL_STATUSES, daysToSignature, formatDays, median, periodStart } from "./analytics";

const [days30, days90, months12] = ANALYTICS_PERIODS;
const DAY = 24 * 60 * 60 * 1000;

describe("analyticsPeriod", () => {
  it("reads the period from the link and falls back to 30 days", () => {
    expect(analyticsPeriod("90d")).toBe(days90);
    expect(analyticsPeriod("12m")).toBe(months12);
    expect(analyticsPeriod(undefined)).toBe(days30);
    expect(analyticsPeriod("7d")).toBe(days30);
    expect(analyticsPeriod(["90d", "12m"])).toBe(days30);
  });
});

describe("COUNTED_CALL_STATUSES", () => {
  it("counts finished calls, not ones in progress or thrown away", () => {
    expect(COUNTED_CALL_STATUSES).toEqual(["processed", "skipped"]);
  });
});

describe("periodStart", () => {
  // Friday Nov 13 2026, 23:30 in UTC: already Saturday Nov 14 in Belgrade.
  const now = new Date("2026-11-13T23:30:00Z");

  it("starts at the viewer's midnight, today included", () => {
    expect(periodStart(days30, "Europe/Belgrade", now).toISOString()).toBe("2026-10-15T22:00:00.000Z"); // Oct 16, 00:00 summer time
    expect(periodStart(days30, "UTC", now).toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(periodStart(days90, "America/New_York", now).toISOString()).toBe("2026-08-16T04:00:00.000Z");
  });

  it("starts 12 months on the 1st of the month", () => {
    expect(periodStart(months12, "Europe/Belgrade", now).toISOString()).toBe("2025-11-30T23:00:00.000Z"); // Dec 1 2025, 00:00 CET
  });

  it("lands on the right day far from UTC", () => {
    expect(periodStart(days30, "Pacific/Auckland", now).toISOString()).toBe("2026-10-15T11:00:00.000Z"); // Oct 16, 00:00 NZDT
    expect(periodStart(days30, "Pacific/Honolulu", now).toISOString()).toBe("2026-10-15T10:00:00.000Z"); // Oct 15, 00:00 HST
  });

  it("starts at midnight on a day the clocks change", () => {
    // Clocks go forward at 2:00 on Mar 8 2026 in New York: midnight is still standard time.
    expect(periodStart(days30, "America/New_York", new Date("2026-04-06T15:00:00Z")).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    // And back at 2:00 on Nov 1 2026: midnight is still summer time.
    expect(periodStart(days30, "America/New_York", new Date("2026-11-30T15:00:00Z")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });
});

describe("callBuckets", () => {
  const now = new Date("2026-11-14T15:00:00Z"); // a Saturday
  // The bucket a call is counted in, as the page's range counts do it.
  const bucketOf = (buckets: ReturnType<typeof callBuckets>, at: Date) => buckets.find((b) => at >= b.start && (!b.end || at < b.end))?.label;

  it("has a bucket per week, weeks starting Monday, cut to the period", () => {
    const buckets = callBuckets(days30, "UTC", now);
    expect(buckets.map((b) => b.label)).toEqual(["Oct 16 - 18", "Oct 19 - 25", "Oct 26 - Nov 1", "Nov 2 - 8", "Nov 9 - 14"]);
    expect(buckets[0].start).toEqual(periodStart(days30, "UTC", now));
    expect(buckets[1].start.toISOString()).toBe("2026-10-19T00:00:00.000Z");
    expect(bucketOf(buckets, new Date("2026-10-16T10:00:00Z"))).toBe("Oct 16 - 18"); // first day of the period
    expect(bucketOf(buckets, new Date("2026-10-25T22:00:00Z"))).toBe("Oct 19 - 25"); // Sunday night: still the second week in UTC
    expect(bucketOf(buckets, new Date("2026-11-14T08:00:00Z"))).toBe("Nov 9 - 14"); // today
    expect(bucketOf(buckets, new Date("2026-10-15T23:00:00Z"))).toBeUndefined(); // the day before the period
  });

  it("leaves no gap between buckets, and no end on the last", () => {
    const buckets = callBuckets(days90, "Europe/Belgrade", now);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i].start).toEqual(buckets[i - 1].end);
    expect(buckets[buckets.length - 1].end).toBeNull();
    // A call stamped a little ahead of the server's clock still counts.
    expect(bucketOf(buckets, new Date(now.getTime() + 60_000))).toBe("Nov 9 - 14");
  });

  it("puts a call in the week it was on the viewer's clock", () => {
    // Sunday 23:30 in New York is already Monday in UTC.
    const call = new Date("2026-10-26T03:30:00Z");
    expect(bucketOf(callBuckets(days30, "America/New_York", now), call)).toBe("Oct 19 - 25");
    expect(bucketOf(callBuckets(days30, "UTC", now), call)).toBe("Oct 26 - Nov 1");
  });

  it("has a bucket per month for 12 months, oldest first", () => {
    const buckets = callBuckets(months12, "UTC", now);
    expect(buckets).toHaveLength(12);
    expect(buckets[0].label).toBe("Dec 2025");
    expect(buckets[6].label).toBe("Jun 2026");
    expect(buckets[11].label).toBe("Nov 2026");
    expect(bucketOf(buckets, new Date("2025-12-01T00:30:00Z"))).toBe("Dec 2025");
    expect(bucketOf(buckets, new Date("2026-06-15T12:00:00Z"))).toBe("Jun 2026");
  });

  it("starts a month at midnight when the clocks change that day", () => {
    // Nov 1 2026 in New York: clocks go back at 2:00, so midnight is 04:00 UTC.
    const buckets = callBuckets(months12, "America/New_York", new Date("2026-11-15T12:00:00Z"));
    const nov = buckets[buckets.length - 1];
    expect(nov.label).toBe("Nov 2026");
    expect(nov.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(bucketOf(buckets, new Date("2026-11-01T04:30:00Z"))).toBe("Nov 2026"); // 00:30 on Nov 1
    expect(bucketOf(buckets, new Date("2026-11-01T03:30:00Z"))).toBe("Oct 2026"); // 23:30 on Oct 31
    // Mar 8 2026 is the spring change, inside "Mar 2026", which starts at 05:00 UTC (EST).
    expect(buckets.find((b) => b.label === "Mar 2026")?.start.toISOString()).toBe("2026-03-01T05:00:00.000Z");
    expect(buckets.find((b) => b.label === "Apr 2026")?.start.toISOString()).toBe("2026-04-01T04:00:00.000Z");
  });

  it("has every week of 90 days", () => {
    const buckets = callBuckets(days90, "UTC", now);
    expect(buckets.length).toBe(13);
    expect(buckets[0].label).toBe("Aug 17 - 23");
    expect(buckets[buckets.length - 1].label).toBe("Nov 9 - 14");
  });
});

describe("daysToSignature", () => {
  const signedAt = new Date("2026-11-10T12:00:00Z");

  it("counts from the first call", () => {
    expect(daysToSignature([{ signedAt, firstCallAt: new Date(signedAt.getTime() - 12 * DAY), leadCreatedAt: new Date(signedAt.getTime() - 40 * DAY) }])).toEqual([12]);
  });

  it("falls back to when the lead was added", () => {
    expect(daysToSignature([{ signedAt, firstCallAt: null, leadCreatedAt: new Date(signedAt.getTime() - 3 * DAY) }])).toEqual([3]);
  });

  it("leaves out what it can't measure", () => {
    expect(
      daysToSignature([
        { signedAt, firstCallAt: null, leadCreatedAt: null },
        { signedAt, firstCallAt: new Date(signedAt.getTime() + DAY) }, // signed before the first call
        { signedAt: null, firstCallAt: new Date(signedAt.getTime() - DAY) },
      ]),
    ).toEqual([]);
  });
});

describe("median", () => {
  it("takes the middle value", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([30, 2, 4])).toBe(4);
    expect(median([1, 2, 4, 100])).toBe(3);
  });
});

describe("formatDays", () => {
  it("keeps a decimal only for short spans", () => {
    expect(formatDays(0.44)).toBe("0.4");
    expect(formatDays(3)).toBe("3");
    expect(formatDays(3.46)).toBe("3.5");
    expect(formatDays(12.6)).toBe("13");
  });
});
