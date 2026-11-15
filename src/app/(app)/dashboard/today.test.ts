import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A tiny in-memory workspace: the to-dos, meetings and people todaySection
// asks the database for, filtered the way its queries say.
type Task = { id: string; assigneeId: string; type: string; status: string; dueDate: Date; dueTime: string | null; lead: { id: string; name: string; email: string | null } | null };
type Range = Date | { lt?: Date; gte?: Date } | undefined;
const { prisma, db } = vi.hoisted(() => {
  const db = {
    members: [] as { id: string; name: string }[],
    tasks: [] as Task[],
    events: [] as { id: string; title: string; clientName: string | null; attendeeEmail: string | null; startTime: Date; durationMinutes: number }[],
  };
  const inRange = (v: Date, r: Range) =>
    !r || (r instanceof Date ? v.getTime() === r.getTime() : (!r.gte || v >= r.gte) && (!r.lt || v < r.lt));
  const matches = (t: Task, w: { assigneeId?: string; status?: string | { in: string[] }; type?: string; dueDate?: Range }) =>
    (!w.assigneeId || t.assigneeId === w.assigneeId) &&
    (!w.status || (typeof w.status === "string" ? t.status === w.status : w.status.in.includes(t.status))) &&
    (!w.type || t.type === w.type) &&
    inRange(t.dueDate, w.dueDate);
  const full = (t: Task) => ({ ...t, priority: "normal", note: null, completedAt: null, createdAt: new Date("2026-11-01T00:00:00Z"), assignee: { id: t.assigneeId, name: "X" }, createdBy: null, lead: t.lead && { ...t.lead, company: null, campaign: null, phone: null } });
  return {
    db,
    prisma: {
      user: { findMany: vi.fn(async () => db.members) },
      lead: { count: vi.fn(async () => 0) },
      phoneCall: { findMany: vi.fn(async () => []) },
      calendarEvent: { findMany: vi.fn(async ({ where }) => db.events.filter((e) => inRange(e.startTime, where.startTime))) },
      task: {
        findMany: vi.fn(async ({ where }) => db.tasks.filter((t) => matches(t, where)).map(full)),
        findFirst: vi.fn(async ({ where }) => db.tasks.filter((t) => matches(t, where)).map(full)[0] ?? null),
        count: vi.fn(async ({ where }) => db.tasks.filter((t) => matches(t, where)).length),
        groupBy: vi.fn(async ({ by, where }) => {
          const groups = new Map<string, { key: unknown; n: number }>();
          for (const t of db.tasks.filter((t) => matches(t, where))) {
            const key = (t as Record<string, unknown>)[by[0]];
            const id = key instanceof Date ? key.toISOString() : String(key);
            groups.set(id, { key, n: (groups.get(id)?.n ?? 0) + 1 });
          }
          return [...groups.values()].map((g) => ({ [by[0]]: g.key, _count: { _all: g.n } }));
        }),
      },
    },
  };
});
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/components/dashboard/TodoList", () => ({ default: () => null }));
vi.mock("@/app/(app)/leads/task-actions", () => ({ createTodo: vi.fn(), quickAssignLeads: vi.fn(), searchTodoLeads: vi.fn(), setTaskStatus: vi.fn() }));
vi.mock("@/app/(app)/leads/phone-actions", () => ({ startLeadCall: vi.fn() }));
vi.mock("@/app/(app)/preferences-actions", () => ({ setTaskDigestEmail: vi.fn() }));

import { todaySection } from "./today";

const me = { id: "u1", name: "Ana Smith", taskDigestEmail: false };
const day = (d: string) => new Date(`${d}T00:00:00Z`);
let n = 0;
const task = (o: Partial<Task>): Task => ({ id: `t${++n}`, assigneeId: "u1", type: "follow_up", status: "open", dueDate: day("2026-11-14"), dueTime: null, lead: { id: "l1", name: "Dana Lee", email: "dana@northgate.io" }, ...o });
const run = async (o: { view?: string; canAssign: boolean }) => {
  const out = await todaySection({ workspaceId: "w1", me, tz: "UTC", view: o.view, queue: false, canAssign: o.canAssign });
  return { sentence: out.sentence, props: out.block.props as { view: { kind: string; late?: { count: number } }; canAssign: boolean } };
};

describe("Reminders and the day's sentence", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Saturday, 15:00.
    vi.setSystemTime(new Date("2026-11-14T15:00:00Z"));
    vi.clearAllMocks();
    db.members = [{ id: "u1", name: "Ana Smith" }];
    db.tasks = [];
    db.events = [];
  });
  afterEach(() => vi.useRealTimers());

  it("shows someone alone in the workspace their own list, with no team view or handing out", async () => {
    for (const view of [undefined, "team"]) {
      const { props } = await run({ view, canAssign: true });
      expect(props.view.kind).toBe("list");
      expect(props.canAssign).toBe(false);
    }
  });

  it("opens on the team for whoever hands out work to others", async () => {
    db.members = [{ id: "u1", name: "Ana Smith" }, { id: "u2", name: "Bo Diaz" }];
    const { props } = await run({ canAssign: true });
    expect(props.view.kind).toBe("team");
    expect(props.canAssign).toBe(true);
  });

  it("counts the late to-do that's next in the late chip, like the sentence", async () => {
    db.tasks = [task({ dueDate: day("2026-11-12") }), task({ dueDate: day("2026-11-13") }), task({})];
    const { sentence, props } = await run({ canAssign: false });
    expect(sentence).toContain("2 late");
    expect(props.view.late?.count).toBe(2);
  });

  it("counts the calendar's meetings and sales calls over the next 7 days, the same call once", async () => {
    db.events = [
      // Monday: also Dana's sales call to-do, at the same time.
      { id: "e1", title: "Discovery", clientName: "dana lee", attendeeEmail: null, startTime: new Date("2026-11-16T10:00:00Z"), durationMinutes: 30 },
      // Friday: still inside the 7 days on a Saturday.
      { id: "e2", title: "Demo", clientName: "Kim Park", attendeeEmail: null, startTime: new Date("2026-11-20T09:00:00Z"), durationMinutes: 30 },
      // Next Saturday: the 8th day.
      { id: "e3", title: "Review", clientName: "Lou", attendeeEmail: null, startTime: new Date("2026-11-21T09:00:00Z"), durationMinutes: 30 },
    ];
    db.tasks = [task({ type: "sales_call", dueDate: day("2026-11-16"), dueTime: "10:00" })];
    const { sentence } = await run({ canAssign: true });
    expect(sentence).toContain("2 meetings in the next 7 days");
  });

  it("counts the same way while looking at the team", async () => {
    db.members = [{ id: "u1", name: "Ana Smith" }, { id: "u2", name: "Bo Diaz" }];
    db.events = [{ id: "e1", title: "Discovery", clientName: "Someone", attendeeEmail: "DANA@northgate.io", startTime: new Date("2026-11-16T10:00:00Z"), durationMinutes: 30 }];
    db.tasks = [task({ type: "sales_call", dueDate: day("2026-11-16"), dueTime: "10:00" }), task({ type: "sales_call", dueDate: day("2026-11-17"), dueTime: null })];
    const { sentence, props } = await run({ canAssign: true });
    expect(props.view.kind).toBe("team");
    expect(sentence).toContain("2 meetings in the next 7 days");
  });

  it("gives a rep their sales calls, without reading the workspace calendar", async () => {
    db.events = [{ id: "e1", title: "Board", clientName: null, attendeeEmail: null, startTime: new Date("2026-11-16T10:00:00Z"), durationMinutes: 30 }];
    db.tasks = [task({ type: "sales_call", dueDate: day("2026-11-17"), dueTime: "11:00" })];
    const { sentence } = await run({ canAssign: false });
    expect(sentence).toContain("1 meeting in the next 7 days");
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });
});
