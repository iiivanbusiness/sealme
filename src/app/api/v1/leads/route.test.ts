import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, dispatchLeadsCreated } = vi.hoisted(() => ({
  db: { lead: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() }, user: { findFirst: vi.fn() } },
  dispatchLeadsCreated: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/webhooks", () => ({ scheduleWebhookRetries: () => {}, dispatchWebhookEvent: vi.fn(), dispatchLeadsCreated }));
vi.mock("@/lib/webhook-events", () => ({ dispatchLeadsUpdated: vi.fn(), leadChanges: vi.fn() }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  apiGuard: async () => ({ workspaceId: "w1", apiKeyId: "k1", access: "read_write" }),
}));

import { GET, POST } from "./route";

const at = new Date("2026-10-01T12:00:00Z");
// A lead the way the database gives it back, with everything the API shows.
function row(over: Record<string, unknown> = {}) {
  return {
    id: "l1",
    externalId: null,
    campaign: null,
    name: "Sam Rivera",
    company: null,
    title: null,
    email: null,
    phone: null,
    domain: null,
    stage: "new",
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

const list = (query: string) => GET(new Request(`https://app.test/api/v1/leads${query}`, { headers: { authorization: "Bearer sk" } }));
const add = (body: Record<string, unknown>) => POST(new Request("https://app.test/api/v1/leads", { method: "POST", headers: { authorization: "Bearer sk" }, body: JSON.stringify(body) }));
const where = () => db.lead.findMany.mock.calls[0][0].where;

beforeEach(() => {
  vi.clearAllMocks();
  db.lead.findMany.mockResolvedValue([]);
  db.lead.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => row({ ...data, id: "l2" }));
});

describe("GET /api/v1/leads", () => {
  it("filters by where the lead is on the Leads list", async () => {
    db.lead.findMany.mockResolvedValue([row({ stage: "meeting", pipelineStage: "not_signed" })]);
    const res = await list("?pipelineStage=not_signed");
    expect(res.status).toBe(200);
    expect(where()).toEqual({ workspaceId: "w1", pipelineStage: "not_signed" });
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ stage: "meeting", pipelineStage: "not_signed", isClient: false });
  });

  it("takes the old stage names as before, and both together", async () => {
    await list("?stage=lost&pipelineStage=lost");
    expect(where()).toEqual({ workspaceId: "w1", stage: "lost", pipelineStage: "lost" });
  });

  it("says which names it takes", async () => {
    const res = await list("?pipelineStage=inactive");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pipelineStage must be one of new, proposal_sent, contract_sent, client, lost, not_now, not_signed");
    // The new names aren't stages.
    expect((await list("?stage=client")).status).toBe(400);
    expect(db.lead.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/leads", () => {
  it("adds a lead sent as lost straight to Inactive", async () => {
    const res = await add({ name: "Sam Rivera", stage: "lost" });
    expect(res.status).toBe(201);
    expect(db.lead.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "w1", source: "api", name: "Sam Rivera", stage: "lost", pipelineStage: "lost" });
    expect(await res.json()).toMatchObject({ stage: "lost", pipelineStage: "lost", isClient: false });
    expect(dispatchLeadsCreated).toHaveBeenCalledWith("w1", ["l2"]);
  });

  it("leaves any other stage at the start of the Leads list, converted too", async () => {
    for (const stage of ["meeting", "converted"]) {
      db.lead.create.mockClear();
      const res = await add({ name: "Sam Rivera", stage });
      expect(res.status, stage).toBe(201);
      expect(db.lead.create.mock.calls[0][0].data, stage).not.toHaveProperty("pipelineStage");
      expect(db.lead.create.mock.calls[0][0].data, stage).not.toHaveProperty("isClient");
    }
  });
});
