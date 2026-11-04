import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, email } = vi.hoisted(() => ({
  db: { deal: { findMany: vi.fn(), updateMany: vi.fn() } },
  email: { sendStaleDealsEmail: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/email", () => email);

import { runStaleDealsDigest } from "./stale-deals";

const DAY_MS = 24 * 60 * 60 * 1000;
const user = (id: string, canViewAllDeals = false) => ({ id, email: `${id}@acme.test`, role: { canViewAllDeals } });
const users = [user("admin", true), user("rep1"), user("rep2")];
const deal = (id: string, ownerId: string | null, workspaceUsers = users) => ({
  id,
  ownerId,
  workspaceId: "w1",
  service: "Retainer",
  updatedAt: new Date(Date.now() - 10 * DAY_MS),
  client: { name: `Client ${id}` },
  workspace: { users: workspaceUsers },
});
const sentTo = () => Object.fromEntries(email.sendStaleDealsEmail.mock.calls.map(([o]) => [o.to.join(","), o.deals.map((d: { clientName: string }) => d.clientName)]));

describe("Stale-deals digest", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    db.deal.updateMany.mockResolvedValue({ count: 1 });
    email.sendStaleDealsEmail.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("leaves out trashed deals and inactive users", async () => {
    db.deal.findMany.mockResolvedValue([]);
    await runStaleDealsDigest();
    const query = db.deal.findMany.mock.calls[0][0];
    expect(query.where.trashedAt).toBeNull();
    expect(query.include.workspace.include.users).toEqual({ where: { deactivatedAt: null }, include: { role: true } });
  });

  it("sends each person only the deals they may open", async () => {
    db.deal.findMany.mockResolvedValue([deal("a", "rep1"), deal("b", null), deal("c", "rep2")]);
    const result = await runStaleDealsDigest();
    expect(sentTo()).toEqual({
      "admin@acme.test": ["Client a", "Client b", "Client c"],
      "rep1@acme.test": ["Client a", "Client b"],
      "rep2@acme.test": ["Client b", "Client c"],
    });
    expect(result).toEqual({ checked: 3, sent: 3 });
  });

  it("skips people with nothing to see, and doesn't mark a deal nobody got", async () => {
    // Owned by someone no longer active, in a workspace where nobody sees everything.
    const team = [user("rep1"), user("rep2")];
    db.deal.findMany.mockResolvedValue([deal("a", "rep1", team), deal("x", "gone", team)]);
    const result = await runStaleDealsDigest();
    expect(sentTo()).toEqual({ "rep1@acme.test": ["Client a"] });
    expect(db.deal.updateMany.mock.calls.map(([q]) => q.where.id)).toEqual(["a"]);
    expect(result).toEqual({ checked: 2, sent: 1 });
  });

  it("marks a deal once someone got it, without counting the nudge as activity", async () => {
    const d = deal("a", "rep1");
    db.deal.findMany.mockResolvedValue([d]);
    email.sendStaleDealsEmail.mockImplementation(async ({ to }: { to: string[] }) => {
      if (to[0] === "admin@acme.test") throw new Error("bounced");
    });
    await runStaleDealsDigest();
    expect(db.deal.updateMany).toHaveBeenCalledTimes(1);
    expect(db.deal.updateMany).toHaveBeenCalledWith({ where: { id: "a", updatedAt: d.updatedAt }, data: { staleReminderSentAt: expect.any(Date), updatedAt: d.updatedAt } });
  });

  it("marks nothing when every send fails", async () => {
    db.deal.findMany.mockResolvedValue([deal("a", "rep1")]);
    email.sendStaleDealsEmail.mockRejectedValue(new Error("down"));
    const result = await runStaleDealsDigest();
    expect(db.deal.updateMany).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
  });
});
