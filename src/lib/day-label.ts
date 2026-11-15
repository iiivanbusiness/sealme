// "Nov 13", or "Nov 13, 2025" outside this year, on the viewer's calendar.
// Formatted on the server with the viewer's timezone (see cookieTimeZone),
// so the server's own clock (UTC on Vercel) never moves an evening call to
// the next day, and the page reads the same before and after hydration.
export function dayLabel(date: Date, timeZone: string, now = new Date()): string {
  const year = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(d);
  return date.toLocaleDateString("en-US", { timeZone, month: "short", day: "numeric", ...(year(date) === year(now) ? {} : { year: "numeric" }) });
}
