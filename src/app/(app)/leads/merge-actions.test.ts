import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, refreshLeadPipeline, syncLeadClient, mergeLeads, dispatchLeadsUpdated } = vi.hoisted(() => ({
  prisma: {
    phoneCall: { findFirst: vi.fn(), count: vi.fn(), update: vi.fn(), delete: vi.fn() },
    deal: { findMany: vi.fn(), updateMany: vi.fn() },
    lead: { findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    task: { updateMany: vi.fn() },
    reviewStep: { deleteMany: vi.fn() },
    contract: { updateMany: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
  refreshLeadPipeline: vi.fn(),
  syncLeadClient: vi.fn(),
  mergeLeads: vi.fn(),
  dispatchLeadsUpdated: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/prospecting", () => ({ requireProspecting: async () => ({ id: "w1" }) }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => ({ canAssign: true, canViewAll: true, userId: "u1", where: {} }) }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: async () => ({ id: "u1", email: "ana@agency.test" }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/lead-merge", () => ({ mergeLeads }));
vi.mock("@/lib/lead-overview", () => ({ refreshLeadOverview: vi.fn() }));
vi.mock("@/lib/extract-cold-call", () => ({ extractColdCall: vi.fn() }));
vi.mock("@/lib/lead-match", () => ({ findLeadForCall: vi.fn(), mergeList: vi.fn() }));
vi.mock("@/lib/viewer-time", () => ({ dayInZone: vi.fn() }));
vi.mock("@/lib/call-inbox", () => ({ dropRecording: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({}));
vi.mock("@/lib/webhook-events", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/webhook-events")>()), dispatchLeadsUpdated }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/lead-pipeline", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/lead-pipeline")>()), refreshLeadPipeline, syncLeadClient }));

import { deleteCall, moveCallToLead } from "./merge-actions";

describe("Deleting a call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.phoneCall.findFirst.mockResolvedValue({ id: "c1", leadId: "l1", dealId: "d1", status: "processed", telnyxRecordingId: null });
  });

  it("goes by the lead page's rule for an old shared pointer: a skipped call doesn't share it", async () => {
    // The only other call pointing at d1 is skipped, so it isn't counted.
    prisma.phoneCall.count.mockResolvedValue(0);
    prisma.deal.findMany.mockResolvedValue([{ id: "d1", kind: "contract", contract: { id: "k1", sentAt: new Date("2026-11-01"), status: "signed" } }]);
    expect(await deleteCall("c1")).toEqual({ error: "The contract from this call went out to the client, so the call stays." });
    expect(prisma.phoneCall.count).toHaveBeenCalledWith({ where: { leadId: "l1", dealId: "d1", id: { not: "c1" }, status: { in: ["processed", "processing", "recording"] } } });
    expect(prisma.deal.findMany.mock.calls[0][0].where.OR).toEqual([{ phoneCallId: "c1" }, { id: "d1", leadId: "l1", phoneCallId: null }]);
    expect(prisma.phoneCall.delete).not.toHaveBeenCalled();
  });

  it("keeps a call whose signed contract never had a send date", async () => {
    prisma.phoneCall.count.mockResolvedValue(0);
    prisma.deal.findMany.mockResolvedValue([{ id: "d1", kind: "contract", contract: { id: "k1", sentAt: null, status: "signed" } }]);
    expect((await deleteCall("c1")).error).toMatch(/went out to the client/);
    expect(prisma.phoneCall.delete).not.toHaveBeenCalled();
  });

  it("leaves a pointer another call that shows shares out of it", async () => {
    prisma.phoneCall.count.mockResolvedValue(1);
    prisma.deal.findMany.mockResolvedValue([]);
    prisma.lead.update.mockResolvedValue({});
    expect(await deleteCall("c1")).toEqual({});
    expect(prisma.deal.findMany.mock.calls[0][0].where.OR).toEqual([{ phoneCallId: "c1" }]);
    expect(prisma.phoneCall.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });
});

describe("Moving a call to another lead", () => {
  const startedAt = new Date("2026-11-05T10:00:00Z");
  const before = new Date("2026-11-01T10:00:00Z");
  const after = new Date("2026-11-10T10:00:00Z");
  type Call = { outcome: string | null; startedAt: Date } | null;
  let outcome: string | null;
  // The newest call left on the lead the call moves off.
  let leftOnSource: Call;

  beforeEach(() => {
    vi.clearAllMocks();
    outcome = null;
    leftOnSource = null;
    prisma.phoneCall.findFirst.mockImplementation(async ({ where, select }: { where: { id?: string; leadId?: string }; select: { outcome?: boolean } }) => {
      if (where.id === "c1") return { id: "c1", leadId: "src", outcome, startedAt, processedAt: null, summary: null, extracted: null };
      if (where.leadId === "src" && select.outcome) return leftOnSource;
      return null;
    });
    prisma.lead.findFirst.mockResolvedValue({ id: "tgt", lastActivityAt: before });
    prisma.lead.create.mockResolvedValue({ id: "made" });
    prisma.deal.updateMany.mockResolvedValue({ count: 0 });
    prisma.lead.update.mockResolvedValue({});
    prisma.lead.updateMany.mockResolvedValue({ count: 1 });
  });

  const targetUpdate = () => prisma.lead.update.mock.calls.at(-1)![0];
  const manual = (over: object = {}) => ({ source: "manual", stage: "contacted", pipelineStage: "new", isClient: false, _count: { phoneCalls: 1 }, ...over });

  it("leaves a lead marked lost after an older call alone", async () => {
    prisma.lead.findFirst.mockResolvedValue({ id: "tgt", lastActivityAt: after });
    prisma.lead.findUnique.mockResolvedValueOnce(manual()).mockResolvedValueOnce({ lastActivityAt: after, stage: "contacted", pipelineStage: "lost", isClient: false });
    await moveCallToLead("c1", "tgt");
    expect(targetUpdate()).toEqual({ where: { id: "tgt" }, data: {} });
  });

  it("brings a set-aside lead back when the call is the newest thing on it", async () => {
    prisma.lead.findUnique.mockResolvedValueOnce(manual()).mockResolvedValueOnce({ lastActivityAt: before, stage: "contacted", pipelineStage: "not_now", isClient: false });
    await moveCallToLead("c1", "tgt");
    expect(targetUpdate()).toEqual({ where: { id: "tgt" }, data: { lastActivityAt: startedAt, pipelineStage: "new" } });
    expect(refreshLeadPipeline).toHaveBeenCalledWith("tgt");
  });

  it("makes a lost lead it brings back contacted for the API, and says so", async () => {
    outcome = "voicemail";
    prisma.lead.findUnique.mockResolvedValueOnce(manual()).mockResolvedValueOnce({ lastActivityAt: before, stage: "lost", pipelineStage: "lost", isClient: false });
    await moveCallToLead("c1", "tgt");
    expect(targetUpdate().data).toEqual({ lastActivityAt: startedAt, stage: "contacted", pipelineStage: "new" });
    expect(dispatchLeadsUpdated).toHaveBeenCalledWith("w1", expect.arrayContaining([{ leadId: "tgt", changed: ["stage"], previousStage: "lost" }]));
  });

  it("takes the lead it goes to off Active when it wasn't interested, and puts the lead it left back", async () => {
    outcome = "not_interested";
    leftOnSource = { outcome: "interested", startedAt: before };
    prisma.lead.findUnique
      .mockResolvedValueOnce(manual({ stage: "lost", pipelineStage: "lost" }))
      .mockResolvedValueOnce({ lastActivityAt: before, stage: "contacted", pipelineStage: "not_now", isClient: false });
    await moveCallToLead("c1", "tgt");
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: "src", isClient: false, pipelineStage: "lost" }, data: { pipelineStage: "new", stage: "contacted" } });
    expect(targetUpdate().data).toEqual({ lastActivityAt: startedAt, stage: "lost", pipelineStage: "lost" });
    // The lead it left: its stage worked out from its documents again.
    expect(refreshLeadPipeline).toHaveBeenCalledWith("src");
    expect(refreshLeadPipeline).toHaveBeenCalledWith("tgt");
    expect(dispatchLeadsUpdated).toHaveBeenCalledWith("w1", [
      { leadId: "src", changed: ["stage"], previousStage: "lost" },
      { leadId: "tgt", changed: ["stage"], previousStage: "contacted" },
    ]);
  });

  it("puts a lead back that has no calls left once its not-interested call moves off", async () => {
    outcome = "not_interested";
    prisma.lead.findUnique.mockResolvedValueOnce(manual({ stage: "lost", pipelineStage: "lost", _count: { phoneCalls: 0 } })).mockResolvedValueOnce({ lastActivityAt: before, stage: "new", pipelineStage: "new", isClient: false });
    await moveCallToLead("c1", "tgt");
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: "src", isClient: false, pipelineStage: "lost" }, data: { pipelineStage: "new", stage: "contacted" } });
  });

  it("leaves the lead it left lost when that was set some other way", async () => {
    outcome = "not_interested";
    const cases: [object, Call][] = [
      // A newer call is on it: lost was set by hand since.
      [manual({ stage: "lost", pipelineStage: "lost" }), { outcome: "voicemail", startedAt: after }],
      // Its own newest call wasn't interested either.
      [manual({ stage: "lost", pipelineStage: "lost" }), { outcome: "not_interested", startedAt: before }],
      // Not now and clients are never touched.
      [manual({ pipelineStage: "not_now" }), { outcome: "interested", startedAt: before }],
      [manual({ stage: "converted", pipelineStage: "client", isClient: true }), null],
    ];
    for (const [source, left] of cases) {
      prisma.lead.updateMany.mockClear();
      leftOnSource = left;
      prisma.lead.findUnique.mockResolvedValueOnce(source).mockResolvedValueOnce({ lastActivityAt: before, stage: "new", pipelineStage: "new", isClient: false });
      await moveCallToLead("c1", "tgt");
      expect(prisma.lead.updateMany, JSON.stringify(source)).not.toHaveBeenCalled();
    }
  });

  it("leaves a client it goes to on Clients when it wasn't interested", async () => {
    outcome = "not_interested";
    prisma.lead.findUnique.mockResolvedValueOnce(manual()).mockResolvedValueOnce({ lastActivityAt: before, stage: "converted", pipelineStage: "client", isClient: true });
    await moveCallToLead("c1", "tgt");
    expect(targetUpdate().data).toEqual({ lastActivityAt: startedAt });
  });

  it("starts a lead made from a not-interested call off Active", async () => {
    outcome = "not_interested";
    prisma.lead.findUnique.mockResolvedValueOnce(manual()).mockResolvedValueOnce({ lastActivityAt: new Date(), stage: "lost", pipelineStage: "lost", isClient: false });
    expect(await moveCallToLead("c1", "new")).toEqual({ leadId: "made" });
    expect(prisma.lead.create.mock.calls[0][0].data).toMatchObject({ stage: "lost", pipelineStage: "lost", source: "call" });
  });

  it("keeps a lead set aside after an older call where it was when the emptied lead merges in", async () => {
    outcome = "interested";
    prisma.lead.findFirst.mockResolvedValue({ id: "tgt", lastActivityAt: after, stage: "contacted", pipelineStage: "not_now" });
    prisma.lead.findUnique
      .mockResolvedValueOnce({ source: "call", stage: "interested", pipelineStage: "new", isClient: false, _count: { phoneCalls: 0 } })
      .mockResolvedValueOnce({ lastActivityAt: after, stage: "interested", pipelineStage: "not_now", isClient: false });
    await moveCallToLead("c1", "tgt");
    expect(mergeLeads).toHaveBeenCalledWith("w1", "src", "tgt");
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: "tgt", isClient: false }, data: { pipelineStage: "not_now" } });
  });

  it("judges the call against the lead it goes to before the lead it left is merged in", async () => {
    outcome = "not_interested";
    // The lead the call made goes into the one it moves to, bringing the
    // time the call was written up as its activity.
    prisma.lead.findUnique
      .mockResolvedValueOnce({ source: "call", stage: "lost", pipelineStage: "lost", isClient: false, _count: { phoneCalls: 0 } })
      .mockResolvedValueOnce({ lastActivityAt: new Date("2026-11-05T10:05:00Z"), stage: "contacted", pipelineStage: "new", isClient: false });
    await moveCallToLead("c1", "tgt");
    expect(mergeLeads).toHaveBeenCalledWith("w1", "src", "tgt");
    expect(targetUpdate().data).toEqual({ stage: "lost", pipelineStage: "lost" });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
});
