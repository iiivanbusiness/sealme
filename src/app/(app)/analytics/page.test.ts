import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { prisma, me } = vi.hoisted(() => ({
  prisma: {
    phoneCall: { count: vi.fn(), groupBy: vi.fn() },
    contract: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  me: { id: "u1", canViewAll: false },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: async () => ({ id: me.id, workspaceId: "w1", role: { canViewAllDeals: me.canViewAll } }) }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: {}, canViewAll: me.canViewAll, userId: me.id }) }));

import AnalyticsPage from "./page";

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const render = async (period?: string) => renderToStaticMarkup(await AnalyticsPage({ searchParams: Promise.resolve({ period }) }));
// Text only, so a number split from its word by markup still matches.
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

// The calls in the workspace. The page counts them in the database: one
// groupBy per person and connected or not, one count per week or month. A
// groupBy by leadId asks for leads' first calls, answered from firstCalls.
type Call = { startedAt: Date; connected: boolean; userId: string | null };
let calls: Call[] = [];
let firstCalls: unknown[] = [];
const inRange = (c: Call, r: { gte: Date; lt?: Date }) => c.startedAt >= r.gte && (!r.lt || c.startedAt < r.lt);
const callGroupBy = () => prisma.phoneCall.groupBy.mock.calls.map((c) => c[0]).find((a) => !a.by.includes("leadId"));
const firstCallGroupBy = () => prisma.phoneCall.groupBy.mock.calls.map((c) => c[0]).find((a) => a.by.includes("leadId"));

// The page asks for proposals, contracts sent and signed contracts in that order.
function contracts(o: { proposals?: unknown[]; sent?: unknown[]; signed?: unknown[] }) {
  prisma.contract.findMany
    .mockResolvedValueOnce(o.proposals ?? [])
    .mockResolvedValueOnce(o.sent ?? [])
    .mockResolvedValueOnce(o.signed ?? []);
}
const signedContract = (owner: string | null, fee: string, signedDaysAgo: number, extra: Record<string, unknown> = {}) => ({
  signedAt: daysAgo(signedDaysAgo),
  sentAt: daysAgo(signedDaysAgo + 2),
  deal: { ownerId: owner, feeDisplay: fee, source: "local", leadId: null, lead: null, ...extra },
});

describe("Analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    me.id = "u1";
    me.canViewAll = false;
    calls = [];
    firstCalls = [];
    prisma.phoneCall.count.mockImplementation(async ({ where }) => calls.filter((c) => inRange(c, where.startedAt)).length);
    prisma.phoneCall.groupBy.mockImplementation(async ({ by, where }) => {
      if (by.includes("leadId")) return firstCalls;
      const groups = new Map<string, { userId: string | null; connected: boolean; _count: { _all: number } }>();
      for (const c of calls.filter((c) => inRange(c, where.startedAt))) {
        const key = `${c.userId}:${c.connected}`;
        const group = groups.get(key) ?? { userId: c.userId, connected: c.connected, _count: { _all: 0 } };
        group._count._all++;
        groups.set(key, group);
      }
      return [...groups.values()];
    });
    prisma.user.findMany.mockResolvedValue([]);
  });

  it("shows a rep only their own calls and deals, without trash or imports", async () => {
    contracts({});
    await render();

    const callWhere = callGroupBy().where;
    expect(callWhere).toMatchObject({ workspaceId: "w1", userId: "u1", status: { in: ["processed", "skipped"] } });
    expect(callWhere.startedAt.gte).toBeInstanceOf(Date);
    for (const [arg] of prisma.phoneCall.count.mock.calls) expect(arg.where).toMatchObject({ workspaceId: "w1", userId: "u1", status: { in: ["processed", "skipped"] } });

    const [proposals, sent, signed] = prisma.contract.findMany.mock.calls.map((c) => c[0].where);
    const scope = { workspaceId: "w1", trashedAt: null, source: { not: "import" }, ownerId: "u1" };
    expect(proposals.deal).toEqual({ ...scope, kind: "proposal" });
    expect(sent.deal).toEqual({ ...scope, kind: { not: "proposal" } });
    expect(signed).toMatchObject({ status: "signed", deal: { ...scope, kind: { not: "proposal" } } });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("shows whoever sees every deal the whole team", async () => {
    me.canViewAll = true;
    contracts({});
    await render();
    expect(callGroupBy().where).not.toHaveProperty("userId");
    for (const [arg] of prisma.phoneCall.count.mock.calls) expect(arg.where).not.toHaveProperty("userId");
    for (const [arg] of prisma.contract.findMany.mock.calls) expect(arg.where.deal).not.toHaveProperty("ownerId");
  });

  it("says so on a new workspace instead of drawing empty bars", async () => {
    contracts({});
    const html = text(await render());
    expect(html).toContain("No calls in the last 30 days");
    expect(html).toContain("Shows once a contract is signed");
    expect(html).toContain("Start a call");
  });

  it("counts calls, views and signatures, and keeps currencies apart", async () => {
    calls = [
      { startedAt: daysAgo(1), connected: true, userId: "u1" },
      { startedAt: daysAgo(2), connected: false, userId: "u1" },
      { startedAt: daysAgo(20), connected: true, userId: "u1" },
      { startedAt: daysAgo(40), connected: true, userId: "u1" }, // before the period
    ];
    contracts({
      proposals: [{ viewedAt: daysAgo(1), deal: { ownerId: "u1" } }, { viewedAt: null, deal: { ownerId: "u1" } }],
      sent: [{ viewedAt: null, deal: { ownerId: "u1" } }],
      signed: [signedContract("u1", "$8,000", 3), signedContract("u1", "$4,500", 5), signedContract("u1", "€2.000", 6)],
    });
    const html = text(await render());
    expect(html).toContain("3 calls");
    expect(html).toContain("2 connected");
    expect(html).toContain("1 viewed (50%)");
    expect(html).toContain("0 opened");
    expect(html).toContain("$12.5K");
    expect(html).toContain("+ €2,000");
    expect(html).toContain("Usually 2 days after sending");
  });

  it("measures days to signature from the lead's first call, skipping renewals", async () => {
    firstCalls = [{ leadId: "l1", _min: { startedAt: daysAgo(14) } }];
    contracts({
      signed: [
        signedContract("u1", "$1,000", 4, { leadId: "l1" }),
        signedContract("u1", "$1,000", 4, { leadId: "l2", lead: { createdAt: daysAgo(10) } }),
        signedContract("u1", "$1,000", 4, { leadId: "l3", source: "renewal", lead: { createdAt: daysAgo(400) } }),
      ],
    });
    const html = text(await render());
    expect(firstCallGroupBy().where).toMatchObject({ workspaceId: "w1", leadId: { in: ["l1", "l2", "l3"] } });
    // 10 days from l1's first call, 6 from when l2 was added: the middle is 8.
    expect(html).toContain("Days to signature 8 From the first call, 2 contracts");
  });

  it("says renewals don't count when only renewals were signed", async () => {
    contracts({ signed: [signedContract("u1", "$1,000", 4, { leadId: "l3", source: "renewal", lead: { createdAt: daysAgo(400) } })] });
    const html = text(await render());
    expect(html).toContain("Days to signature - Renewals don't count here");
    expect(html).not.toContain("No first call on record");
  });

  it("gives no one-person table to someone alone with a removed colleague", async () => {
    me.canViewAll = true;
    prisma.user.findMany.mockResolvedValue([
      { id: "u1", name: "Ana", deactivatedAt: null },
      { id: "u3", name: "Gone Guy", deactivatedAt: daysAgo(100) },
    ]);
    calls = [{ startedAt: daysAgo(1), connected: true, userId: "u1" }];
    contracts({ signed: [signedContract(null, "$3,000", 2)] });
    expect(text(await render())).not.toContain("By person");
  });

  it("keeps a removed colleague who has numbers in the period", async () => {
    me.canViewAll = true;
    prisma.user.findMany.mockResolvedValue([
      { id: "u1", name: "Ana", deactivatedAt: null },
      { id: "u3", name: "Gone Guy", deactivatedAt: daysAgo(3) },
    ]);
    calls = [{ startedAt: daysAgo(10), connected: true, userId: "u3" }];
    contracts({});
    const html = text(await render());
    expect(html).toContain("By person");
    expect(html).toContain("Ana (you)");
    expect(html).toContain("Gone Guy");
  });

  it("gives a manager each person's numbers, ownerless deals on their own row", async () => {
    me.canViewAll = true;
    prisma.user.findMany.mockResolvedValue([
      { id: "u1", name: "Ana", deactivatedAt: null },
      { id: "u2", name: "Bo", deactivatedAt: null },
      { id: "u3", name: "Gone Guy", deactivatedAt: daysAgo(100) },
    ]);
    calls = [{ startedAt: daysAgo(1), connected: true, userId: "u2" }];
    contracts({ signed: [signedContract(null, "$3,000", 2)] });
    const html = text(await render("90d"));
    expect(html).toContain("By person");
    expect(html).toContain("Ana (you)");
    expect(html).toContain("No owner");
    expect(html).not.toContain("Gone Guy");
    expect(html).toContain("No first call on record");
    expect(html).toContain("Calls per week");
  });

  it("switches to months for 12 months", async () => {
    calls = [{ startedAt: daysAgo(1), connected: false, userId: "u1" }];
    contracts({});
    const raw = await render("12m");
    expect(text(raw)).toContain("Calls per month");
    expect(raw).toMatch(/aria-current="page"[^>]*>Last 12 months</);
    expect(callGroupBy().where.startedAt.gte.getUTCDate()).toBe(1);
    expect(prisma.phoneCall.count).toHaveBeenCalledTimes(12);
  });

  it("counts every call, however many, in the database", async () => {
    // More calls than a page could load: the numbers come back already counted.
    prisma.phoneCall.groupBy.mockImplementation(async ({ by }) =>
      by.includes("leadId")
        ? []
        : [
            { userId: "u1", connected: true, _count: { _all: 20_000 } },
            { userId: "u1", connected: false, _count: { _all: 43_000 } },
          ],
    );
    prisma.phoneCall.count.mockResolvedValue(12_600);
    contracts({});
    const raw = await render();
    const html = text(raw);
    expect(html).toContain("63,000 calls");
    expect(html).toContain("20,000 connected");
    expect(html).toContain("12,600");
    // The count beside each bar is wide enough for "12,600".
    expect(raw).toContain("width:max(36px, 6ch)");
  });

  it("counts each week from where the last one ended, the period's start first", async () => {
    calls = [
      { startedAt: daysAgo(0), connected: false, userId: "u1" },
      { startedAt: daysAgo(29), connected: false, userId: "u1" },
    ];
    contracts({});
    await render();
    const ranges = prisma.phoneCall.count.mock.calls.map((c) => c[0].where.startedAt);
    expect(ranges.length).toBeGreaterThanOrEqual(5);
    expect(ranges[0].gte).toEqual(callGroupBy().where.startedAt.gte);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i].gte).toEqual(ranges[i - 1].lt);
    expect(ranges[ranges.length - 1]).not.toHaveProperty("lt");
    // Both calls land in a week: the bars add up to the total.
    const counts = await Promise.all(prisma.phoneCall.count.mock.results.map((r) => r.value));
    expect(counts.reduce((a: number, b: number) => a + b, 0)).toBe(2);
  });

  it("gives a long total a smaller font so it fits the tile", async () => {
    contracts({ signed: [signedContract("u1", "RSD 123,456", 3)] });
    const raw = await render();
    expect(text(raw)).toContain("RSD 123.5K");
    expect(raw).toContain("max-sm:[&amp;_.font-mono-tab]:text-[20px]");

    vi.clearAllMocks();
    contracts({ signed: [signedContract("u1", "$12,345", 3)] });
    const short = await render();
    expect(text(short)).toContain("$12.3K");
    expect(short).not.toContain("text-[20px]");
  });
});
