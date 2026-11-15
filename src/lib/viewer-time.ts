import { cookies } from "next/headers";
import { isValidTimeZone } from "@/lib/tasks";

// The browser writes its timezone into this cookie (see TimezoneSync), so
// server-rendered pages like Today know which day it is for the viewer.
export const TZ_COOKIE = "tz";

export async function cookieTimeZone(): Promise<string> {
  const value = (await cookies()).get(TZ_COOKIE)?.value;
  const tz = value ? decodeURIComponent(value) : "";
  return tz && isValidTimeZone(tz) ? tz : "UTC";
}

// The calendar day an instant falls on in a timezone, as YYYY-MM-DD.
export function dayInZone(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

// The instant the viewer's current day started, so "done today" means
// today on their clock rather than in UTC. Uses the current UTC offset, so
// on the day clocks change it can be an hour off; that only shifts which
// tasks count as finished today, and only for that hour.
export function startOfDayInZone(now: Date, tz: string): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  );
  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const offset = wallClockAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - offset);
}

// How far a timezone's clock is from UTC at an instant, in ms.
function zoneOffset(at: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(at))
      .map((p) => [p.type, Number(p.value)]),
  );
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
}

// The instant a time on the viewer's clock stands for: a meeting typed in
// as 2:00 PM on Nov 14 is 2:00 PM where the viewer is, not on the server's
// clock (UTC on Vercel). day is YYYY-MM-DD, time HH:mm. The offset is
// checked again at the answer, so a day the clocks change still comes out
// right. An unreadable day or time gives an invalid Date.
export function instantInZone(day: string, time: string, tz: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  if (Number.isNaN(wall)) return new Date(NaN);
  const guess = wall - zoneOffset(wall, tz);
  return new Date(wall - zoneOffset(guess, tz));
}
