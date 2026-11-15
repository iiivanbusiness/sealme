import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, view } = vi.hoisted(() => ({
  // Whether the viewer sees every deal (an owner or manager), and the
  // visibility a rep gets otherwise (see deal-visibility.ts).
  view: { canViewAll: true },
  prisma: {
    contract: { findMany: vi.fn(), count: vi.fn() },
    deal: { findMany: vi.fn() },
    reviewStep: { findMany: vi.fn() },
    phoneCall: { findMany: vi.fn(), count: vi.fn() },
    user: { count: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: async () => ({ id: "u1" }) }));
vi.mock("@/lib/deal-visibility", () => ({
  dealVisibilityFilter: async () => (view.canViewAll ? { where: {}, canViewAll: true, userId: "u1" } : { where: { OR: [{ ownerId: "u1" }, { ownerId: null }] }, canViewAll: false, userId: "u1" }),
}));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: async () => {} }));
vi.mock("@/lib/webhook-events", () => ({ dispatchLeadsUpdated: async () => {}, leadChanges: () => ({}) }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead from a call", PLACEHOLDER_CLIENT: "New client" }));

import { dashboardData } from "./dashboard-data";
import { leadIsInactive } from "./lead-pipeline";
import { needsReminder, stillWaiting, type WaitingDoc } from "./waiting";

const NOW = new Date("2026-11-14T12:00:00Z");
const TZ = "America/New_York";
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600_000);
const me = { id: "u1" } as never;

type Lead = { name: string; email: string | null; isClient: boolean; clientAt?: Date | null; pipelineStage: string; lastActivityAt: Date | null; createdAt: Date; ownerId?: string | null };
// A contract made from the proposal: its deal, and when its contract went out
// (null for a draft nobody sent yet).
type Derived = { trashedAt: Date | null; kind: string; contract: { sentAt: Date | null } | null };

// A contract row the way the Dashboard reads it, plus what the query filters on.
function row(o: { id?: string; kind?: string; status?: string; deliveryMethod?: string; expiresAt?: Date | null; sentAt?: Date; reminderSentAt?: Date | null; ownerId?: string | null; derived?: Derived[]; lead?: Lead | null; lastTalk?: Date } = {}) {
  const lead = o.lead === undefined ? activeLead : o.lead;
  return {
    id: o.id ?? "k1",
    status: o.status ?? "sent",
    sentAt: o.sentAt ?? daysAgo(6),
    viewedAt: null,
    reminderSentAt: o.reminderSentAt ?? null,
    deliveryMethod: o.deliveryMethod ?? "sealme",
    expiresAt: o.expiresAt ?? null,
    deal: {
      id: `d-${o.id ?? "k1"}`,
      workspaceId: "w1",
      trashedAt: null,
      kind: o.kind ?? "proposal",
      service: "Bookkeeping",
      ownerId: o.ownerId === undefined ? "u1" : o.ownerId,
      owner: { name: "Ana" },
      client: { name: "Acme", email: "office@acme.test" },
      leadId: lead ? "lead1" : null,
      // What the query filters on, and the one contract that went out the
      // read keeps (derivedDeals is read with that filter).
      derivedDeals: o.derived ?? [],
      // The latest call where they talked, as the read narrows it.
      lead: lead && { ownerId: "u1", ...lead, phoneCalls: o.lastTalk ? [{ startedAt: o.lastTalk }] : [], deals: [] },
    },
  };
}

const activeLead: Lead = { name: "Priya Shah", email: null, isClient: false, pipelineStage: "proposal_sent", lastActivityAt: daysAgo(3), createdAt: daysAgo(60) };

// Just enough of Prisma's where to run the Dashboard's queries on rows.
function matches(value: unknown, where: Record<string, unknown>): boolean {
  const r = value as Record<string, unknown>;
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Record<string, unknown>[]).every((w) => matches(r, w));
    if (key === "OR") return (cond as Record<string, unknown>[]).some((w) => matches(r, w));
    const v = r[key];
    if (cond === null) return v == null;
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (typeof cond !== "object") return v === cond;
    const c = cond as Record<string, unknown>;
    if ("none" in c) return !(v as unknown[]).some((x) => matches(x, c.none as Record<string, unknown>));
    const ops = ["not", "in", "notIn", "gt", "gte", "lt", "lte"];
    if (Object.keys(c).some((k) => ops.includes(k))) {
      const t = (x: unknown) => (x instanceof Date ? x.getTime() : x) as number;
      return Object.entries(c).every(([op, arg]) => {
        if (op === "not") return arg === null ? v != null : v != null && v !== arg;
        if (v == null) return false;
        if (op === "in") return (arg as unknown[]).includes(v);
        if (op === "notIn") return !(arg as unknown[]).includes(v);
        if (op === "gt") return t(v) > t(arg);
        if (op === "gte") return t(v) >= t(arg);
        if (op === "lt") return t(v) < t(arg);
        return t(v) <= t(arg);
      });
    }
    // A relation: a row, or null when there's none.
    return v != null && matches(v, c);
  });
}

// The same document as dashboardData hands to stillWaiting.
function asDoc(r: ReturnType<typeof row>): WaitingDoc {
  const lead = r.deal.lead;
  return {
    kind: r.deal.kind === "proposal" ? "proposal" : "contract",
    status: r.status,
    sentAt: r.sentAt,
    viewedAt: null,
    reminderSentAt: r.reminderSentAt,
    deliveryMethod: r.deliveryMethod,
    expiresAt: r.expiresAt,
    madeContract: r.deal.derivedDeals.some((d) => d.trashedAt == null && d.kind !== "proposal" && d.contract?.sentAt != null),
    lead: lead && { isClient: lead.isClient, clientAt: lead.clientAt ?? null, inactive: leadIsInactive(lead, NOW), lastCallAt: lead.phoneCalls[0]?.startedAt ?? null, otherDocs: [] },
  };
}

async function load() {
  const result = await dashboardData({ workspaceId: "w1", me, tz: TZ, now: NOW });
  const [sent, due] = prisma.contract.findMany.mock.calls.map((c) => c[0]);
  return { result, sent, due };
}

describe("What the Dashboard reads as out with clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    view.canViewAll = true;
    prisma.contract.findMany.mockResolvedValue([]);
    prisma.contract.count.mockResolvedValue(0);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.reviewStep.findMany.mockResolvedValue([]);
    prisma.phoneCall.findMany.mockResolvedValue([]);
    prisma.phoneCall.count.mockResolvedValue(0);
    prisma.user.count.mockResolvedValue(3);
    prisma.auditLog.findMany.mockResolvedValue([]);
  });

  it("leaves dead proposals out of the query, by the same rules as stillWaiting", async () => {
    const { sent, due } = await load();
    expect(sent.orderBy).toEqual({ sentAt: "asc" });

    const leads: (Lead | null)[] = [
      null,
      activeLead,
      { ...activeLead, isClient: true, pipelineStage: "client" },
      // A client since before both sends (a new offer), and one who signed after.
      { ...activeLead, isClient: true, pipelineStage: "client", clientAt: daysAgo(10) },
      { ...activeLead, isClient: true, pipelineStage: "client", clientAt: daysAgo(1) },
      { ...activeLead, pipelineStage: "lost" },
      { ...activeLead, pipelineStage: "not_now" },
      { ...activeLead, pipelineStage: "not_signed" },
      { ...activeLead, lastActivityAt: daysAgo(40) },
      { ...activeLead, lastActivityAt: null, createdAt: daysAgo(40) },
      { ...activeLead, lastActivityAt: null, createdAt: daysAgo(2) },
    ];
    const derived: Derived[][] = [
      [],
      [{ trashedAt: null, kind: "contract", contract: { sentAt: daysAgo(1) } }],
      // A draft made from the proposal that nobody sent yet.
      [{ trashedAt: null, kind: "contract", contract: { sentAt: null } }],
      [{ trashedAt: null, kind: "contract", contract: null }],
      [{ trashedAt: daysAgo(1), kind: "contract", contract: { sentAt: daysAgo(2) } }],
      [{ trashedAt: null, kind: "proposal", contract: { sentAt: daysAgo(1) } }],
    ];
    let checked = 0;
    let kept = 0;
    for (const kind of ["proposal", "contract"])
      for (const status of ["sent", "partially_signed", "draft", "expired", "not_signed"])
        for (const deliveryMethod of ["sealme", "docusign"])
          for (const expiresAt of [null, daysAgo(1), daysAgo(-3)])
            for (const d of derived)
              for (const lead of leads)
                for (const sentAt of [daysAgo(3), daysAgo(6)])
                  for (const reminderSentAt of [null, daysAgo(2), daysAgo(6)]) {
                    const r = row({ kind, status, deliveryMethod, expiresAt, derived: d, lead, sentAt, reminderSentAt });
                    const doc = asDoc(r);
                    const label = JSON.stringify({ kind, status, deliveryMethod, expiresAt, d, lead, sentAt, reminderSentAt });
                    // The query can't tell a client who signed after the send
                    // from one who signed before, so it keeps both and
                    // stillWaiting drops this one.
                    if (lead?.clientAt && lead.clientAt > sentAt && kind === "proposal") {
                      expect([label, stillWaiting(doc, NOW), needsReminder(doc, NOW, 5, TZ)]).toEqual([label, false, false]);
                      continue;
                    }
                    expect([label, matches(r, sent.where)]).toEqual([label, stillWaiting(doc, NOW)]);
                    expect([label, matches(r, due.where)]).toEqual([label, needsReminder(doc, NOW, 5, TZ)]);
                    checked++;
                    if (stillWaiting(doc, NOW)) kept++;
                  }
    expect(checked).toBeGreaterThan(1000);
    expect(kept).toBeGreaterThan(0);
  });

  it("only asks about the viewer's own proposals for reminders", async () => {
    const { due } = await load();
    expect(matches(row({ sentAt: daysAgo(8), ownerId: "u2" }), due.where)).toBe(false);
    expect(matches(row({ sentAt: daysAgo(8) }), due.where)).toBe(true);
  });

  it("asks whoever owns the lead about a proposal with no owner, else someone who sees every deal", async () => {
    const unowned = (lead: Lead | null) => row({ sentAt: daysAgo(8), ownerId: null, lead });
    let { due, sent } = await load();
    expect(matches(unowned({ ...activeLead, ownerId: "u1" }), due.where)).toBe(true);
    expect(matches(unowned({ ...activeLead, ownerId: "u2" }), due.where)).toBe(false);
    // Nobody owns the lead either (or there's none): the people who see every deal.
    expect(matches(unowned({ ...activeLead, ownerId: null }), due.where)).toBe(true);
    expect(matches(unowned(null), due.where)).toBe(true);
    // On the team's list either way.
    expect(matches(unowned({ ...activeLead, ownerId: "u2" }), sent.where)).toBe(true);

    vi.clearAllMocks();
    view.canViewAll = false;
    ({ due, sent } = await load());
    expect(matches(unowned({ ...activeLead, ownerId: "u1" }), due.where)).toBe(true);
    expect(matches(unowned({ ...activeLead, ownerId: "u1" }), sent.where)).toBe(true);
    expect(matches(unowned({ ...activeLead, ownerId: null }), due.where)).toBe(false);
    expect(matches(unowned(null), due.where)).toBe(false);
    expect(matches(unowned({ ...activeLead, ownerId: "u2" }), sent.where)).toBe(false);
    expect(matches(row({ sentAt: daysAgo(8), ownerId: "u2" }), sent.where)).toBe(false);
  });

  it("waits on a new offer to someone who was already a client, and asks for a reminder", async () => {
    const client = { ...activeLead, isClient: true, pipelineStage: "client", clientAt: daysAgo(40) };
    const upsell = row({ id: "upsell", sentAt: daysAgo(8), lead: client });
    prisma.contract.findMany.mockResolvedValue([upsell]);
    const { result, sent, due } = await load();
    expect(matches(upsell, sent.where)).toBe(true);
    expect(matches(upsell, due.where)).toBe(true);
    expect(result.waiting!.rows.map((r) => r.dealId)).toEqual(["d-upsell"]);
    expect(result.needs.reminders.rows.map((r) => r.dealId)).toEqual(["d-upsell"]);
    expect(sent.select.deal.select.lead.select.clientAt).toBe(true);
  });

  it("keeps a proposal waiting while the contract made from it is only a draft", async () => {
    const { sent } = await load();
    const draft = row({ derived: [{ trashedAt: null, kind: "contract", contract: { sentAt: null } }] });
    const out = row({ derived: [{ trashedAt: null, kind: "contract", contract: { sentAt: daysAgo(1) } }] });
    expect(matches(draft, sent.where)).toBe(true);
    expect(matches(out, sent.where)).toBe(false);
    expect(stillWaiting(asDoc(draft), NOW)).toBe(true);
    expect(stillWaiting(asDoc(out), NOW)).toBe(false);
  });

  it("only counts a call where they talked as hearing back", async () => {
    const { sent } = await load();
    const calls = sent.select.deal.select.lead.select.phoneCalls;
    expect(calls).toMatchObject({ orderBy: { startedAt: "desc" }, take: 1 });
    const talked = (call: Record<string, unknown>) => matches(call, calls.where);
    expect(talked({ status: "processed", connected: true })).toBe(true);
    // No answer or voicemail, a call that never got through, one still ringing.
    expect(talked({ status: "processed", connected: false, outcome: "no_answer" })).toBe(false);
    expect(talked({ status: "skipped", connected: false })).toBe(false);
    expect(talked({ status: "failed", connected: false })).toBe(false);
    expect(talked({ status: "dialing", connected: false })).toBe(false);
    expect(talked({ status: "discarded", connected: true })).toBe(false);
  });

  it("puts the longest silence on top and counts the days from the last thing that happened", async () => {
    prisma.contract.findMany.mockResolvedValueOnce([
      // Read oldest send first, as the query orders them.
      row({ id: "called", sentAt: daysAgo(10), lastTalk: daysAgo(1) }),
      row({ id: "reminded", sentAt: daysAgo(8), reminderSentAt: daysAgo(2) }),
      row({ id: "quiet", sentAt: daysAgo(6) }),
      row({ id: "early-call", sentAt: daysAgo(4), lastTalk: daysAgo(9) }),
    ]);
    const { result } = await load();
    const rows = result.waiting!.rows.map((r) => ({ id: r.dealId, days: r.days, calledDays: r.calledDays, remindedDays: r.remindedDays }));
    expect(rows).toEqual([
      { id: "d-quiet", days: 6, calledDays: null, remindedDays: null },
      // A call before the send isn't said on the row, and doesn't count.
      { id: "d-early-call", days: 4, calledDays: null, remindedDays: null },
      { id: "d-reminded", days: 2, calledDays: null, remindedDays: 2 },
      { id: "d-called", days: 1, calledDays: 1, remindedDays: null },
    ]);
  });

  it("lists the longest out first and counts the ones past the window", async () => {
    const team = Array.from({ length: 500 }, (_, i) => row({ id: `k${i}`, kind: "contract", ownerId: "u2", sentAt: daysAgo(40 - i * 0.05) }));
    prisma.contract.findMany.mockResolvedValueOnce(team);
    prisma.contract.count.mockImplementation(async ({ where }) => (where === prisma.contract.findMany.mock.calls[0][0].where ? 620 : 0));

    const { result } = await load();
    expect(result.waiting!.rows).toHaveLength(50);
    expect(result.waiting!.rows[0].dealId).toBe("d-k0");
    expect(result.waiting!.rows[0].owner).toBe("Ana");
    // 500 read, 120 more past them, 50 shown.
    expect(result.waiting!.more).toBe(570);
  });

  it("doesn't count when the window isn't full", async () => {
    prisma.contract.findMany.mockResolvedValueOnce([row({ kind: "contract" })]);
    const { result } = await load();
    expect(result.waiting!.more).toBe(0);
    expect(prisma.contract.count).not.toHaveBeenCalled();
  });

  it("finds the viewer's proposal due a reminder even when the team's list is full", async () => {
    const team = Array.from({ length: 500 }, (_, i) => row({ id: `k${i}`, kind: "contract", ownerId: "u2", sentAt: daysAgo(3) }));
    prisma.contract.findMany.mockResolvedValueOnce(team).mockResolvedValueOnce([row({ id: "mine", sentAt: daysAgo(20) })]);
    prisma.contract.count.mockResolvedValue(500);

    const { result } = await load();
    expect(result.needs.reminders.rows).toEqual([{ dealId: "d-mine", contractId: "mine", name: "Priya Shah", quietDays: 20, opened: false, to: "office@acme.test" }]);
    expect(result.needs.reminders.more).toBe(0);
  });

  it("asks whoever owns the lead about a contract with no owner that's ready to send, else someone who sees every deal", async () => {
    const ready = (ownerId: string | null, leadOwner: string | null | undefined) => ({
      workspaceId: "w1",
      trashedAt: null,
      kind: "contract",
      status: "ready",
      ownerId,
      leadId: leadOwner === undefined ? null : "lead1",
      lead: leadOwner === undefined ? null : { ownerId: leadOwner },
    });
    await load();
    let where = prisma.deal.findMany.mock.calls[0][0].where;
    expect(matches(ready("u1", "u2"), where)).toBe(true);
    expect(matches(ready("u2", "u1"), where)).toBe(false);
    expect(matches(ready(null, "u1"), where)).toBe(true);
    expect(matches(ready(null, "u2"), where)).toBe(false);
    expect(matches(ready(null, null), where)).toBe(true);
    expect(matches(ready(null, undefined), where)).toBe(true);
    expect(matches({ ...ready("u1", null), status: "sent" }, where)).toBe(false);

    vi.clearAllMocks();
    view.canViewAll = false;
    await load();
    where = prisma.deal.findMany.mock.calls[0][0].where;
    expect(matches(ready("u1", null), where)).toBe(true);
    expect(matches(ready(null, "u1"), where)).toBe(true);
    expect(matches(ready(null, "u2"), where)).toBe(false);
    expect(matches(ready(null, null), where)).toBe(false);
    expect(matches(ready(null, undefined), where)).toBe(false);
  });

  it("reads nothing about documents on the iPhone app", async () => {
    const result = await dashboardData({ workspaceId: "w1", me, tz: TZ, now: NOW, phone: true });
    expect(prisma.contract.findMany).not.toHaveBeenCalled();
    expect(result.waiting).toBeNull();
  });
});
