"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { revokeGoogleToken, syncWorkspaceCalendar } from "@/lib/google-calendar";
import { requireWorkspaceId } from "@/lib/workspace";
import { requirePermission } from "@/lib/permissions";
import { cookieTimeZone, instantInZone } from "@/lib/viewer-time";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The Dashboard's Coming up shows today's meetings too.
function refreshPages() {
  revalidatePath("/calendar");
  revalidatePath("/dashboard");
}

// A meeting added by hand. The date and time are on the rep's clock (the
// form has no timezone), and the email, when there is one, is how Start
// call finds or starts the right lead.
export async function createEvent(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim().slice(0, 200);
  const clientName = String(formData.get("clientName") ?? "").trim().slice(0, 200) || null;
  const attendeeEmail = String(formData.get("attendeeEmail") ?? "").trim().toLowerCase() || null;
  const [day = "", time = ""] = String(formData.get("startTime") ?? "").split("T");
  const duration = Math.round(Number(formData.get("durationMinutes") ?? 30));
  const durationMinutes = Number.isFinite(duration) && duration >= 5 ? Math.min(duration, 12 * 60) : 30;
  let meetingUrl = String(formData.get("meetingUrl") ?? "").trim() || null;
  // "meet.google.com/abc-defg-hij" typed without https:// still has to open.
  if (meetingUrl && !/^https?:\/\//i.test(meetingUrl)) meetingUrl = `https://${meetingUrl}`;

  const startTime = instantInZone(day, time.slice(0, 5), await cookieTimeZone());
  if (!title || Number.isNaN(startTime.getTime())) redirect(`/calendar/new?error=${encodeURIComponent("Add a title, a date and a time")}`);
  if (attendeeEmail && !EMAIL.test(attendeeEmail)) redirect(`/calendar/new?error=${encodeURIComponent("That email doesn't look right")}`);

  const workspaceId = await requireWorkspaceId();
  await prisma.calendarEvent.create({
    data: {
      workspaceId,
      title,
      clientName,
      attendeeEmail,
      startTime,
      durationMinutes,
      platform: meetingUrl?.toLowerCase().includes("zoom.us") ? "zoom" : "meet",
      meetingUrl,
    },
  });

  refreshPages();
  redirect("/calendar");
}

// Only a meeting added by hand: one from Google would come back on the next
// sync, so it's removed in Google Calendar.
export async function deleteEvent(eventId: string) {
  const workspaceId = await requireWorkspaceId();
  await prisma.calendarEvent.deleteMany({ where: { id: eventId, workspaceId, googleEventId: null } });
  refreshPages();
}

export async function syncGoogleCalendarNow() {
  const workspaceId = await requireWorkspaceId();

  let redirectTo = "/calendar?error=google_sync_failed";
  try {
    const count = await syncWorkspaceCalendar(workspaceId);
    redirectTo = `/calendar?synced=${count}`;
  } catch {
    // fall through to the error redirect set above
  }
  revalidatePath("/dashboard");
  redirect(redirectTo);
}

// Disconnecting means we keep nothing from Google: the grant is revoked on
// Google's side and the events we synced are deleted. Events a rep added by
// hand stay. The connection is the whole workspace's, so only someone who
// manages the workspace can drop it, same as Slack and the CRMs.
export async function disconnectGoogleCalendar() {
  await requirePermission("canManageWorkspace");
  const workspaceId = await requireWorkspaceId();
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { googleRefreshToken: true } });
  if (workspace.googleRefreshToken) await revokeGoogleToken(workspace.googleRefreshToken);
  await prisma.$transaction([
    prisma.calendarEvent.deleteMany({ where: { workspaceId, googleEventId: { not: null } } }),
    prisma.workspace.update({
      where: { id: workspaceId },
      data: { googleAccessToken: null, googleRefreshToken: null, googleTokenExpiresAt: null, googleAccountEmail: null },
    }),
  ]);
  refreshPages();
}
