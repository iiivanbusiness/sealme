import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { reportError } from "@/lib/error-report";

// Only events on the primary calendar are read, so ask for events-only
// read access rather than calendar.readonly (Google's review asks for the
// narrowest scope that does the job).
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const SCOPE = `${CALENDAR_SCOPE} https://www.googleapis.com/auth/userinfo.email`;

// Google's consent screen lets people untick individual permissions, so a
// successful sign-in can come back without calendar access. `granted` is the
// space-separated `scope` field of the token response.
export function hasCalendarScope(granted: string | undefined): boolean {
  return (granted ?? "").split(" ").includes(CALENDAR_SCOPE);
}

export function isGoogleCalendarConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${base}/api/google-calendar/callback`;
}

export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>;
}

// Access was taken back on Google's side, or the grant ran out: only
// connecting again fixes it, so it isn't a bug to hear about.
export class GoogleAccessError extends Error {}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    const Failure = res.status === 400 && body.includes("invalid_grant") ? GoogleAccessError : Error;
    throw new Failure(`Google token refresh failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

// Best effort: if Google is unreachable the local tokens are still wiped, and
// the grant stays listed at myaccount.google.com/permissions for the user to remove.
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
  } catch {
    // ignore, see above
  }
}

export async function getUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { email?: string };
  return data.email ?? null;
}

type GoogleAttendee = { email?: string; displayName?: string; self?: boolean; resource?: boolean; organizer?: boolean; responseStatus?: string };

type GoogleEvent = {
  id: string;
  status?: string;
  eventType?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  location?: string;
  attendees?: GoogleAttendee[];
};

// A meeting to show: one at a set time that the connected account is going
// to. All-day events (holidays, trips), out of office, focus time and
// working location blocks aren't calls, and neither is one it declined.
function isMeeting(event: GoogleEvent): boolean {
  if (!event.id || !event.start?.dateTime || event.status === "cancelled") return false;
  if (event.eventType && event.eventType !== "default") return false;
  return !event.attendees?.some((a) => a.self && a.responseStatus === "declined");
}

// Mailbox providers anyone can sign up with: sharing one with the connected
// account doesn't make someone a teammate.
const PUBLIC_MAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com",
]);

// Who the meeting is with: the first attendee from outside, so Start call
// can fill in the person. Never the connected account, anyone on its company
// domain, or a room. The organizer is skipped too (usually the rep's side)
// unless nobody else is there, as when the client sent the invite.
export function outsideAttendee(event: Pick<GoogleEvent, "attendees">, ownEmail: string | null | undefined): { name: string | null; email: string } | null {
  const own = ownEmail?.trim().toLowerCase() || null;
  const ownDomain = own?.split("@")[1];
  const teamDomain = ownDomain && !PUBLIC_MAIL_DOMAINS.has(ownDomain) ? ownDomain : null;
  const outside = (event.attendees ?? []).flatMap((a) => {
    const email = a.email?.trim().toLowerCase();
    if (!email || !email.includes("@") || a.self || a.resource || email === own) return [];
    // Rooms and shared calendars invited to a meeting.
    if (email.endsWith(".calendar.google.com")) return [];
    if (teamDomain && email.endsWith(`@${teamDomain}`)) return [];
    return [{ name: a.displayName?.trim() || null, email, organizer: Boolean(a.organizer) }];
  });
  const pick = outside.find((a) => !a.organizer) ?? outside[0];
  return pick ? { name: pick.name, email: pick.email } : null;
}

function detectPlatform(event: GoogleEvent): string {
  const haystack = `${event.hangoutLink ?? ""} ${event.location ?? ""}`.toLowerCase();
  if (haystack.includes("zoom.us")) return "zoom";
  return "meet";
}

const URL_PATTERN = /https?:\/\/[^\s<>")]+/i;

function extractMeetingUrl(event: GoogleEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink;
  const match = event.location?.match(URL_PATTERN);
  return match ? match[0] : null;
}

// How many upcoming events one sync reads.
const MAX_EVENTS = 25;

// The shortest a saved meeting runs. Rounding a shorter one up to it means
// the saved end can be this much later than Google's.
const MIN_MINUTES = 5;

// How long ago a meeting still under way can have started, so a sync
// doesn't read back through every meeting that's over.
const LOOK_BACK_MS = 24 * 60 * 60 * 1000;

// Syncs the workspace's connected Google Calendar into CalendarEvent rows.
// Refreshes the access token first if it's missing/expired.
export async function syncWorkspaceCalendar(workspaceId: string): Promise<number> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (!workspace.googleRefreshToken) throw new Error("Google Calendar isn't connected for this workspace");

  let accessToken = workspace.googleAccessToken;
  const expired = !workspace.googleTokenExpiresAt || workspace.googleTokenExpiresAt < new Date();
  if (!accessToken || expired) {
    const refreshed = await refreshAccessToken(workspace.googleRefreshToken);
    accessToken = refreshed.access_token;
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { googleAccessToken: accessToken, googleTokenExpiresAt: new Date(Date.now() + refreshed.expires_in * 1000) },
    });
  }

  const now = new Date();
  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    maxResults: String(MAX_EVENTS),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const Failure = res.status === 401 ? GoogleAccessError : Error;
    throw new Failure(`Google Calendar fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
  const items = data.items ?? [];

  let synced = 0;
  const kept: string[] = [];
  const skipped: string[] = [];
  for (const event of items) {
    if (!isMeeting(event)) {
      if (event.id) skipped.push(event.id);
      continue;
    }
    const startTime = new Date(event.start!.dateTime!);
    const end = event.end?.dateTime;
    const durationMinutes = end ? Math.max(MIN_MINUTES, Math.round((new Date(end).getTime() - startTime.getTime()) / 60000)) : 30;
    const person = outsideAttendee(event, workspace.googleAccountEmail);
    const fields = {
      title: event.summary ?? "Untitled event",
      // Google only sends a name for people in the account's contacts, so
      // the email stands in for it.
      clientName: person ? (person.name ?? person.email) : null,
      attendeeEmail: person?.email ?? null,
      startTime,
      durationMinutes,
      platform: detectPlatform(event),
      meetingUrl: extractMeetingUrl(event),
    };
    kept.push(event.id);

    // Google gives each attendee's copy of a meeting the same id, so the
    // event is this workspace's own row for that id: two workspaces on the
    // same meeting each keep theirs.
    try {
      await prisma.calendarEvent.upsert({
        where: { workspaceId_googleEventId: { workspaceId, googleEventId: event.id } },
        create: { workspaceId, googleEventId: event.id, ...fields },
        update: fields,
      });
    } catch (err) {
      // Another sync made it a moment ago.
      if ((err as { code?: string }).code === "P2002") continue;
      throw err;
    }
    synced++;
  }

  // Not a meeting after all (all day, declined, out of office), but an
  // older sync may have saved it.
  if (skipped.length) await prisma.calendarEvent.deleteMany({ where: { workspaceId, googleEventId: { in: skipped } } });

  // A cancelled or deleted event just stops coming back, so an upcoming one
  // missing from this answer is gone from Google. When the answer was cut
  // off at MAX_EVENTS, only the stretch it covers can be judged.
  const truncated = Boolean(data.nextPageToken) || items.length >= MAX_EVENTS;
  const lastStart = items.at(-1)?.start;
  const coveredUntil = truncated ? new Date(lastStart?.dateTime ?? lastStart?.date ?? now) : null;
  await prisma.calendarEvent.deleteMany({
    where: {
      workspaceId,
      googleEventId: { not: null, notIn: kept },
      startTime: { gte: now, ...(coveredUntil ? { lt: coveredUntil } : {}) },
    },
  });

  // timeMin is about when an event ends, so the answer also has every
  // meeting already under way: one missing from it was cancelled, or moved
  // to a time that has passed. Left alone it would stay in Coming up as Now.
  // Its saved end can run up to MIN_MINUTES past Google's, so only one with
  // more left than that is judged, and one that's over stays. As above, a
  // cut-off answer only covers meetings that start before its last one.
  // A cut-off answer with no events in it (Google allows that) covers
  // nothing, so nothing under way is judged.
  const startedBefore = coveredUntil && coveredUntil < now ? coveredUntil : now;
  const underWay = truncated && !lastStart ? [] : await prisma.calendarEvent.findMany({
    where: {
      workspaceId,
      googleEventId: { not: null, notIn: kept },
      startTime: { gte: new Date(now.getTime() - LOOK_BACK_MS), lt: startedBefore },
    },
    select: { id: true, startTime: true, durationMinutes: true },
  });
  const gone = underWay
    .filter((e) => e.startTime.getTime() + (e.durationMinutes - MIN_MINUTES) * 60_000 > now.getTime())
    .map((e) => e.id);
  if (gone.length) await prisma.calendarEvent.deleteMany({ where: { workspaceId, id: { in: gone } } });
  return synced;
}

// How often opening the Dashboard or Calendar asks Google for changes.
const AUTO_SYNC_EVERY_MS = 10 * 60 * 1000;

// Keeps the workspace's meetings fresh without a Sync now click: at most one
// sync per workspace every 10 minutes, whoever opens a page that shows them.
// force: sync now anyway (right after connecting), and start the 10 minutes
// from here. Meant for after(): never throws. Access taken back on Google's
// side stays quiet; Sync now on the Calendar page says to reconnect.
export async function syncCalendarIfDue(workspaceId: string, options: { force?: boolean } = {}): Promise<void> {
  try {
    if (!isGoogleCalendarConfigured()) return;
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { googleRefreshToken: true } });
    if (!workspace?.googleRefreshToken) return;
    const due = await checkRateLimit(`gcal-sync:${workspaceId}`, 1, AUTO_SYNC_EVERY_MS);
    if (!due && !options.force) return;
    await syncWorkspaceCalendar(workspaceId);
  } catch (err) {
    if (err instanceof GoogleAccessError) return;
    await reportError(err, "Google Calendar sync", { workspaceId });
  }
}
