import { beforeEach, describe, expect, it, vi } from "vitest";

const { phoneCall, salesforce, reportError } = vi.hoisted(() => ({
  phoneCall: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
  salesforce: { get: vi.fn(), request: vi.fn(), convertedStatuses: vi.fn() },
  reportError: vi.fn(async () => {}),
}));
vi.mock("@/lib/db", () => ({ prisma: { phoneCall } }));
vi.mock("@/lib/error-report", () => ({ reportError }));
vi.mock("@/lib/salesforce", () => ({
  salesforceGet: salesforce.get,
  salesforceRequest: salesforce.request,
  salesforceConvertedLeadStatuses: salesforce.convertedStatuses,
  SALESFORCE_API_VERSION: "v62.0",
}));

import { callDay, hubspotLeadStatusFor, pushCallToCrm, salesforceLeadStatusFor } from "./crm-call-sync";

const DEFAULT_SALESFORCE = ["Open - Not Contacted", "Working - Contacted", "Closed - Converted", "Closed - Not Converted"];

describe("Call outcome to CRM lead status", () => {
  it("uses HubSpot's built-in lead statuses", () => {
    expect(hubspotLeadStatusFor("voicemail")).toBe("ATTEMPTED_TO_CONTACT");
    expect(hubspotLeadStatusFor("no_answer")).toBe("ATTEMPTED_TO_CONTACT");
    expect(hubspotLeadStatusFor("meeting_booked")).toBe("IN_PROGRESS");
    expect(hubspotLeadStatusFor("follow_up")).toBe("CONNECTED");
    expect(hubspotLeadStatusFor("not_interested")).toBe("UNQUALIFIED");
    expect(hubspotLeadStatusFor("something_new")).toBeNull();
  });

  it("picks from the org's own Salesforce statuses", () => {
    expect(salesforceLeadStatusFor("interested", DEFAULT_SALESFORCE)).toBe("Working - Contacted");
    expect(salesforceLeadStatusFor("voicemail", DEFAULT_SALESFORCE)).toBe("Working - Contacted");
    expect(salesforceLeadStatusFor("not_interested", DEFAULT_SALESFORCE)).toBe("Closed - Not Converted");
    expect(salesforceLeadStatusFor("interested", ["New", "Nurturing", "Qualified"])).toBeNull();
    expect(salesforceLeadStatusFor("not_interested", ["Open", "Disqualified"])).toBe("Disqualified");
  });
});

describe("The day a call is logged on", () => {
  it("uses the rep's clock, not UTC", () => {
    // 18:30 in California on Nov 5 is 02:30 UTC on Nov 6.
    const evening = new Date("2026-11-06T02:30:00Z");
    expect(callDay(evening, "America/Los_Angeles")).toBe("2026-11-05");
    expect(callDay(evening, "UTC")).toBe("2026-11-06");
    expect(callDay(evening, "Europe/Belgrade")).toBe("2026-11-06");
  });
});

describe("Logging a call to a Salesforce Lead", () => {
  const LEAD = "00Q000000000001AAA";
  // Signed clients here sit at "Customer", the only status the org marks
  // converted, and nothing in the name says so.
  const CUSTOMER_ORG = ["New", "Working - Contacted", "Customer", "Closed - Not Converted"];

  function processedCall(outcome: string) {
    return {
      id: "call1",
      status: "processed",
      source: "phone",
      mode: "cold",
      outcome,
      summary: "Talked through renewal timing.",
      notes: null,
      durationSec: 240,
      startedAt: new Date("2026-11-05T15:00:00Z"),
      hubspotCallId: null,
      salesforceTaskId: null,
      ghlNoteId: null,
      user: { timezone: "America/New_York" },
      lead: {
        id: "lead1",
        name: "Laura Chen",
        email: "laura@brightline.com",
        phone: null,
        company: "Brightline",
        hubspotContactId: null,
        salesforceRecordId: LEAD,
        salesforceRecordType: "Lead",
        ghlContactId: null,
        ghlOpportunityId: null,
      },
      workspace: {
        id: "ws1",
        hubspotEnabled: false,
        hubspotAccessToken: null,
        salesforceEnabled: true,
        salesforceRefreshToken: "refresh",
        ghlEnabled: false,
        ghlLocationId: null,
        ghlAccessToken: null,
        ghlPipelineId: null,
        ghlStageId: null,
      },
    };
  }

  // Answers the org's Lead Status picklist, the Lead at `current`, and the
  // statuses it marks converted (or fails that query), and records writes.
  function mockOrg(current: string, { convertedQueryFails = false }: { convertedQueryFails?: boolean } = {}) {
    const writes: { path: string; body: unknown }[] = [];
    salesforce.request.mockImplementation(async (_workspaceId: string, path: string, init: RequestInit) => {
      writes.push({ path, body: JSON.parse(String(init.body)) });
      return path.endsWith("/Task") ? Response.json({ id: "00T000000000001AAA" }, { status: 201 }) : new Response(null, { status: 204 });
    });
    salesforce.get.mockImplementation(async (_workspaceId: string, path: string) => {
      if (path.endsWith("/Lead/describe")) return { fields: [{ name: "Status", picklistValues: CUSTOMER_ORG.map((value) => ({ value, active: true })) }] };
      return { Status: current, IsConverted: false };
    });
    salesforce.convertedStatuses.mockImplementation(async () => {
      if (convertedQueryFails) throw new Error("Salesforce /services/data/v62.0/query failed: 403 INSUFFICIENT_ACCESS");
      return [{ ApiName: "Customer", MasterLabel: "Customer" }];
    });
    return writes;
  }
  const leadPatches = (writes: { path: string; body: unknown }[]) => writes.filter((w) => w.path.endsWith(`/sobjects/Lead/${LEAD}`)).map((w) => w.body);
  const taskSaved = () => expect(phoneCall.update).toHaveBeenCalledWith({ where: { id: "call1" }, data: { salesforceTaskId: "00T000000000001AAA" } });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("doesn't move a signed client back to Working", async () => {
    phoneCall.findUnique.mockResolvedValue(processedCall("follow_up"));
    const writes = mockOrg("Customer");
    await pushCallToCrm("call1");
    expect(writes.filter((w) => w.path.endsWith("/sobjects/Task"))).toHaveLength(1);
    expect(leadPatches(writes)).toEqual([]);
    taskSaved();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("still moves a lead that hasn't signed", async () => {
    phoneCall.findUnique.mockResolvedValue(processedCall("not_interested"));
    let writes = mockOrg("Working - Contacted");
    await pushCallToCrm("call1");
    expect(leadPatches(writes)).toEqual([{ Status: "Closed - Not Converted" }]);

    phoneCall.findUnique.mockResolvedValue(processedCall("follow_up"));
    writes = mockOrg("New");
    await pushCallToCrm("call1");
    expect(leadPatches(writes)).toEqual([{ Status: "Working - Contacted" }]);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("leaves the status alone and says so when the converted statuses can't be read", async () => {
    phoneCall.findUnique.mockResolvedValue(processedCall("follow_up"));
    const writes = mockOrg("Customer", { convertedQueryFails: true });
    await pushCallToCrm("call1");
    expect(leadPatches(writes)).toEqual([]);
    // The call is logged and kept, so a retry won't log it again.
    taskSaved();
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "Salesforce lead status after a call", { workspaceId: "ws1", callId: "call1" });
  });
});
