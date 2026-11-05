import { prisma } from "@/lib/db";

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
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
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

type GoogleEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  hangoutLink?: string;
  location?: string;
  attendees?: { email?: string; displayName?: string }[];
};

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
  if (!res.ok) throw new Error(`Google Calendar fetch failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
  const items = data.items ?? [];

  const ownDomain = workspace.googleAccountEmail?.split("@")[1]?.toLowerCase();

  let synced = 0;
  for (const event of items) {
    const start = event.start?.dateTime ?? event.start?.date;
    if (!start || !event.id) continue;
    const startTime = new Date(start);
    const end = event.end?.dateTime ?? event.end?.date;
    const durationMinutes = end ? Math.max(5, Math.round((new Date(end).getTime() - startTime.getTime()) / 60000)) : 30;
    const clientName =
      event.attendees?.find((a) => a.email && (!ownDomain || !a.email.toLowerCase().endsWith(`@${ownDomain}`)))?.displayName ?? null;
    const fields = {
      title: event.summary ?? "Untitled event",
      clientName,
      startTime,
      durationMinutes,
      platform: detectPlatform(event),
      meetingUrl: extractMeetingUrl(event),
    };

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

  // A cancelled or deleted event just stops coming back, so an upcoming one
  // missing from this answer is gone from Google. When the answer was cut
  // off at MAX_EVENTS, only the stretch it covers can be judged.
  const truncated = Boolean(data.nextPageToken) || items.length >= MAX_EVENTS;
  const lastStart = items.at(-1)?.start;
  const coveredUntil = truncated ? new Date(lastStart?.dateTime ?? lastStart?.date ?? now) : null;
  await prisma.calendarEvent.deleteMany({
    where: {
      workspaceId,
      googleEventId: { not: null, notIn: items.map((e) => e.id).filter(Boolean) },
      startTime: { gte: now, ...(coveredUntil ? { lt: coveredUntil } : {}) },
    },
  });
  return synced;
}
