import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => ({
  db: { deal: { findMany: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/api-deals", () => ({ announceNewDeal: vi.fn(), finishTranscriptDeal: vi.fn() }));
vi.mock("@/lib/api-activity", () => ({ findApiLead: vi.fn() }));
vi.mock("@/lib/client-lead", () => ({ leadForClient: vi.fn() }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/api-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-auth")>()),
  apiGuard: async () => ({ workspaceId: "w1", apiKeyId: "k1", access: "read" }),
}));

import { findApiLead } from "@/lib/api-activity";
import { GET, POST } from "./route";

const at = new Date("2026-10-01T12:00:00Z");
function row(over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    status: "ready",
    source: "api",
    kind: "contract",
    leadId: "l1",
    service: "Brand refresh",
    feeDisplay: "$8,500",
    createdAt: at,
    updatedAt: at,
    client: { id: "c1", name: "Avery Chen", company: "Northwind", email: null },
    owner: null,
    ...over,
  };
}

const list = (query: string) => GET(new Request(`https://app.test/api/v1/deals${query}`, { headers: { authorization: "Bearer sk" } }));
const where = () => db.deal.findMany.mock.calls[0][0].where;

beforeEach(() => {
  vi.clearAllMocks();
  db.deal.findMany.mockResolvedValue([]);
});

describe("GET /api/v1/deals", () => {
  it("lists only contracts by default, the way it did before proposals", async () => {
    db.deal.findMany.mockResolvedValue([row()]);
    const res = await list("");
    expect(res.status).toBe(200);
    expect(where()).toEqual({ workspaceId: "w1", trashedAt: null, kind: "contract" });
    const body = await res.json();
    expect(body.data[0]).toMatchObject({ id: "d1", kind: "contract", leadId: "l1" });
  });

  it("lists proposals when asked", async () => {
    db.deal.findMany.mockResolvedValue([row({ kind: "proposal" })]);
    const res = await list("?kind=proposal");
    expect(where()).toMatchObject({ kind: "proposal" });
    expect((await res.json()).data[0].kind).toBe("proposal");
  });

  it("lists both with kind=all", async () => {
    await list("?kind=all&status=sent");
    expect(where()).toEqual({ workspaceId: "w1", trashedAt: null, status: "sent" });
  });

  it("says which kinds it takes", async () => {
    const res = await list("?kind=offer");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("contract, proposal, all");
    expect(db.deal.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/deals", () => {
  const create = (body: Record<string, unknown>) =>
    POST(new Request("https://app.test/api/v1/deals", { method: "POST", headers: { authorization: "Bearer sk" }, body: JSON.stringify(body) }));
  const terms = { client: { name: "Sam" }, service: "Brand refresh", fee: "$8,500" };

  it("looks up a lead sent by a numeric external id instead of skipping it", async () => {
    vi.mocked(findApiLead).mockResolvedValue({ status: 404, error: "Lead not found" });
    const res = await create({ ...terms, leadExternalId: 48213 });
    expect(findApiLead).toHaveBeenCalledWith("w1", expect.objectContaining({ leadExternalId: 48213 }));
    expect(res.status).toBe(404);
  });

  it("refuses a lead id it can't read rather than making a new lead", async () => {
    vi.mocked(findApiLead).mockResolvedValue({ status: 400, error: "Send leadId, or leadExternalId (your id for the lead)" });
    const res = await create({ ...terms, leadId: true });
    expect(findApiLead).toHaveBeenCalled();
    expect(res.status).toBe(400);
  });
});
