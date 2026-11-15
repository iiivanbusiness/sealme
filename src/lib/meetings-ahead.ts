import { dayInZone } from "@/lib/viewer-time";
import { clockIn } from "@/lib/todo";

// A sales call to-do has a time but no length: it counts as running for
// this long, like a meeting added without one.
export const CALL_MINUTES = 30;

export const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

// Names compared the way meeting-person.ts matches a meeting to a lead:
// trimmed, in any case. "dana lee" on the calendar is the lead Dana Lee.
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

type Meeting = { id: string; clientName: string | null; attendeeEmail?: string | null; startTime: Date; durationMinutes: number };
type CallTodo = { id: string; dueDate: Date; dueTime: string | null; lead: { name: string; email?: string | null } | null };

// A calendar meeting that's also a sales call to-do: the same day and time
// on the viewer's clock, and the lead's name or email (compared the same
// way) being the one the calendar gives. Coming up finds the lead by the
// email first too, so the two count a meeting the same.
export function isSameCall(e: Pick<Meeting, "clientName" | "attendeeEmail" | "startTime">, t: Omit<CallTodo, "id">, tz: string): boolean {
  if (!t.lead || (!sameName(e.clientName, t.lead.name) && !sameName(e.attendeeEmail, t.lead.email))) return false;
  return t.dueDate.toISOString().slice(0, 10) === dayInZone(e.startTime, tz) && t.dueTime === clockIn(e.startTime, tz);
}

const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

// How many meetings are still ahead in the next `days` days, today
// included, on the viewer's clock: the calendar's meetings that haven't
// ended and the sales call to-dos (open ones) that aren't surely over. A
// meeting that's also one of the to-dos counts once, the way Coming up
// shows it once.
export function meetingsAhead(o: { events: Meeting[]; calls: CallTodo[]; now: Date; tz: string; days: number }): number {
  const today = dayInZone(o.now, o.tz);
  const end = shiftDay(today, o.days);
  const nowMinutes = minutesOf(clockIn(o.now, o.tz));
  const inWindow = (day: string) => day >= today && day < end;
  const claimed = new Set<string>();
  let count = 0;
  for (const e of o.events) {
    if (!inWindow(dayInZone(e.startTime, o.tz))) continue;
    const call = o.calls.find((t) => !claimed.has(t.id) && isSameCall(e, t, o.tz));
    if (call) claimed.add(call.id);
    if (e.startTime.getTime() + e.durationMinutes * 60_000 > o.now.getTime()) count++;
  }
  for (const t of o.calls) {
    const day = t.dueDate.toISOString().slice(0, 10);
    if (claimed.has(t.id) || !inWindow(day)) continue;
    // One with no time stays all day, like in Coming up.
    if (day === today && t.dueTime && minutesOf(t.dueTime) + CALL_MINUTES <= nowMinutes) continue;
    count++;
  }
  return count;
}
