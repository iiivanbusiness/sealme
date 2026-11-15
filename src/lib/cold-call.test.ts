import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, extract, findLead, leadChanges } = vi.hoisted(() => ({
  db: {
    task: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    phoneCall: { update: vi.fn(), create: vi.fn() },
    lead: { update: vi.fn(), deleteMany: vi.fn() },
    deal: { updateMany: vi.fn() },
    client: { findFirst: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  extract: vi.fn(),
  findLead: vi.fn(),
  leadChanges: vi.fn(() => ({ leadId: "", changed: [], previousStage: null })),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/extract-cold-call", () => ({ extractColdCall: extract }));
vi.mock("@/lib/lead-match", () => ({ findLeadForCall: findLead, mergeList: (a: string | null) => a }));
vi.mock("@/lib/viewer-time", () => ({ dayInZone: () => "2026-11-14" }));
vi.mock("@/lib/webhook-events", () => ({
  dispatchCallCompleted: async () => {},
  dispatchLeadsUpdated: async () => {},
  dispatchMeetingsBooked: async () => {},
  dispatchTasksCompleted: async () => {},
  leadChanges,
}));
vi.mock("@/lib/lead-overview", () => ({ refreshLeadOverview: async () => {} }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline: async () => {}, wentOutWhere: { sentAt: "went out" }, INACTIVE_STAGES: ["lost", "not_now", "not_signed"] }));

import { applyColdCall, leadAfterCall, NEW_LEAD_NAME } from "./cold-call";
import type { Lead } from "@/generated/prisma/client";

// The placeholder lead a live call started on, with the "New client" its
// documents went to.
const placeholder = { id: "l-new", name: NEW_LEAD_NAME, company: null, email: null, phone: null, title: null, summary: null, stage: "new", pipelineStage: "new", convertedClientId: "c-new" } as unknown as Lead;
const heard = {
  outcome: "interested",
  connected: true,
  summary: "Wants five seats",
  notes: null,
  contactName: "Dana Reyes",
  title: null,
  company: "Northwind",
  email: "dana@northwind.test",
  phone: null,
  isDecisionMaker: null,
  interest: null,
  painPoints: null,
  objections: null,
  nextStep: null,
  nextStepDate: null,
  nextStepTime: null,
  usage: { inputTokens: 900, outputTokens: 120, costUsd: 0.0015 },
  raw: { outcome: "interested" },
};

function run() {
  return applyColdCall({ workspaceId: "w1", userId: "u1", lead: placeholder, transcript: "Client: I'm Dana.", timeZone: "UTC", phoneCallId: "pc1", mode: "sales", closesMeeting: true, deferCompleted: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  extract.mockResolvedValue(heard);
  db.task.findFirst.mockResolvedValue(null);
  db.task.findMany.mockResolvedValue([]);
  db.phoneCall.update.mockImplementation(() => ({ id: "pc1" }));
  db.lead.update.mockImplementation(() => ({ id: "lead" }));
  db.deal.updateMany.mockImplementation(() => ({ count: 1 }));
  db.lead.deleteMany.mockImplementation(() => ({ count: 1 }));
  db.$executeRaw.mockImplementation(() => ({ raw: true }));
  db.$transaction.mockImplementation(async (ops: unknown[]) => ops);
  db.client.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === "c-dana" ? { id: "c-dana" } : null));
});

describe("A live call whose placeholder lead turns out to be someone on file", () => {
  it("moves the call's documents to that lead's own client, and drops the duplicate client once nothing has it", async () => {
    findLead.mockResolvedValue({ ...placeholder, id: "l-dana", name: "Dana Reyes", convertedClientId: "c-dana" });

    expect((await run()).leadId).toBe("l-dana");

    expect(db.client.findFirst).toHaveBeenCalledWith({ where: { id: "c-dana", workspaceId: "w1" }, select: { id: true } });
    // A document that already went out keeps its client (its portal link lists it).
    expect(db.deal.updateMany).toHaveBeenCalledWith({
      where: { phoneCallId: "pc1", leadId: "l-new", OR: [{ contract: null }, { contract: { NOT: { sentAt: "went out" } } }] },
      data: { clientId: "c-dana" },
    });
    expect(db.deal.updateMany).toHaveBeenCalledWith({ where: { phoneCallId: "pc1", leadId: "l-new" }, data: { leadId: "l-dana" } });
    const ops = db.$transaction.mock.calls[0][0] as unknown[];
    const [sql, ...values] = db.$executeRaw.mock.calls[0] as [string[], ...unknown[]];
    const text = sql.join("?");
    expect(text).toContain('DELETE FROM "Client"');
    // Only when no deal, no lead, no portal link and no CRM record has it.
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."clientId" = c.id)');
    expect(text).toContain('NOT EXISTS (SELECT 1 FROM "Lead" l WHERE l."convertedClientId" = c.id)');
    expect(text).toContain('"portalToken" IS NULL');
    expect(values).toEqual(["c-new", "w1"]);
    // After the deals move and the placeholder lead goes, in the same transaction.
    const moved = db.deal.updateMany.mock.results[0].value;
    const leadGone = db.lead.deleteMany.mock.results[0].value;
    const clientGone = db.$executeRaw.mock.results[0].value;
    expect(ops.indexOf(moved)).toBeLessThan(ops.indexOf(leadGone));
    expect(ops.indexOf(leadGone)).toBeLessThan(ops.indexOf(clientGone));
  });

  it("brings the placeholder's client along to a lead that has none (or whose client is gone), and keeps it", async () => {
    for (const convertedClientId of [null, "c-deleted"]) {
      vi.clearAllMocks();
      findLead.mockResolvedValue({ ...placeholder, id: "l-dana", name: "Dana Reyes", convertedClientId });

      await run();

      expect(db.deal.updateMany).toHaveBeenCalledTimes(1);
      expect(db.deal.updateMany).toHaveBeenCalledWith({ where: { phoneCallId: "pc1", leadId: "l-new" }, data: { leadId: "l-dana" } });
      expect(db.lead.update.mock.calls[0][0]).toMatchObject({ where: { id: "l-dana" }, data: { convertedClientId: "c-new" } });
      expect(db.$executeRaw).not.toHaveBeenCalled();
    }
  });

  it("leaves a call's model use to the caller, which adds it to what the call already took", async () => {
    findLead.mockResolvedValue(null);

    await run();

    const data = db.phoneCall.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("aiInputTokens");
    expect(data).not.toHaveProperty("aiOutputTokens");
    expect(db.deal.updateMany).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("Where a call puts the lead on the Leads list", () => {
  it("takes a lead that wasn't interested off Active, and brings one set aside back for any other answer", async () => {
    findLead.mockResolvedValue(null);
    extract.mockResolvedValue({ ...heard, outcome: "not_interested" });
    await run();
    expect(db.lead.update.mock.calls[0][0].data).toMatchObject({ stage: "lost", pipelineStage: "lost" });

    // A lead already lost hears "not interested" again: still lost.
    vi.clearAllMocks();
    extract.mockResolvedValue({ ...heard, outcome: "not_interested" });
    await applyColdCall({ workspaceId: "w1", userId: "u1", lead: { ...placeholder, name: "Dana", stage: "lost", pipelineStage: "lost" } as unknown as Lead, transcript: "x", timeZone: "UTC", phoneCallId: "pc1", mode: "sales", closesMeeting: true, deferCompleted: true });
    expect(db.lead.update.mock.calls[0][0].data.pipelineStage).toBe("lost");

    // Interested this time: back on Active.
    vi.clearAllMocks();
    extract.mockResolvedValue(heard);
    await applyColdCall({ workspaceId: "w1", userId: "u1", lead: { ...placeholder, name: "Dana", stage: "lost", pipelineStage: "lost" } as unknown as Lead, transcript: "x", timeZone: "UTC", phoneCallId: "pc1", mode: "sales", closesMeeting: true, deferCompleted: true });
    expect(db.lead.update.mock.calls[0][0].data.pipelineStage).toBe("new");

    // A client stays a client.
    vi.clearAllMocks();
    extract.mockResolvedValue({ ...heard, outcome: "not_interested" });
    await applyColdCall({ workspaceId: "w1", userId: "u1", lead: { ...placeholder, name: "Dana", stage: "converted", pipelineStage: "client", isClient: true } as unknown as Lead, transcript: "x", timeZone: "UTC", phoneCallId: "pc1", mode: "sales", closesMeeting: true, deferCompleted: true });
    expect(db.lead.update.mock.calls[0][0].data).not.toHaveProperty("pipelineStage");
  });
});

describe("Where a call leaves a lead", () => {
  const at = (stage: string, pipelineStage: string, isClient = false) => ({ stage, pipelineStage, isClient });

  it("takes a lead off Active when it's not interested, but never a client", () => {
    expect(leadAfterCall(at("contacted", "proposal_sent"), "not_interested")).toEqual({ stage: "lost", pipelineStage: "lost" });
    expect(leadAfterCall(at("lost", "not_now"), "not_interested")).toEqual({ pipelineStage: "lost" });
    expect(leadAfterCall(at("converted", "client", true), "not_interested")).toEqual({});
  });

  it("brings a set-aside lead back for any other call, and a lost one is contacted unless the call moved it further", () => {
    expect(leadAfterCall(at("lost", "lost"), "voicemail")).toEqual({ stage: "contacted", pipelineStage: "new" });
    expect(leadAfterCall(at("lost", "lost"), null)).toEqual({ stage: "contacted", pipelineStage: "new" });
    expect(leadAfterCall(at("lost", "not_now"), "interested")).toEqual({ stage: "interested", pipelineStage: "new" });
    expect(leadAfterCall(at("contacted", "not_signed"), "no_answer")).toEqual({ pipelineStage: "new" });
    expect(leadAfterCall(at("new", "proposal_sent"), "follow_up")).toEqual({ stage: "contacted" });
    expect(leadAfterCall(at("meeting", "new"), "voicemail")).toEqual({});
  });

  it("makes a lost lead a voicemail brings back contacted for the API too", async () => {
    findLead.mockResolvedValue(null);
    extract.mockResolvedValue({ ...heard, outcome: "voicemail", connected: false });
    const lost = { ...placeholder, name: "Dana", stage: "lost", pipelineStage: "lost" } as unknown as Lead;
    const done = await applyColdCall({ workspaceId: "w1", userId: "u1", lead: lost, transcript: "x", timeZone: "UTC", phoneCallId: "pc1" });
    expect(db.lead.update.mock.calls[0][0].data).toMatchObject({ stage: "contacted", pipelineStage: "new" });
    expect(done.stage).toBe("contacted");
    // lead.updated goes out with the stage change.
    expect(leadChanges).toHaveBeenCalledWith("l-new", lost, expect.objectContaining({ stage: "contacted" }));
  });
});
