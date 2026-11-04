"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { revokeGoogleToken, syncWorkspaceCalendar } from "@/lib/google-calendar";
import { requireWorkspaceId } from "@/lib/workspace";
import { requirePermission } from "@/lib/permissions";

export async function createEvent(formData: FormData) {
  const title = String(formData.get("title") ?? "").trim();
  const clientName = String(formData.get("clientName") ?? "").trim() || null;
  const startTimeRaw = String(formData.get("startTime") ?? "");
  const durationMinutes = Number(formData.get("durationMinutes") ?? 30);
  const platform = String(formData.get("platform") ?? "zoom");
  const meetingUrl = String(formData.get("meetingUrl") ?? "").trim() || null;

  if (!title || !startTimeRaw) throw new Error("Title and start time are required");

  const workspaceId = await requireWorkspaceId();

  await prisma.calendarEvent.create({
    data: {
      workspaceId,
      title,
      clientName,
      startTime: new Date(startTimeRaw),
      durationMinutes,
      platform,
      meetingUrl,
    },
  });

  redirect("/calendar");
}

export async function deleteEvent(eventId: string) {
  const workspaceId = await requireWorkspaceId();
  await prisma.calendarEvent.deleteMany({ where: { id: eventId, workspaceId } });
  revalidatePath("/calendar");
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
  revalidatePath("/calendar");
}
