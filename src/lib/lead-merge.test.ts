import { describe, expect, it } from "vitest";
import { mergedLeadData } from "./lead-merge";
import type { Lead } from "@/generated/prisma/client";

const base: Lead = {
  id: "x",
  workspaceId: "w",
  ownerId: null,
  name: "Megan Ellis",
  company: null,
  title: null,
  email: null,
  phone: null,
  domain: null,
  stage: "new",
  interest: null,
  isDecisionMaker: null,
  painPoints: null,
  objections: null,
  nextStep: null,
  nextStepAt: null,
  summary: null,
  notes: null,
  lastContactedAt: null,
  source: "call",
  importId: null,
  convertedClientId: null,
  convertedDealId: null,
  convertedAt: null,
  hubspotContactId: null,
  salesforceRecordId: null,
  salesforceRecordType: null,
  ghlContactId: null,
  ghlOpportunityId: null,
  externalOwnerEmail: null,
  externalId: null,
  campaign: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
};

describe("mergedLeadData", () => {
  it("keeps target's details, fills gaps from source, and takes the newest call's next step", () => {
    const target = { ...base, id: "t", company: "Brightwater", stage: "interested", painPoints: "Blog dormant", nextStep: "Send proposal", lastContactedAt: new Date("2026-10-01T00:00:00Z") };
    const source = { ...base, id: "s", company: "Other Co", email: "megan@bw.example", stage: "contacted", painPoints: "No content calendar", nextStep: "Sign contract", lastContactedAt: new Date("2026-10-07T00:00:00Z") };
    const data = mergedLeadData(target, source);
    expect(data.company).toBe("Brightwater");
    expect(data.email).toBe("megan@bw.example");
    expect(data.stage).toBe("interested");
    expect(data.nextStep).toBe("Sign contract");
    expect(data.painPoints).toBe("No content calendar; Blog dormant");
    expect(data.lastContactedAt?.toISOString()).toBe("2026-10-07T00:00:00.000Z");
  });

  it("takes the stage that's further along, and lost never wins over a live lead", () => {
    expect(mergedLeadData({ ...base, stage: "contacted" }, { ...base, stage: "meeting" }).stage).toBe("meeting");
    expect(mergedLeadData({ ...base, stage: "interested" }, { ...base, stage: "lost" }).stage).toBe("interested");
  });
});
