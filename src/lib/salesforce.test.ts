import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(async () => {}) }));
vi.mock("@/lib/error-report", () => ({ reportError }));

const { workspace, deal } = vi.hoisted(() => ({
  workspace: {
    id: "ws1",
    salesforceEnabled: true,
    salesforceAccessToken: "token",
    salesforceRefreshToken: "refresh",
    salesforceInstanceUrl: "https://acme.my.salesforce.com",
  },
  deal: {
    id: "deal1",
    service: "Onboarding",
    feeDisplay: "$5,000",
    status: "signed",
    updatedAt: new Date("2026-11-04T12:00:00Z"),
    salesforceOpportunityId: "006000000000001AAA",
    client: { id: "client1", name: "Laura Chen", company: "Brightline", email: "laura@brightline.com", salesforceContactId: "003000000000001AAA" },
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: async () => workspace, findUniqueOrThrow: async () => workspace },
    deal: { findUnique: async () => deal, update: async () => deal },
    client: { update: async () => deal.client },
  },
}));

import { syncDealToSalesforce } from "./salesforce";

type Sent = { url: string; method: string };

// Answers the contact-role lookup with `rolesFound` rows, everything else
// with an empty success, and records what was sent.
function mockSalesforce(rolesFound: number): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? "GET" });
    if (url.includes("/query?q=")) return new Response(JSON.stringify({ totalSize: rolesFound, records: [] }), { status: 200 });
    if (init.method === "PATCH") return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: "00K000000000001AAA" }), { status: 201 });
  });
  return sent;
}

beforeEach(() => reportError.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("Pushing a deal to Salesforce", () => {
  it("adds the contact role only once", async () => {
    let sent = mockSalesforce(0);
    await syncDealToSalesforce("ws1", "deal1");
    expect(sent.filter((s) => s.method === "POST" && s.url.endsWith("/sobjects/OpportunityContactRole"))).toHaveLength(1);
    expect(decodeURIComponent(sent.find((s) => s.url.includes("/query?q="))!.url)).toContain(
      "WHERE OpportunityId = '006000000000001AAA' AND ContactId = '003000000000001AAA'",
    );

    sent = mockSalesforce(1);
    await syncDealToSalesforce("ws1", "deal1");
    expect(sent.some((s) => s.url.endsWith("/sobjects/OpportunityContactRole"))).toBe(false);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("reports a failed push instead of only logging it", async () => {
    vi.stubGlobal("fetch", async () => new Response("INVALID_SESSION_ID", { status: 403 }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await syncDealToSalesforce("ws1", "deal1");
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "Salesforce deal sync", { workspaceId: "ws1", dealId: "deal1" });
  });
});
