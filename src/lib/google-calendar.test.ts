import { afterEach, describe, expect, it, vi } from "vitest";

// The rows already saved, by "workspaceId:googleEventId", and every write a sync makes.
type Upsert = { where: { workspaceId_googleEventId: { workspaceId: string; googleEventId: string } }; create: { workspaceId: string; title: string }; update: { title: string } };
type Stored = { id: string; workspaceId: string; googleEventId: string | null; startTime: Date; durationMinutes: number };
type Find = { where: { workspaceId: string; googleEventId?: { not?: null; notIn?: string[] }; startTime?: { gte?: Date; lt?: Date } } };
const db = vi.hoisted(() => ({
  rows: new Map<string, { workspaceId: string; title: string }>(),
  // Rows findMany reads from, with the filters the sync passes applied.
  saved: [] as Stored[],
  writes: [] as { op: string; args: unknown }[],
  account: "rep@acme.com",
  refreshToken: "refresh" as string | null,
  due: true,
  reported: [] as unknown[],
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: {
      findUniqueOrThrow: async () => ({
        googleRefreshToken: db.refreshToken,
        googleAccessToken: "access",
        googleTokenExpiresAt: new Date(Date.now() + 3_600_000),
        googleAccountEmail: db.account,
      }),
      findUnique: async () => ({ googleRefreshToken: db.refreshToken }),
    },
    calendarEvent: {
      upsert: async (args: Upsert) => {
        db.writes.push({ op: "upsert", args });
        const { workspaceId, googleEventId } = args.where.workspaceId_googleEventId;
        const key = `${workspaceId}:${googleEventId}`;
        db.rows.set(key, db.rows.has(key) ? { ...db.rows.get(key)!, ...args.update } : args.create);
      },
      deleteMany: async (args: unknown) => db.writes.push({ op: "deleteMany", args }),
      findMany: async ({ where }: Find) =>
        db.saved.filter(
          (e) =>
            e.workspaceId === where.workspaceId &&
            (where.googleEventId?.not !== null || e.googleEventId !== null) &&
            !(e.googleEventId && where.googleEventId?.notIn?.includes(e.googleEventId)) &&
            (!where.startTime?.gte || e.startTime >= where.startTime.gte) &&
            (!where.startTime?.lt || e.startTime < where.startTime.lt),
        ),
    },
  },
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => db.due }));
vi.mock("@/lib/error-report", () => ({ reportError: async (err: unknown) => void db.reported.push(err) }));

import { buildAuthorizeUrl, hasCalendarScope, outsideAttendee, syncCalendarIfDue, syncWorkspaceCalendar } from "./google-calendar";

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
    db.saved.length = 0;
    db.writes.length = 0;
    db.account = "rep@acme.com";
  });

  function googleAnswers(items: { id: string; start: string }[], nextPageToken?: string) {
    vi.stubGlobal("fetch", async () =>
      new Response(JSON.stringify({ items: items.map((e) => ({ id: e.id, summary: "Call", start: { dateTime: e.start } })), nextPageToken }), { status: 200 }),
    );
  }

  it("gives each workspace its own copy of a shared meeting", async () => {
    db.rows.set("ws-a:shared", { workspaceId: "ws-a", title: "Kickoff (A's notes)" });
    googleAnswers([
      { id: "shared", start: "2026-12-01T10:00:00Z" },
      { id: "new", start: "2026-12-03T10:00:00Z" },
    ]);
    expect(await syncWorkspaceCalendar("ws-b")).toBe(2);
    const keys = db.writes.filter((w) => w.op === "upsert").map((w) => (w.args as Upsert).where.workspaceId_googleEventId);
    expect(keys).toEqual([
      { workspaceId: "ws-b", googleEventId: "shared" },
      { workspaceId: "ws-b", googleEventId: "new" },
    ]);
    expect(db.rows.get("ws-a:shared")?.title).toBe("Kickoff (A's notes)");
    expect(db.rows.get("ws-b:shared")).toMatchObject({ workspaceId: "ws-b", title: "Call" });
  });

  it("updates its own copy on the next sync", async () => {
    db.rows.set("ws-b:mine", { workspaceId: "ws-b", title: "Old title" });
    googleAnswers([{ id: "mine", start: "2026-12-02T10:00:00Z" }]);
    await syncWorkspaceCalendar("ws-b");
    expect(db.rows.get("ws-b:mine")?.title).toBe("Call");
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

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const meeting = (id: string, googleEventId: string | null, startedMinutesAgo: number, durationMinutes: number): Stored => ({
    id,
    workspaceId: "ws-b",
    googleEventId,
    startTime: minutesAgo(startedMinutesAgo),
    durationMinutes,
  });
  // The rows removed by id: meetings already under way that Google dropped.
  const removedById = () =>
    db.writes
      .filter((w) => w.op === "deleteMany")
      .flatMap((w) => ((w.args as { where: { id?: { in: string[] } } }).where.id?.in ?? []));

  it("removes a meeting already under way that Google no longer returns", async () => {
    db.saved.push(meeting("e1", "cancelled", 10, 60), { ...meeting("other-ws", "cancelled", 10, 60), workspaceId: "ws-a" });
    googleAnswers([]);
    await syncWorkspaceCalendar("ws-b");
    expect(removedById()).toEqual(["e1"]);
  });

  it("keeps a meeting under way that Google still returns, one that's over, and one added by hand", async () => {
    db.saved.push(
      meeting("still-on", "running", 10, 60),
      meeting("over", "finished", 120, 60),
      meeting("by-hand", null, 10, 60),
      // A 1 minute meeting saved as 5 that ended a minute ago: Google stopped returning it.
      meeting("short", "short", 2, 5),
    );
    googleAnswers([{ id: "running", start: minutesAgo(10).toISOString() }]);
    await syncWorkspaceCalendar("ws-b");
    expect(removedById()).toEqual([]);
  });

  it("only judges meetings under way that start before the last one of a cut-off answer", async () => {
    db.saved.push(meeting("before-cut", "gone-a", 30, 60), meeting("after-cut", "gone-b", 10, 60));
    googleAnswers([{ id: "listed", start: minutesAgo(20).toISOString() }], "more");
    await syncWorkspaceCalendar("ws-b");
    expect(removedById()).toEqual(["before-cut"]);
  });

  it("removes nothing under way when a cut-off answer comes back empty", async () => {
    db.saved.push(meeting("still-on", "running", 10, 60));
    googleAnswers([], "more");
    await syncWorkspaceCalendar("ws-b");
    expect(removedById()).toEqual([]);
  });

  type Saved = { attendeeEmail: string | null; clientName: string | null; title: string };
  const saved = () => db.writes.filter((w) => w.op === "upsert").map((w) => (w.args as { create: Saved }).create);
  function googleSends(items: object[]) {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ items }), { status: 200 }));
  }
  const at = { start: { dateTime: "2026-12-01T15:00:00Z" }, end: { dateTime: "2026-12-01T15:30:00Z" } };

  it("keeps the client's email, and the email stands in for a name Google didn't send", async () => {
    googleSends([
      { id: "a", summary: "Intro", ...at, attendees: [{ email: "rep@acme.com", self: true, organizer: true }, { email: "Dana@Northgate.io" }] },
      { id: "b", summary: "Demo", ...at, attendees: [{ email: "rep@acme.com", self: true }, { email: "sam@brightpath.com", displayName: "Sam Ortiz" }] },
    ]);
    await syncWorkspaceCalendar("ws-b");
    expect(saved()).toMatchObject([
      { title: "Intro", attendeeEmail: "dana@northgate.io", clientName: "dana@northgate.io" },
      { title: "Demo", attendeeEmail: "sam@brightpath.com", clientName: "Sam Ortiz" },
    ]);
  });

  it("leaves out all-day events, declined meetings and out of office, and clears any an older sync saved", async () => {
    googleSends([
      { id: "holiday", summary: "Thanksgiving", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } },
      { id: "declined", summary: "Vendor pitch", ...at, attendees: [{ email: "rep@acme.com", self: true, responseStatus: "declined" }, { email: "x@vendor.com" }] },
      { id: "ooo", summary: "Out", ...at, eventType: "outOfOffice" },
      { id: "call", summary: "Discovery", ...at, attendees: [{ email: "rep@acme.com", self: true, responseStatus: "accepted" }, { email: "kim@client.com" }] },
    ]);
    expect(await syncWorkspaceCalendar("ws-b")).toBe(1);
    expect(saved().map((e) => e.title)).toEqual(["Discovery"]);
    const removals = db.writes.filter((w) => w.op === "deleteMany").map((w) => (w.args as { where: { googleEventId: unknown } }).where.googleEventId);
    expect(removals).toEqual([{ in: ["holiday", "declined", "ooo"] }, { not: null, notIn: ["call"] }]);
  });

  it("knows a client on Gmail when the connected account is on Gmail too", async () => {
    db.account = "owner@gmail.com";
    googleSends([{ id: "a", summary: "Call", ...at, attendees: [{ email: "owner@gmail.com", self: true }, { email: "client.person@gmail.com" }] }]);
    await syncWorkspaceCalendar("ws-b");
    expect(saved()[0].attendeeEmail).toBe("client.person@gmail.com");
  });
});

describe("Who a meeting is with", () => {
  it("is never a teammate, the connected account or a room", () => {
    expect(
      outsideAttendee(
        {
          attendees: [
            { email: "rep@acme.com", self: true },
            { email: "manager@acme.com" },
            { email: "c_1882@resource.calendar.google.com", displayName: "Board room" },
            { email: "room@acme.io", resource: true },
            { email: "lee@client.com", displayName: "Lee" },
          ],
        },
        "rep@acme.com",
      ),
    ).toEqual({ name: "Lee", email: "lee@client.com" });
    expect(outsideAttendee({ attendees: [{ email: "rep@acme.com", self: true }, { email: "ops@acme.com" }] }, "rep@acme.com")).toBeNull();
    expect(outsideAttendee({}, "rep@acme.com")).toBeNull();
  });

  it("skips the organizer unless the client sent the invite", () => {
    const withGuest = { attendees: [{ email: "partner@agency.com", organizer: true }, { email: "rep@acme.com", self: true }, { email: "lee@client.com" }] };
    expect(outsideAttendee(withGuest, "rep@acme.com")?.email).toBe("lee@client.com");
    const clientSent = { attendees: [{ email: "lee@client.com", organizer: true }, { email: "rep@acme.com", self: true }] };
    expect(outsideAttendee(clientSent, "rep@acme.com")?.email).toBe("lee@client.com");
  });
});

describe("Syncing on its own", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    db.writes.length = 0;
    db.reported.length = 0;
    db.refreshToken = "refresh";
    db.due = true;
  });

  function configured() {
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
  }
  function countGoogleCalls() {
    const calls = { n: 0 };
    vi.stubGlobal("fetch", async () => {
      calls.n++;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    return calls;
  }

  it("asks Google at most once every few minutes", async () => {
    configured();
    const google = countGoogleCalls();
    await syncCalendarIfDue("ws-b");
    expect(google.n).toBe(1);
    db.due = false;
    await syncCalendarIfDue("ws-b");
    expect(google.n).toBe(1);
  });

  it("syncs right away when asked to, even inside those minutes", async () => {
    configured();
    const google = countGoogleCalls();
    db.due = false;
    await syncCalendarIfDue("ws-b", { force: true });
    expect(google.n).toBe(1);
  });

  it("does nothing for a workspace that hasn't connected Google", async () => {
    configured();
    const google = countGoogleCalls();
    db.refreshToken = null;
    await syncCalendarIfDue("ws-b");
    expect(google.n).toBe(0);
  });

  it("stays quiet when access was taken back on Google's side, and reports anything else", async () => {
    configured();
    vi.stubGlobal("fetch", async () => new Response("unauthorized", { status: 401 }));
    await expect(syncCalendarIfDue("ws-b")).resolves.toBeUndefined();
    expect(db.reported).toEqual([]);
    vi.stubGlobal("fetch", async () => new Response("backend error", { status: 503 }));
    await syncCalendarIfDue("ws-b");
    expect(db.reported).toHaveLength(1);
  });
});
