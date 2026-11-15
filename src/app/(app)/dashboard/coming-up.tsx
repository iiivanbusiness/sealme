import Link from "next/link";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { syncCalendarIfDue } from "@/lib/google-calendar";
import { leadAccess } from "@/lib/lead-visibility";
import { dayInZone, startOfDayInZone } from "@/lib/viewer-time";
import { clockIn } from "@/lib/todo";
import { meetingPeople, startCallFor, type MeetingPerson } from "@/lib/meeting-person";
import { CALL_MINUTES, minutesOf, sameName } from "@/lib/meetings-ahead";
import StartCallLink from "@/components/StartCallLink";

// How many of today's meetings the Dashboard lists; the rest are a link to
// the Calendar. Sales calls are never cut (see below).
const SHOWN = 8;

// Coming up on the Dashboard: today's meetings on the workspace calendar
// that haven't ended (one Google account feeds the whole workspace, so
// everyone sees them), plus the viewer's own sales calls set for today.
// A meeting that's also one of those calls shows once, as the meeting (it
// has the link to join), with the call's lead if the calendar didn't name
// one. Each has Start call, opened on who it's with. Opening the Dashboard
// also asks Google for anything new, at most every 10 minutes.
export default async function ComingUp({ workspaceId, userId, tz }: { workspaceId: string; userId: string; tz: string }) {
  after(() => syncCalendarIfDue(workspaceId));
  const now = new Date();
  const today = dayInZone(now, tz);
  const dayStart = startOfDayInZone(now, tz);
  // 36 hours on, then back to that day's start: right on a day the clocks change.
  const dayEnd = startOfDayInZone(new Date(dayStart.getTime() + 36 * 60 * 60 * 1000), tz);
  const [events, calls, access] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { workspaceId, startTime: { gte: dayStart, lt: dayEnd } },
      select: { id: true, title: true, clientName: true, attendeeEmail: true, startTime: true, durationMinutes: true, meetingUrl: true },
      orderBy: { startTime: "asc" },
      take: 50,
    }),
    prisma.task.findMany({
      where: { workspaceId, assigneeId: userId, status: "open", type: "sales_call", dueDate: new Date(`${today}T00:00:00Z`) },
      select: { id: true, dueTime: true, note: true, lead: { select: { id: true, name: true, company: true, email: true, isClient: true } } },
      orderBy: { dueTime: "asc" },
      take: 50,
    }),
    leadAccess(),
  ]);
  const people = await meetingPeople(workspaceId, access.where, events);
  const nowMinutes = minutesOf(clockIn(now, tz));

  type Row = { key: string; title: string; time: string | null; running: boolean; person: MeetingPerson | undefined; meetingUrl: string | null };
  const rows: Row[] = [];
  const claimed = new Set<string>();
  for (const e of events) {
    const time = clockIn(e.startTime, tz);
    let person = people.get(e.id);
    // The same call as a to-do: same time, and the same lead or the name
    // the calendar gives, in any case, as meeting-person.ts matches names.
    const call = calls.find((t) => t.lead && t.dueTime === time && !claimed.has(t.id) && (person?.lead?.id === t.lead.id || sameName(e.clientName, t.lead.name)));
    if (call?.lead) {
      claimed.add(call.id);
      if (!person?.lead) person = { lead: call.lead, name: person?.name ?? null, email: person?.email ?? null };
    }
    // Over: gone from the list (its to-do too, claimed above).
    if (e.startTime.getTime() + e.durationMinutes * 60_000 <= now.getTime()) continue;
    rows.push({ key: `e-${e.id}`, title: e.title, time, running: e.startTime <= now, person, meetingUrl: e.meetingUrl });
  }
  for (const t of calls) {
    if (claimed.has(t.id)) continue;
    // Gone once it's surely over, like a meeting; one with no time stays all day.
    if (t.dueTime && minutesOf(t.dueTime) + CALL_MINUTES <= nowMinutes) continue;
    rows.push({
      key: `t-${t.id}`,
      title: t.note?.trim() || "Sales call",
      time: t.dueTime,
      running: Boolean(t.dueTime && minutesOf(t.dueTime) <= nowMinutes),
      person: t.lead ? { lead: t.lead, name: null, email: null } : undefined,
      meetingUrl: null,
    });
  }
  // By the clock, then the sales calls with no time. Only meetings past the
  // first SHOWN rows are cut: the "+N more" link opens the Calendar, which
  // only has meetings, so a call cut there would be nowhere to see.
  const timed = rows.filter((r) => r.time).sort((a, b) => a.time!.localeCompare(b.time!));
  const cut = timed.filter((r, i) => i >= SHOWN && r.key.startsWith("e-"));
  const shown = [...timed.filter((r) => !cut.includes(r)), ...rows.filter((r) => !r.time)];
  const more = cut.length;

  return (
    <section className="glass-card glass-card-solid flex min-w-0 flex-col overflow-hidden" aria-labelledby="coming-up-title">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 pb-3 pt-4 sm:px-5">
        <h2 id="coming-up-title" className="text-[15px] font-medium">Coming up</h2>
        {/* The Calendar is computer-only (phone-app.ts): the iPhone app has no link to it. */}
        <Link href="/calendar" className="not-on-phone-app text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
          Calendar
        </Link>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-4 text-[13px] sm:px-5" style={{ color: "var(--ink-muted)" }}>
          No meetings today.
          <Link href="/calendar/new" className="not-on-phone-app font-medium" style={{ color: "var(--accent-blue)" }}>
            Add a meeting
          </Link>
        </div>
      ) : (
        <>
          {shown.map((r) => (
            <MeetingRow key={r.key} title={r.title} time={r.time} running={r.running} person={r.person} meetingUrl={r.meetingUrl} />
          ))}
          {more > 0 && (
            <Link href="/calendar" className="not-on-phone-app row-hover px-4 py-3 text-[12.5px] font-medium sm:px-5" style={{ borderTop: "1px solid var(--hairline-soft)", color: "var(--accent-blue)" }}>
              +{more} more today
            </Link>
          )}
        </>
      )}
    </section>
  );
}

// One meeting: when (or Now while it runs), what, who it's with (their lead
// when SealMe knows them), then Join and Start call. Also the Calendar's row.
//   detail  more after who it's with, like the length
//   over    it has ended: faded, and nothing to join
//   remove  for a meeting added by hand
export function MeetingRow({
  title,
  time,
  running,
  over = false,
  person,
  detail,
  meetingUrl,
  remove,
}: {
  title: string;
  time: string | null;
  running: boolean;
  over?: boolean;
  person: MeetingPerson | undefined;
  detail?: string | null;
  meetingUrl: string | null;
  remove?: (() => Promise<void>) | null;
}) {
  const lead = person?.lead;
  const other = person?.name ?? person?.email ?? null;
  const extra = [lead?.company, detail].filter(Boolean).join(" · ");
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-t px-4 py-3.5 first:border-t-0 sm:px-5" style={{ borderColor: "var(--hairline-soft)" }}>
      <div className="flex min-w-0 flex-1 basis-[240px] items-center gap-3.5" style={over ? { opacity: 0.6 } : undefined}>
        <div
          className={`font-mono-tab flex w-[58px] flex-none justify-center rounded-[10px] px-2 py-1.5 text-[12.5px] font-medium${running ? " chip-success" : ""}`}
          style={running ? undefined : { background: "var(--surface-2)" }}
        >
          {running ? "Now" : (time ?? "Today")}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[14px] font-medium" title={title}>{title}</div>
          {(lead || other || extra) && (
            <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
              {lead ? (
                <>
                  <Link href={`/leads/${lead.id}`} className="truncate font-medium" style={{ color: "var(--accent-blue)" }}>{lead.name}</Link>
                  {lead.isClient && <span className="chip chip-success flex-none text-[11px]">Client</span>}
                </>
              ) : (
                other && <span className="truncate">{other}</span>
              )}
              {extra && <span className="min-w-0 truncate">{lead || other ? `· ${extra}` : extra}</span>}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-none flex-wrap items-center gap-2">
        {meetingUrl && !over && (
          <a href={meetingUrl} target="_blank" rel="noopener noreferrer" className="btn btn-secondary btn-sm">
            Join
          </a>
        )}
        <StartCallLink {...startCallFor(person)} className="btn btn-primary btn-sm">
          Start call
        </StartCallLink>
        {remove && (
          <form action={remove}>
            <button type="submit" className="px-1 text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>
              Remove
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
