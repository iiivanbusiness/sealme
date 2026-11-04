import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/salesforce", () => ({ salesforceGet: async () => ({}), salesforceRequest: async () => new Response(), SALESFORCE_API_VERSION: "v62.0" }));

import { callDay, hubspotLeadStatusFor, salesforceLeadStatusFor } from "./crm-call-sync";

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
