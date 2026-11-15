import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { prisma, synced, later } = vi.hoisted(() => ({
  prisma: {
    calendarEvent: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    lead: { findMany: vi.fn() },
  },
  synced: vi.fn(),
  later: [] as (() => unknown)[],
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void later.push(fn) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/google-calendar", () => ({ syncCalendarIfDue: synced }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => ({ where: { OR: [{ ownerId: "u1" }] }, canViewAll: false, canAssign: false, userId: "u1" }) }));

import ComingUp from "./coming-up";

const render = async () => renderToStaticMarkup(await ComingUp({ workspaceId: "w1", userId: "u1", tz: "UTC" }));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
const event = (o: Record<string, unknown>) => ({ id: "e1", title: "Discovery", clientName: null, attendeeEmail: null, startTime: new Date("2026-11-14T16:00:00Z"), durationMinutes: 30, meetingUrl: null, ...o });
const dana = { id: "l-dana", name: "Dana Lee", company: "Northgate", email: "dana@northgate.io", isClient: true };

describe("Coming up on the Dashboard", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-14T15:00:00Z"));
    vi.clearAllMocks();
    later.length = 0;
    prisma.calendarEvent.findMany.mockResolvedValue([]);
    prisma.task.findMany.mockResolvedValue([]);
    prisma.lead.findMany.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());

  it("starts a call from a Google meeting with the name and email filled in", async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([event({ clientName: "Kim Park", attendeeEmail: "kim@client.com", meetingUrl: "https://meet.google.com/abc-defg-hij" })]);
    const html = await render();
    expect(text(html)).toContain("16:00 Discovery Kim Park");
    expect(html).toContain('href="/deals/new?who=kim%40client.com&amp;name=Kim+Park"');
    expect(html).toContain('href="https://meet.google.com/abc-defg-hij"');
  });

  it("opens Start call on the lead SealMe knows, with the Client mark", async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([event({ clientName: "Dana", attendeeEmail: "dana@northgate.io" })]);
    prisma.lead.findMany.mockResolvedValue([dana]);
    const html = await render();
    expect(html).toContain('href="/leads/l-dana"');
    expect(text(html)).toContain("Dana Lee Client · Northgate");
    expect(html).toContain('href="/deals/new?lead=l-dana"');
    expect(prisma.lead.findMany.mock.calls[0][0].where.AND[0]).toEqual({ OR: [{ ownerId: "u1" }] });
  });

  it("only reads today on the viewer's clock, and drops a meeting once it's over", async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      event({ id: "done", title: "Standup", startTime: new Date("2026-11-14T13:00:00Z") }),
      event({ id: "now", title: "Kickoff", startTime: new Date("2026-11-14T14:45:00Z") }),
      event({ id: "later", title: "Demo", startTime: new Date("2026-11-14T17:00:00Z") }),
    ]);
    const out = text(await render());
    expect(out).not.toContain("Standup");
    expect(out).toContain("Now Kickoff");
    expect(out).toContain("17:00 Demo");
    const where = prisma.calendarEvent.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ workspaceId: "w1", startTime: { gte: new Date("2026-11-14T00:00:00Z"), lt: new Date("2026-11-15T00:00:00Z") } });
  });

  it("adds the viewer's sales calls for today, once when the meeting is the same call", async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([event({ clientName: "Dana Lee" })]);
    prisma.task.findMany.mockResolvedValue([
      { id: "t-same", dueTime: "16:00", note: null, lead: dana },
      { id: "t-other", dueTime: "18:30", note: null, lead: { ...dana, id: "l-sam", name: "Sam Ortiz", isClient: false } },
      { id: "t-past", dueTime: "09:00", note: null, lead: { ...dana, id: "l-old", name: "Old Call", isClient: false } },
    ]);
    const html = await render();
    const out = text(html);
    expect(out.match(/Dana Lee/g)).toHaveLength(1);
    expect(out).toContain("16:00 Discovery Dana Lee");
    expect(out).toContain("18:30 Sales call Sam Ortiz");
    expect(out).not.toContain("Old Call");
    expect(prisma.task.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "w1", assigneeId: "u1", status: "open", type: "sales_call", dueDate: new Date("2026-11-14T00:00:00Z") });
  });

  it("shows a call once when the calendar spells the name in another case", async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([event({ clientName: "  dana LEE " })]);
    prisma.task.findMany.mockResolvedValue([{ id: "t-same", dueTime: "16:00", note: null, lead: dana }]);
    const out = text(await render());
    expect(out).toContain("16:00 Discovery Dana Lee");
    expect(out).not.toContain("Sales call");
  });

  it("never hides a sales call with no time behind +N more", async () => {
    prisma.calendarEvent.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => event({ id: `e${i}`, title: `Meeting ${i}`, startTime: new Date(Date.UTC(2026, 10, 14, 15, 30 + i * 30)) })),
    );
    prisma.task.findMany.mockResolvedValue([{ id: "t-any", dueTime: null, note: "Call Sam back", lead: { ...dana, id: "l-sam", name: "Sam Ortiz", isClient: false } }]);
    const out = text(await render());
    expect(out).toContain("Today Call Sam back Sam Ortiz");
    expect(out).toContain("Meeting 7");
    expect(out).not.toContain("Meeting 8");
    // The untimed call comes after the timed ones and isn't counted as hidden.
    expect(out.indexOf("Meeting 7")).toBeLessThan(out.indexOf("Call Sam back"));
    expect(out).toContain("+2 more today");
  });

  it("only counts meetings in +N more, and never cuts a sales call with a time", async () => {
    prisma.calendarEvent.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => event({ id: `e${i}`, title: `Meeting ${i}`, startTime: new Date(Date.UTC(2026, 10, 14, 15, 30 + i * 30)) })),
    );
    prisma.task.findMany.mockResolvedValue([
      { id: "t-late", dueTime: "20:30", note: "Call Sam", lead: { ...dana, id: "l-sam", name: "Sam Ortiz", isClient: false } },
      { id: "t-later", dueTime: "21:00", note: "Call Kim", lead: { ...dana, id: "l-kim", name: "Kim Park", isClient: false } },
    ]);
    const out = text(await render());
    expect(out).toContain("Meeting 7");
    expect(out).not.toContain("Meeting 8");
    expect(out).not.toContain("Meeting 9");
    expect(out).toContain("20:30 Call Sam Sam Ortiz");
    expect(out).toContain("21:00 Call Kim Kim Park");
    // Only the two meetings the Calendar has.
    expect(out).toContain("+2 more today");
  });

  it("says so quietly when nothing is on today, with a way to add a meeting", async () => {
    const html = await render();
    expect(text(html)).toContain("No meetings today.");
    expect(html).toContain('href="/calendar/new"');
  });

  it("asks Google for anything new after the page has gone out", async () => {
    await render();
    expect(synced).not.toHaveBeenCalled();
    await Promise.all(later.map((fn) => fn()));
    expect(synced).toHaveBeenCalledWith("w1");
  });
});
