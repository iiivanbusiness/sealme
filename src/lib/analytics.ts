import { dayInZone, instantInZone } from "@/lib/viewer-time";

const DAY = 24 * 60 * 60 * 1000;

// What counts as a call in the numbers: one that got written up, or closed
// out on its own (no answer, too short, nothing heard). Not one still
// recording or being written up, and not one the rep threw away. The
// Dashboard's call count uses the same list, so the two never disagree.
export const COUNTED_CALL_STATUSES: string[] = ["processed", "skipped"];

// The periods Analytics can show, picked with ?period=. Whole days (or whole
// months) on the viewer's calendar, today included.
export type AnalyticsPeriod = { key: "30d" | "90d" | "12m"; label: string; unit: "day" | "month"; count: number };

export const ANALYTICS_PERIODS: AnalyticsPeriod[] = [
  { key: "30d", label: "Last 30 days", unit: "day", count: 30 },
  { key: "90d", label: "Last 90 days", unit: "day", count: 90 },
  { key: "12m", label: "Last 12 months", unit: "month", count: 12 },
];

// Anything that isn't a known period (a typo, an old link) shows 30 days.
export function analyticsPeriod(raw: string | string[] | undefined): AnalyticsPeriod {
  return ANALYTICS_PERIODS.find((p) => p.key === raw) ?? ANALYTICS_PERIODS[0];
}

// Calendar days as YYYY-MM-DD, moved without caring about time zones.
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const shiftMonth = (month: string, months: number) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, 1)).toISOString().slice(0, 7);
};
const mondayOf = (day: string) => shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

// The instant a calendar day starts where the viewer is. The offset is the
// one in force at that midnight, so a day the clocks change (or a day far
// from today across a change) still starts at 00:00 and not an hour off.
const midnightInZone = (day: string, tz: string): Date => instantInZone(day, "00:00", tz);

function firstDayOf(period: AnalyticsPeriod, today: string): string {
  return period.unit === "month" ? `${shiftMonth(today.slice(0, 7), -(period.count - 1))}-01` : shiftDay(today, -(period.count - 1));
}

// When the period starts: midnight, on the viewer's clock, 29 days ago for
// "Last 30 days", or on the 1st of the month 11 months ago for "Last 12
// months", so the first week or month on the chart isn't cut at some hour.
export function periodStart(period: AnalyticsPeriod, tz: string, now = new Date()): Date {
  return midnightInZone(firstDayOf(period, dayInZone(now, tz)), tz);
}

const shortDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// "Oct 16 - 19", "Oct 27 - Nov 2", or one day on its own.
function weekLabel(from: string, to: string): string {
  if (from === to) return shortDay(from);
  return from.slice(0, 7) === to.slice(0, 7) ? `${shortDay(from)} - ${Number(to.slice(8))}` : `${shortDay(from)} - ${shortDay(to)}`;
}

const monthLabel = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

// The weeks (starting on Monday) for the day periods, the months for the
// 12 months, oldest first, each with the instants it covers, so the calls
// in each can be counted in the database. The first week is cut to where
// the period starts and the last one ends today, and the labels say so.
// The last one has no end, so a call stamped a bit ahead still counts.
export function callBuckets(period: AnalyticsPeriod, tz: string, now = new Date()): { label: string; start: Date; end: Date | null }[] {
  const today = dayInZone(now, tz);
  const first = firstDayOf(period, today);
  const days: string[] = [];
  if (period.unit === "month") {
    for (let m = first.slice(0, 7); m <= today.slice(0, 7); m = shiftMonth(m, 1)) days.push(`${m}-01`);
  } else {
    for (let d = first; d <= today; d = shiftDay(mondayOf(d), 7)) days.push(d);
  }

  const starts = days.map((d) => midnightInZone(d, tz));
  return days.map((d, i) => ({
    label: period.unit === "month" ? monthLabel(d) : weekLabel(d, i + 1 < days.length ? shiftDay(days[i + 1], -1) : today),
    start: starts[i],
    end: starts[i + 1] ?? null,
  }));
}

// Days from the first call with a lead to the client's signature, one per
// contract. Without a call on record it counts from when the lead was
// added. Contracts with neither, or signed before that start (merged or
// imported leads), are left out rather than guessed.
export function daysToSignature(rows: { signedAt: Date | null; firstCallAt: Date | null; leadCreatedAt?: Date | null }[]): number[] {
  const days: number[] = [];
  for (const row of rows) {
    const start = row.firstCallAt ?? row.leadCreatedAt ?? null;
    if (!start || !row.signedAt) continue;
    const span = (row.signedAt.getTime() - start.getTime()) / DAY;
    if (span >= 0) days.push(span);
  }
  return days;
}

// The middle value: one very slow deal doesn't drag it the way it drags
// an average, which matters with only a handful of contracts.
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// "0.4", "3.5", "12": a decimal only while it still means something.
export function formatDays(days: number): string {
  return days < 10 ? String(Math.round(days * 10) / 10) : String(Math.round(days));
}
