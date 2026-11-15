import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    lead: { findMany: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn() },
    phoneCall: { findMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    contract: { findMany: vi.fn(), updateMany: vi.fn() },
    deal: { updateMany: vi.fn() },
    reviewStep: { deleteMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/prospecting", () => ({ requireProspecting: async () => ({ id: "w1" }) }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => ({ canAssign: true, canViewAll: true, userId: "u1", where: {} }) }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: async () => ({ id: "u1", email: "ana@agency.test" }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchLeadsCreated: vi.fn(), dispatchWebhookEvent: vi.fn() }));
vi.mock("@/lib/webhook-events", () => ({ dispatchLeadsUpdated: vi.fn(), leadChanges: vi.fn() }));
vi.mock("@/lib/call-inbox", () => ({ dropRecording: vi.fn() }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));

import { deleteLead, deleteLeads, reactivateLead } from "./actions";

const row = (id: string, over: { isClient?: boolean; deals?: object[]; phoneCalls?: object[] } = {}) => ({ id, isClient: false, deals: [], phoneCalls: [], ...over });

describe("Deleting leads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.phoneCall.findMany.mockResolvedValue([]);
    prisma.contract.findMany.mockResolvedValue([]);
  });

  it("keeps clients and leads whose proposal or contract went out, and deletes the rest", async () => {
    prisma.lead.findMany.mockResolvedValue([
      // A client brought in from Settings: signed, but never sent through SealMe.
      row("client", { isClient: true }),
      row("sent", { deals: [{ id: "d1" }] }),
      row("busy", { phoneCalls: [{ id: "c1" }] }),
      row("plain"),
    ]);
    const result = await deleteLeads(["client", "sent", "busy", "plain"]);
    expect(result).toEqual({ deleted: 1, kept: 3, keptClients: 1 });
    expect(prisma.lead.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["plain"] } } });
    // A signed or expired contract counts even without a send date.
    expect(prisma.lead.findMany.mock.calls[0][0].select.deals.where).toEqual({
      contract: { OR: [{ sentAt: { not: null } }, { status: { in: ["sent", "partially_signed", "signed", "expired", "not_signed"] } }] },
    });
  });

  it("deletes nothing (and trashes nothing) when every lead is kept", async () => {
    prisma.lead.findMany.mockResolvedValue([row("client", { isClient: true })]);
    expect(await deleteLeads(["client"])).toEqual({ deleted: 0, kept: 1, keptClients: 1 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.deal.updateMany).not.toHaveBeenCalled();
  });

  it("tells the rep why a lead was kept", async () => {
    prisma.phoneCall.count.mockResolvedValue(0);
    prisma.lead.findMany.mockResolvedValueOnce([row("l1", { isClient: true })]);
    expect((await deleteLead("l1")).error).toMatch(/is a client/);

    prisma.lead.findMany.mockResolvedValueOnce([row("l1", { deals: [{ id: "d1" }] })]);
    expect((await deleteLead("l1")).error).toMatch(/went out to the client.*Mark it as lost/);

    prisma.phoneCall.count.mockResolvedValueOnce(1);
    prisma.lead.findMany.mockResolvedValueOnce([row("l1", { isClient: true, phoneCalls: [{ id: "c1" }] })]);
    expect((await deleteLead("l1")).error).toMatch(/still going/);
  });
});

describe("Reactivating a lead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.lead.updateMany.mockResolvedValue({ count: 1 });
  });

  it("brings a lead back from Lost, Not now and Not signed to New, as active today", async () => {
    for (const pipelineStage of ["lost", "not_now", "not_signed"]) {
      prisma.lead.update.mockClear();
      prisma.lead.findFirst.mockResolvedValueOnce({ stage: "contacted", pipelineStage });
      // Its old contract went unsigned: once it's active again that's history.
      prisma.lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "new", deals: [{ kind: "contract", contract: { status: "not_signed", sentAt: new Date() } }] });
      await reactivateLead("l1");
      expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { lastActivityAt: expect.any(Date), stage: "contacted", pipelineStage: "new" } });
    }
    // The refresh found nothing out with the client, so New it stays.
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();

    // Lost for the API too: back to contacted.
    prisma.lead.findFirst.mockResolvedValueOnce({ stage: "lost", pipelineStage: "lost" });
    prisma.lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "new", deals: [] });
    await reactivateLead("l1");
    expect(prisma.lead.update).toHaveBeenLastCalledWith({ where: { id: "l1" }, data: { lastActivityAt: expect.any(Date), stage: "contacted", pipelineStage: "new" } });
  });

  it("leaves where a lead stands when it was only idle", async () => {
    prisma.lead.findFirst.mockResolvedValueOnce({ stage: "contacted", pipelineStage: "proposal_sent" });
    prisma.lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "proposal_sent", deals: [{ kind: "proposal", contract: { status: "sent", sentAt: new Date() } }] });
    await reactivateLead("l1");
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { lastActivityAt: expect.any(Date), stage: "contacted" } });
  });

  it("turns away a lead it can't find", async () => {
    prisma.lead.findFirst.mockResolvedValueOnce(null);
    await expect(reactivateLead("l1")).rejects.toThrow("Lead not found");
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});
