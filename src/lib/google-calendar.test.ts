import { afterEach, describe, expect, it, vi } from "vitest";

// The rows already saved, by googleEventId, and every write a sync makes.
const db = vi.hoisted(() => ({
  rows: new Map<string, { id: string; workspaceId: string }>(),
  writes: [] as { op: string; args: unknown }[],
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findUniqueOrThrow: async () => ({
        googleRefreshToken: "refresh",
        googleAccessToken: "access",
        googleTokenExpiresAt: new Date(Date.now() + 3_600_000),
        googleAccountEmail: "rep@acme.com",
      }),
    },
    calendarEvent: {
      findUnique: async ({ where }: { where: { googleEventId: string } }) => db.rows.get(where.googleEventId) ?? null,
      update: async (args: unknown) => db.writes.push({ op: "update", args }),
      create: async (args: unknown) => db.writes.push({ op: "create", args }),
      deleteMany: async (args: unknown) => db.writes.push({ op: "deleteMany", args }),
    },
  },
}));

import { buildAuthorizeUrl, hasCalendarScope, syncWorkspaceCalendar } from "./google-calendar";

describe("Google Calendar scopes", () => {
  it("asks only for read access to events, plus the email address", () => {
    const scope = new URL(buildAuthorizeUrl("state")).searchParams.get("scope");
    expect(scope?.split(" ").sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.events.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
  });

  it("notices when calendar access was left unticked on Google's screen", () => {
    expect(hasCalendarScope("https://www.googleapis.com/auth/userinfo.email openid")).toBe(false);
    expect(hasCalendarScope(undefined)).toBe(false);
    expect(
      hasCalendarScope("openid https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/userinfo.email")
    ).toBe(true);
  });
});

describe("Syncing Google Calendar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    db.rows.clear();
    db.writes.length = 0;
  });

  function googleAnswers(items: { id: string; start: string }[], nextPageToken?: string) {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ items: items.map((e) => ({ id: e.id, summary: "Call", start: { dateTime: e.start } })), nextPageToken }), { status: 200 }),
    );
  }

  it("leaves another workspace's copy of a meeting alone", async () => {
    db.rows.set("shared", { id: "row-a", workspaceId: "ws-a" });
    db.rows.set("mine", { id: "row-b", workspaceId: "ws-b" });
    googleAnswers([
      { id: "shared", start: "2026-12-01T10:00:00Z" },
      { id: "mine", start: "2026-12-02T10:00:00Z" },
      { id: "new", start: "2026-12-03T10:00:00Z" },
    ]);
    expect(await syncWorkspaceCalendar("ws-b")).toBe(2);
    const touched = db.writes.filter((w) => w.op !== "deleteMany").map((w) => w.args as { where?: { id: string }; data: { googleEventId?: string } });
    expect(touched.map((t) => t.where?.id ?? t.data.googleEventId)).toEqual(["row-b", "new"]);
  });

  it("removes upcoming events Google no longer returns", async () => {
    googleAnswers([{ id: "kept", start: "2026-12-01T10:00:00Z" }]);
    await syncWorkspaceCalendar("ws-b");
    const removed = db.writes.find((w) => w.op === "deleteMany")!.args as { where: { workspaceId: string; googleEventId: unknown; startTime: { gte: Date; lt?: Date } } };
    expect(removed.where.workspaceId).toBe("ws-b");
    expect(removed.where.googleEventId).toEqual({ not: null, notIn: ["kept"] });
    expect(removed.where.startTime.lt).toBeUndefined();
  });

  it("only judges the stretch a cut-off answer covers", async () => {
    googleAnswers([{ id: "a", start: "2026-12-01T10:00:00Z" }, { id: "b", start: "2026-12-05T10:00:00Z" }], "more");
    await syncWorkspaceCalendar("ws-b");
    const removed = db.writes.find((w) => w.op === "deleteMany")!.args as { where: { startTime: { lt?: Date } } };
    expect(removed.where.startTime.lt).toEqual(new Date("2026-12-05T10:00:00Z"));
  });
});
