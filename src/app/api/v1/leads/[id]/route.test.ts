import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, refreshLeadPipeline, dispatchLeadsUpdated } = vi.hoisted(() => ({
  db: { lead: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() }, user: { findFirst: vi.fn() } },
  refreshLeadPipeline: vi.fn(),
  dispatchLeadsUpdated: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/webhooks", () => ({ scheduleWebhookRetries: () => {}, dispatchWebhookEvent: vi.fn() }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  apiGuard: async () => ({ workspaceId: "w1", apiKeyId: "k1", access: "read_write" }),
}));
vi.mock("@/lib/webhook-events", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/webhook-events")>()), dispatchLeadsUpdated }));
vi.mock("@/lib/lead-pipeline", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/lead-pipeline")>()), refreshLeadPipeline }));

import { GET, PATCH } from "./route";

const at = new Date("2026-10-01T12:00:00Z");
// A lead the way the database gives it back, with everything the API shows.
function row(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    externalId: null,
    campaign: null,
    name: "Sam Rivera",
    company: "Acme Freight",
    title: null,
    email: "sam@example.com",
    phone: null,
    domain: null,
    stage: "contacted",
    pipelineStage: "new",
    isClient: false,
    interest: null,
    isDecisionMaker: null,
    painPoints: null,
    objections: null,
    nextStep: null,
    nextStepAt: null,
    summary: null,
    notes: null,
    source: "api",
    lastContactedAt: null,
    convertedDealId: null,
    convertedAt: null,
    createdAt: at,
    updatedAt: at,
    owner: null,
    ...over,
  };
}
const client = (over: Record<string, unknown> = {}) => row({ stage: "converted", pipelineStage: "client", isClient: true, convertedAt: at, convertedDealId: "d1", ...over });

const params = { params: Promise.resolve({ id: "l1" }) };
function patch(body: Record<string, unknown>) {
  return PATCH(new Request("https://app.test/api/v1/leads/l1", { method: "PATCH", headers: { authorization: "Bearer sk" }, body: JSON.stringify(body) }), params);
}
// The lead before the change, then as the API reads it back after.
function leadIs(before: ReturnType<typeof row>, after: ReturnType<typeof row> = before) {
  db.lead.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
}

beforeEach(() => {
  vi.clearAllMocks();
  // An error leaves the read-back unused: don't let it carry over.
  db.lead.findFirst.mockReset();
  db.lead.update.mockResolvedValue({});
  db.lead.updateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/v1/leads/{id}", () => {
  it("shows where the lead is on the Leads list, and whether it's a client", async () => {
    db.lead.findFirst.mockResolvedValueOnce(client());
    const res = await GET(new Request("https://app.test/api/v1/leads/l1"), params);
    expect(await res.json()).toMatchObject({ id: "l1", stage: "converted", pipelineStage: "client", isClient: true });
  });
});

describe("PATCH /api/v1/leads/{id}", () => {
  it("takes a lead marked lost off Active, only while it isn't a client", async () => {
    leadIs(row(), row({ stage: "lost", pipelineStage: "lost" }));
    const res = await patch({ stage: "lost" });
    expect(res.status).toBe(200);
    expect(db.lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1", isClient: false }, data: { stage: "lost", convertedAt: null, pipelineStage: "lost" } });
    expect(db.lead.update).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ stage: "lost", pipelineStage: "lost", isClient: false });
    expect(dispatchLeadsUpdated).toHaveBeenCalledWith("w1", [{ leadId: "l1", changed: ["stage"], previousStage: "contacted" }]);
  });

  it("leaves a client converted when a sync sends it lost, and answers with the lead as it is", async () => {
    leadIs(client());
    const res = await patch({ stage: "lost" });
    expect(res.status).toBe(200);
    expect(db.lead.updateMany).not.toHaveBeenCalled();
    expect(db.lead.update).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ stage: "converted", pipelineStage: "client", isClient: true });
    expect(dispatchLeadsUpdated).toHaveBeenCalledWith("w1", [{ leadId: "l1", changed: [], previousStage: null }]);
  });

  it("still writes the other fields when a signature lands just before a stage", async () => {
    leadIs(row(), client({ notes: "Went with a competitor" }));
    db.lead.updateMany.mockResolvedValue({ count: 0 });
    const res = await patch({ stage: "lost", notes: "Went with a competitor" });
    expect(res.status).toBe(200);
    expect(db.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { notes: "Went with a competitor" } });
    expect(await res.json()).toMatchObject({ stage: "converted", pipelineStage: "client", notes: "Went with a competitor" });
  });

  it("ignores any other stage for a client and keeps its other changes", async () => {
    leadIs(client(), client({ nextStep: "Renewal call" }));
    const res = await patch({ stage: "meeting", nextStep: "Renewal call" });
    expect(res.status).toBe(200);
    expect(db.lead.updateMany).not.toHaveBeenCalled();
    expect(db.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { nextStep: "Renewal call" } });
    expect(await res.json()).toMatchObject({ stage: "converted", nextStep: "Renewal call", isClient: true });
    expect(dispatchLeadsUpdated).toHaveBeenCalledWith("w1", [{ leadId: "l1", changed: ["nextStep"], previousStage: null }]);
  });

  it("still changes a client's other fields", async () => {
    leadIs(client(), client({ phone: "+12025550161" }));
    const res = await patch({ phone: "+1 202 555 0161", stage: "converted" });
    expect(res.status).toBe(200);
    // Already converted: when stays when it was.
    expect(db.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { phone: "+12025550161", stage: "converted", convertedAt: at } });
    expect(await res.json()).toMatchObject({ phone: "+12025550161", stage: "converted", isClient: true });
  });

  it("brings a lost lead back to Active on a working stage, then works out its real stage", async () => {
    leadIs(row({ stage: "lost", pipelineStage: "lost" }), row({ stage: "contacted", pipelineStage: "proposal_sent" }));
    const res = await patch({ stage: "contacted" });
    expect(res.status).toBe(200);
    expect(db.lead.updateMany).toHaveBeenCalledWith({
      where: { id: "l1", isClient: false },
      data: { stage: "contacted", convertedAt: null, pipelineStage: "new", lastActivityAt: expect.any(Date) },
    });
    expect(refreshLeadPipeline).toHaveBeenCalledWith("l1");
    expect(db.lead.updateMany.mock.invocationCallOrder[0]).toBeLessThan(refreshLeadPipeline.mock.invocationCallOrder[0]);
    // What the refresh found (a proposal still out), not the "new" it started from.
    expect(await res.json()).toMatchObject({ stage: "contacted", pipelineStage: "proposal_sent" });
  });

  it("leaves a lead set aside for later when the stage it already has comes again", async () => {
    leadIs(row({ stage: "contacted", pipelineStage: "not_now" }));
    const res = await patch({ stage: "contacted" });
    expect(res.status).toBe(200);
    expect(db.lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1", isClient: false }, data: { stage: "contacted", convertedAt: null } });
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ pipelineStage: "not_now" });
  });

  it("only records converted on a lead that isn't a client", async () => {
    leadIs(row({ pipelineStage: "contract_sent" }), row({ stage: "converted", pipelineStage: "contract_sent", convertedAt: at }));
    const res = await patch({ stage: "converted" });
    expect(res.status).toBe(200);
    expect(db.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: { stage: "converted", convertedAt: expect.any(Date) } });
    expect(db.lead.updateMany).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ stage: "converted", pipelineStage: "contract_sent", isClient: false });
  });
});
