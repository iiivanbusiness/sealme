import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, redirect, revalidatePath, zone } = vi.hoisted(() => ({
  prisma: { calendarEvent: { create: vi.fn(), deleteMany: vi.fn() } },
  // Like Next's: nothing after a redirect runs.
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  revalidatePath: vi.fn(),
  zone: { tz: "America/New_York" },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/permissions", () => ({ requirePermission: vi.fn() }));
vi.mock("@/lib/google-calendar", () => ({ revokeGoogleToken: vi.fn(), syncWorkspaceCalendar: vi.fn() }));
vi.mock("@/lib/viewer-time", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/viewer-time")>()), cookieTimeZone: async () => zone.tz }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { createEvent, deleteEvent } from "./actions";

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  zone.tz = "America/New_York";
});

describe("Adding a meeting by hand", () => {
  it("reads the time on the rep's clock and keeps the email for Start call", async () => {
    await expect(
      createEvent(form({ title: "Intro", clientName: "Kim Park", attendeeEmail: " Kim@Client.com ", startTime: "2026-11-14T14:00", durationMinutes: "45", meetingUrl: "zoom.us/j/123" })),
    ).rejects.toThrow("redirect:/calendar");
    expect(prisma.calendarEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "w1",
        title: "Intro",
        clientName: "Kim Park",
        attendeeEmail: "kim@client.com",
        startTime: new Date("2026-11-14T19:00:00Z"),
        durationMinutes: 45,
        platform: "zoom",
        meetingUrl: "https://zoom.us/j/123",
      },
    });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("sends the rep back when the email doesn't look right", async () => {
    await expect(createEvent(form({ title: "Intro", attendeeEmail: "kim@", startTime: "2026-11-14T14:00" }))).rejects.toThrow("redirect:/calendar/new?error=");
    expect(prisma.calendarEvent.create).not.toHaveBeenCalled();
  });

  it("removes only a meeting added by hand", async () => {
    await deleteEvent("e1");
    expect(prisma.calendarEvent.deleteMany).toHaveBeenCalledWith({ where: { id: "e1", workspaceId: "w1", googleEventId: null } });
  });
});
