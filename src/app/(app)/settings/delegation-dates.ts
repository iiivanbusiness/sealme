// What a date picker's YYYY-MM-DD means as an end date: the last moment of
// that day on the chooser's clock. Read as midnight UTC it would end the
// day before in the Americas, and show as the day before too. Null when
// it isn't a real date.
export function endOfDayInZone(day: string, tz: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const asUtc = new Date(Date.UTC(year, month, date));
  if (asUtc.getUTCMonth() !== month || asUtc.getUTCDate() !== date) return null;

  // The next midnight there: shift by the zone's offset, then once more in
  // case that shift crossed a clock change.
  const nextMidnightAsUtc = Date.UTC(year, month, date + 1);
  let instant = nextMidnightAsUtc;
  for (let i = 0; i < 2; i++) instant = nextMidnightAsUtc - zoneOffset(instant, tz);
  return new Date(instant - 1);
}

// How far the zone's wall clock is ahead of UTC at an instant, in ms.
function zoneOffset(instant: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, Number(p.value)]),
  );
  const wallClockAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallClockAsUtc - Math.floor(instant / 1000) * 1000;
}
