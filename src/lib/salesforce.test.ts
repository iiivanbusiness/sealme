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
    lead: null as { salesforceRecordId: string | null; salesforceRecordType: string | null } | null,
  },
}));
vi.mock("@/lib/db", () => ({
  prisma: {
    workspace: { findUnique: async () => workspace, findUniqueOrThrow: async () => workspace },
    deal: { findUnique: async () => deal, update: async () => deal },
    client: { update: async () => deal.client },
  },
}));

import { salesforceConvertedStatusFor, syncDealToSalesforce } from "./salesforce";

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
afterEach(() => {
  vi.unstubAllGlobals();
  deal.lead = null;
  deal.status = "signed";
});

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

describe("A Salesforce Lead that signs", () => {
  const LEAD = "00Q000000000001AAA";
  type OrgStatus = { value: string; converted?: boolean; label?: string };
  const defaultOrg: OrgStatus[] = [
    { value: "Open - Not Contacted" },
    { value: "Working - Contacted" },
    { value: "Closed - Converted", converted: true },
    { value: "Closed - Not Converted" },
  ];
  // Only "Customer" is converted here; the old name guess picked "Marketing Qualified".
  const mqlOrg: OrgStatus[] = [
    { value: "New" },
    { value: "Marketing Qualified" },
    { value: "Sales Qualified" },
    { value: "Working" },
    { value: "Customer", converted: true },
  ];

  // Answers the LeadStatus query the way the org would (only the statuses it
  // marks converted, in its own order, or `statusQuery` as an error code),
  // the Lead itself with `current`, everything else as mockSalesforce does.
  function mockOrg(
    org: OrgStatus[],
    current: { Status: string; IsConverted: boolean },
    { leadPatch = 204, statusQuery = 200 }: { leadPatch?: number; statusQuery?: number } = {},
  ): { url: string; method: string; body: unknown }[] {
    const sent: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      sent.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null });
      const soql = url.includes("/query?q=") ? decodeURIComponent(url.split("/query?q=")[1]) : "";
      if (soql.includes("FROM LeadStatus")) {
        if (statusQuery !== 200) return new Response("INSUFFICIENT_ACCESS", { status: statusQuery });
        const rows = soql.includes("WHERE IsConverted = true") ? org.filter((s) => s.converted) : org;
        const records = rows.map((s) => ({ attributes: { type: "LeadStatus" }, ApiName: s.value, MasterLabel: s.label ?? s.value }));
        return new Response(JSON.stringify({ totalSize: records.length, done: true, records }), { status: 200 });
      }
      if (url.includes(`/sobjects/Lead/${LEAD}?fields=`)) return new Response(JSON.stringify(current), { status: 200 });
      if (url.endsWith(`/sobjects/Lead/${LEAD}`)) return new Response(leadPatch === 204 ? null : "FIELD_INTEGRITY_EXCEPTION", { status: leadPatch });
      if (soql) return new Response(JSON.stringify({ totalSize: 1, records: [] }), { status: 200 });
      if (init.method === "PATCH") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ id: "00K000000000001AAA" }), { status: 201 });
    });
    return sent;
  }
  const leadPatches = (sent: { url: string; method: string; body: unknown }[]) => sent.filter((s) => s.method === "PATCH" && s.url.endsWith(`/sobjects/Lead/${LEAD}`)).map((s) => s.body);
  const statusQueries = (sent: { url: string }[]) => sent.filter((s) => s.url.includes("/query?q=")).map((s) => decodeURIComponent(s.url.split("/query?q=")[1])).filter((q) => q.includes("FROM LeadStatus"));

  it("writes the converted status's API name, or its label when there is none", () => {
    expect(salesforceConvertedStatusFor([{ ApiName: "Closed - Converted", MasterLabel: "Closed - Converted" }])).toBe("Closed - Converted");
    expect(salesforceConvertedStatusFor([{ ApiName: "Signed_Customer", MasterLabel: "Customer" }])).toBe("Signed_Customer");
    expect(salesforceConvertedStatusFor([{ ApiName: null, MasterLabel: "Customer" }])).toBe("Customer");
    expect(salesforceConvertedStatusFor([{ ApiName: "", MasterLabel: "" }, { ApiName: "Won", MasterLabel: "Won" }])).toBe("Won");
    expect(salesforceConvertedStatusFor([])).toBeNull();
  });

  it("moves the Lead to converted when its deal is signed", async () => {
    deal.lead = { salesforceRecordId: LEAD, salesforceRecordType: "Lead" };
    const sent = mockOrg(defaultOrg, { Status: "Working - Contacted", IsConverted: false });
    await syncDealToSalesforce("ws1", "deal1");
    expect(statusQueries(sent)).toEqual(["SELECT ApiName, MasterLabel FROM LeadStatus WHERE IsConverted = true ORDER BY SortOrder"]);
    expect(leadPatches(sent)).toEqual([{ Status: "Closed - Converted" }]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("uses the status the org marks converted, not one that only sounds qualified", async () => {
    deal.lead = { salesforceRecordId: LEAD, salesforceRecordType: "Lead" };
    let sent = mockOrg(mqlOrg, { Status: "Sales Qualified", IsConverted: false });
    await syncDealToSalesforce("ws1", "deal1");
    expect(leadPatches(sent)).toEqual([{ Status: "Customer" }]);

    // Already there: nothing to write.
    sent = mockOrg(mqlOrg, { Status: "Customer", IsConverted: false });
    await syncDealToSalesforce("ws1", "deal1");
    expect(leadPatches(sent)).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("never picks a status like Closed - Non-Converted", async () => {
    deal.lead = { salesforceRecordId: LEAD, salesforceRecordType: "Lead" };
    let sent = mockOrg([{ value: "Open" }, { value: "Closed - Non-Converted" }, { value: "Closed - Won", converted: true }], { Status: "Open", IsConverted: false });
    await syncDealToSalesforce("ws1", "deal1");
    expect(leadPatches(sent)).toEqual([{ Status: "Closed - Won" }]);

    // No status marked converted at all: the lead keeps the one it has.
    sent = mockOrg([{ value: "Open" }, { value: "Closed - Non-Converted" }, { value: "Qualified" }], { Status: "Open", IsConverted: false });
    await syncDealToSalesforce("ws1", "deal1");
    expect(leadPatches(sent)).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("leaves the status alone and says so when the converted status can't be read", async () => {
    deal.lead = { salesforceRecordId: LEAD, salesforceRecordType: "Lead" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = mockOrg(mqlOrg, { Status: "Working", IsConverted: false }, { statusQuery: 403 });
    await syncDealToSalesforce("ws1", "deal1");
    expect(leadPatches(sent)).toEqual([]);
    expect(sent.some((s) => s.method === "PATCH" && s.url.endsWith("/sobjects/Opportunity/006000000000001AAA"))).toBe(true);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "Salesforce lead status", { workspaceId: "ws1", dealId: "deal1" });
  });

  it("leaves Contacts, unsigned deals and leads already converted alone", async () => {
    deal.lead = { salesforceRecordId: "003000000000002AAA", salesforceRecordType: "Contact" };
    let sent = mockOrg(defaultOrg, { Status: "Working - Contacted", IsConverted: false });
    await syncDealToSalesforce("ws1", "deal1");
    expect(sent.some((s) => s.url.includes("/sobjects/Lead/"))).toBe(false);
    expect(statusQueries(sent)).toEqual([]);

    deal.lead = { salesforceRecordId: LEAD, salesforceRecordType: "Lead" };
    deal.status = "sent";
    sent = mockOrg(defaultOrg, { Status: "Working - Contacted", IsConverted: false });
    await syncDealToSalesforce("ws1", "deal1");
    expect(sent.some((s) => s.url.includes("/sobjects/Lead/"))).toBe(false);

    // Converted in Salesforce under another status: still left alone, since
    // Salesforce turns down any change to a converted lead.
    deal.status = "signed";
    sent = mockOrg(defaultOrg, { Status: "Working - Contacted", IsConverted: true });
    await syncDealToSalesforce("ws1", "deal1");
    expect(sent.some((s) => s.url.includes(`/sobjects/Lead/${LEAD}?fields=`))).toBe(true);
    expect(leadPatches(sent)).toEqual([]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("still pushes the deal when Salesforce won't take the status, and says so", async () => {
    deal.lead = { salesforceRecordId: LEAD, salesforceRecordType: "Lead" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sent = mockOrg(defaultOrg, { Status: "Working - Contacted", IsConverted: false }, { leadPatch: 400 });
    await syncDealToSalesforce("ws1", "deal1");
    expect(sent.some((s) => s.method === "PATCH" && s.url.endsWith("/sobjects/Opportunity/006000000000001AAA"))).toBe(true);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "Salesforce lead status", { workspaceId: "ws1", dealId: "deal1" });
  });
});
