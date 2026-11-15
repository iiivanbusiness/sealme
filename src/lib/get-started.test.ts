import { describe, expect, it } from "vitest";
import { getStartedSteps, hasCrm, type GetStartedInput } from "./get-started";

const fresh: GetStartedInput = {
  hasDeal: false,
  hasSentContract: false,
  readyDealId: null,
  hasCall: false,
  callLeadId: null,
  phoneCalls: true,
  hasPhone: false,
  canManageWorkspace: true,
  crmConnected: false,
  canManageTeam: true,
  hasTeammate: false,
};

describe("getStartedSteps", () => {
  it("starts from a call, walks the places, and keeps contracts optional", () => {
    const steps = getStartedSteps(fresh);
    expect(steps.map((s) => s.id)).toEqual(["call", "lead", "todo", "leads", "phone", "crm", "team", "contracts"]);
    expect(steps.find((s) => s.id === "contracts")?.optional).toBe(true);
    expect(steps.filter((s) => s.seenDone).map((s) => s.id)).toEqual(["lead", "todo", "leads"]);
  });

  it("drops what a rep can't do", () => {
    const rep = getStartedSteps({ ...fresh, phoneCalls: false, canManageWorkspace: false, canManageTeam: false });
    expect(rep.map((s) => s.id)).toEqual(["call", "lead", "todo", "leads", "contracts"]);
  });

  it("ticks off the first call and opens the lead it landed on", () => {
    const steps = getStartedSteps({ ...fresh, hasCall: true, callLeadId: "l1" });
    expect(steps.find((s) => s.id === "call")?.done).toBe(true);
    expect(steps.find((s) => s.id === "lead")?.href).toBe("/leads/l1?guide=lead");
  });

  it("makes the contract a real step once there's a deal, sent to a deal that's ready", () => {
    const steps = getStartedSteps({ ...fresh, hasDeal: true, readyDealId: "d1", hasTeammate: true });
    expect(steps.find((s) => s.id === "contract")).toMatchObject({ href: "/deals/d1/contract", cta: "Open the contract" });
    expect(steps.find((s) => s.id === "contract")?.optional).toBeFalsy();
    expect(steps.some((s) => s.id === "contracts")).toBe(false);
    expect(steps.filter((s) => s.done).map((s) => s.id)).toEqual(["call", "team"]);
  });

  it("names every CRM SealMe connects to in the CRM step", () => {
    expect(getStartedSteps(fresh).find((s) => s.id === "crm")?.hint).toContain("GoHighLevel");
  });
});

describe("hasCrm", () => {
  it("counts HubSpot, Salesforce and GoHighLevel alike", () => {
    expect(hasCrm({ hubspotAccessToken: "h" })).toBe(true);
    expect(hasCrm({ salesforceRefreshToken: "s" })).toBe(true);
    expect(hasCrm({ ghlAccessToken: "g" })).toBe(true);
    expect(hasCrm({ hubspotAccessToken: null, salesforceRefreshToken: null, ghlAccessToken: null })).toBe(false);
    expect(hasCrm(null)).toBe(false);
  });
});
