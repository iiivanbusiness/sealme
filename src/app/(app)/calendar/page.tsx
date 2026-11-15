import Link from "next/link";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { isGoogleCalendarConfigured, syncCalendarIfDue } from "@/lib/google-calendar";
import { requireWorkspace } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { leadAccess } from "@/lib/lead-visibility";
import { cookieTimeZone, dayInZone, startOfDayInZone } from "@/lib/viewer-time";
import { clockIn } from "@/lib/todo";
import { meetingPeople } from "@/lib/meeting-person";
import { deleteEvent, disconnectGoogleCalendar, syncGoogleCalendarNow } from "./actions";
import ExternalConnectLink from "@/components/ExternalConnectLink";
import { MeetingRow } from "@/app/(app)/dashboard/coming-up";

const ERROR_MESSAGE: Record<string, string> = {
  google_not_configured: "Google Calendar isn't set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env first.",
  google_no_code: "Google didn't return an authorization code. Try connecting again.",
  google_token_exchange: "Couldn't complete the connection with Google. Try again.",
  google_invalid_state: "That connection link expired or came from somewhere else. Click Connect again.",
  google_sync_failed: "Couldn't sync your calendar. Your connection may have expired. Try reconnecting.",
  google_access_denied: "Access was declined on Google's side, so nothing was connected.",
  google_calendar_not_shared: "Google didn't share your calendar, so nothing was connected. Click Connect again and tick \"View events on all your calendars\" on Google's screen.",
  google_no_permission: "Only someone who manages the workspace can connect or disconnect Google Calendar.",
};

// The calendar day after a YYYY-MM-DD day.
function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// Today's meetings and everything after, on the viewer's clock, each with
// Start call opened on who it's with. One Google account feeds the whole
// workspace, so everyone sees the same meetings.
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; connected?: string; synced?: string }>;
}) {
  const { error, connected, synced } = await searchParams;
  const [workspace, user, tz] = await Promise.all([requireWorkspace(), currentUserWithRole(), cookieTimeZone()]);
  const workspaceId = workspace.id;
  // Anything new on Google shows on the next visit, without a Sync now click.
  after(() => syncCalendarIfDue(workspaceId));
  const now = new Date();
  const [events, access] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { workspaceId, startTime: { gte: startOfDayInZone(now, tz) } },
      select: { id: true, title: true, clientName: true, attendeeEmail: true, startTime: true, durationMinutes: true, meetingUrl: true, googleEventId: true },
      orderBy: { startTime: "asc" },
      take: 300,
    }),
    leadAccess(user),
  ]);
  const people = await meetingPeople(workspaceId, access.where, events);
  const isConnected = Boolean(workspace.googleRefreshToken);
  // One Google account feeds the whole workspace, so connecting and
  // disconnecting are for whoever manages it. Anyone can sync.
  const canManage = Boolean(user.role?.canManageWorkspace);
  const configured = isGoogleCalendarConfigured();

  const today = dayInZone(now, tz);
  const tomorrow = nextDay(today);
  const dayTitle = (day: string, sample: Date) =>
    day === today ? "Today" : day === tomorrow ? "Tomorrow" : new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: tz }).format(sample);
  const groups = new Map<string, { title: string; events: typeof events }>();
  for (const event of events) {
    const day = dayInZone(event.startTime, tz);
    if (!groups.has(day)) groups.set(day, { title: dayTitle(day, event.startTime), events: [] });
    groups.get(day)!.events.push(event);
  }

  return (
    <>
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Calendar</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
          Your meetings. Start call opens it with the person filled in.
        </div>
      </div>
      <Link href="/calendar/new" className="btn btn-primary">
        + Add meeting
      </Link>
    </div>

    {error && (
      <div className="chip chip-warn mb-4 w-full justify-start whitespace-normal px-4 py-2.5 text-[12.5px]">
        {ERROR_MESSAGE[error] ?? "Something went wrong."}
      </div>
    )}
    {/* Only when it really is: the link alone (an old tab, a shared URL) says nothing. */}
    {connected && isConnected && (
      <div className="chip chip-success mb-4 w-full justify-start whitespace-normal break-all px-4 py-2.5 text-[12.5px]">
        ✓ Google Calendar connected{workspace.googleAccountEmail ? ` as ${workspace.googleAccountEmail}` : ""}.
      </div>
    )}
    {synced && (
      <div className="chip chip-success mb-4 w-full justify-start px-4 py-2.5 text-[12.5px]">
        ✓ Synced {synced} meeting{synced === "1" ? "" : "s"} from Google Calendar.
      </div>
    )}

    <div className="glass-card glass-card-solid card-hover mb-5 flex flex-wrap items-center justify-between gap-3 px-5 py-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="h-1.5 w-1.5 rounded-full flex-none" style={{ background: isConnected ? "var(--success)" : "var(--ink-muted)" }} />
        <div className="min-w-0 break-words text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          {isConnected ? (
            <>Connected to Google Calendar{workspace.googleAccountEmail ? ` (${workspace.googleAccountEmail})` : ""}. New meetings come in on their own every few minutes.</>
          ) : configured ? (
            canManage ? "Not connected. Link your Google Calendar to see your meetings here." : "Not connected. An admin can link Google Calendar to show the team's meetings here."
          ) : (
            "Google Calendar integration isn't configured yet (needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)."
          )}
        </div>
      </div>
      <div className="flex flex-none gap-2">
        {isConnected ? (
          <>
            <form action={syncGoogleCalendarNow}>
              <button type="submit" className="btn btn-secondary btn-sm">Sync now</button>
            </form>
            {canManage && (
              <form action={disconnectGoogleCalendar}>
                <button type="submit" className="btn btn-secondary btn-sm">Disconnect</button>
              </form>
            )}
          </>
        ) : canManage ? (
          <ExternalConnectLink href="/api/google-calendar/connect" className="btn btn-primary btn-sm" style={!configured ? { pointerEvents: "none", opacity: 0.5 } : undefined}>
            Connect Google Calendar
          </ExternalConnectLink>
        ) : null}
      </div>
    </div>

    {events.length === 0 ? (
      <div className="glass-card glass-card-solid card-hover px-6 py-10 text-center text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        No meetings coming up.
      </div>
    ) : (
      <div className="flex flex-col gap-6">
        {[...groups.entries()].map(([day, group]) => (
          <div key={day}>
            <div className="mb-2.5 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
              {group.title}
            </div>
            <div className="glass-card glass-card-solid card-hover overflow-hidden">
              {group.events.map((event) => {
                const end = new Date(event.startTime.getTime() + event.durationMinutes * 60_000);
                return (
                  <MeetingRow
                    key={event.id}
                    title={event.title}
                    time={clockIn(event.startTime, tz)}
                    running={event.startTime <= now && end > now}
                    over={end <= now}
                    person={people.get(event.id)}
                    detail={`${event.durationMinutes} min${event.googleEventId ? " · Google Calendar" : ""}`}
                    meetingUrl={event.meetingUrl}
                    // One from Google comes back on the next sync, so it's removed there.
                    remove={event.googleEventId ? null : deleteEvent.bind(null, event.id)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    )}
    </>
  );
}

