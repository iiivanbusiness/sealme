import { describe, expect, it, vi } from "vitest";

// lead-pipeline.ts is only imported for its tab rules; nothing here touches
// the database.
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock("@/lib/webhook-events", () => ({ dispatchLeadsUpdated: vi.fn(), leadChanges: vi.fn() }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/client-lead", () => ({ leadForClient: vi.fn() }));

import { INACTIVE_STAGES, LEAD_TABS, leadIsInactive, type LeadTab } from "./lead-pipeline";
import { PIPELINE_STAGES, type PipelineStage } from "./pipeline-stages";
import { parseLeadTab, stageFitsTab, tabForStage } from "./lead-tab-stage";

const now = new Date("2026-11-15T12:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

// The tabs a lead shows on, by the same rules the Leads page queries with.
function tabsOf(stage: PipelineStage, lastActivityAt: Date): LeadTab[] {
  const lead = { isClient: stage === "client", pipelineStage: stage, lastActivityAt, createdAt: daysAgo(90) };
  if (lead.isClient) return ["clients", "all"];
  return [leadIsInactive(lead, now) ? "inactive" : "active", "all"];
}

describe("Stage filter and the Leads tabs", () => {
  it("knows every tab a lead at each stage can be on", () => {
    for (const stage of PIPELINE_STAGES) {
      const seen = new Set([...tabsOf(stage, daysAgo(1)), ...tabsOf(stage, daysAgo(45))]);
      for (const tab of LEAD_TABS) expect(stageFitsTab(stage, tab), `${stage} on ${tab}`).toBe(seen.has(tab));
    }
  });

  it("keeps the tab asked for when the stage can be on it", () => {
    expect(tabForStage("new", "active")).toBe("active");
    expect(tabForStage("new", "inactive")).toBe("inactive");
    expect(tabForStage("lost", "inactive")).toBe("inactive");
    expect(tabForStage("client", "clients")).toBe("clients");
    expect(tabForStage("lost", "all")).toBe("all");
    expect(tabForStage(null, "clients")).toBe("clients");
  });

  it("moves a stage that can't be on the tab to the tab it's on", () => {
    for (const stage of INACTIVE_STAGES as PipelineStage[]) {
      expect(tabForStage(stage, "active")).toBe("inactive");
      expect(tabForStage(stage, "clients")).toBe("inactive");
    }
    expect(tabForStage("client", "active")).toBe("clients");
    expect(tabForStage("client", "inactive")).toBe("clients");
    // A New lead can be on Active or Inactive: All shows both.
    expect(tabForStage("new", "clients")).toBe("all");
    expect(tabForStage("contract_sent", "clients")).toBe("all");
  });

  it("reads the tab from the address bar", () => {
    for (const tab of LEAD_TABS) expect(parseLeadTab(tab)).toBe(tab);
    expect(parseLeadTab(null)).toBe("active");
    expect(parseLeadTab("")).toBe("active");
    expect(parseLeadTab("everyone")).toBe("active");
  });
});
