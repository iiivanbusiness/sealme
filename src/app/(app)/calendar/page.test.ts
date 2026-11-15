import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { prisma, workspace } = vi.hoisted(() => ({
  prisma: {
    calendarEvent: { findMany: vi.fn() },
    lead: { findMany: vi.fn() },
  },
  workspace: { id: "w1", googleRefreshToken: null as string | null, googleAccountEmail: null as string | null },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/server", () => ({ after: () => {} }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/google-calendar", () => ({ isGoogleCalendarConfigured: () => true, syncCalendarIfDue: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireWorkspace: async () => workspace }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: async () => ({ id: "u1", workspaceId: "w1", role: { canManageWorkspace: true } }) }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => ({ where: {}, canViewAll: true, canAssign: true, userId: "u1" }) }));
vi.mock("./actions", () => ({ deleteEvent: vi.fn(), disconnectGoogleCalendar: vi.fn(), syncGoogleCalendarNow: vi.fn() }));

import CalendarPage from "./page";

const render = async (params: Record<string, string>) => renderToStaticMarkup(await CalendarPage({ searchParams: Promise.resolve(params) }));

describe("Calendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.calendarEvent.findMany.mockResolvedValue([]);
    prisma.lead.findMany.mockResolvedValue([]);
    workspace.googleRefreshToken = null;
    workspace.googleAccountEmail = null;
  });

  it("says Google Calendar is connected after connecting", async () => {
    workspace.googleRefreshToken = "token";
    workspace.googleAccountEmail = "ana@acme.com";
    expect(await render({ connected: "1" })).toContain("Google Calendar connected as ana@acme.com.");
  });

  it("doesn't take the link's word for it when nothing is connected", async () => {
    const html = await render({ connected: "1" });
    expect(html).not.toContain("Google Calendar connected");
    expect(html).toContain("Connect Google Calendar");
  });
});
