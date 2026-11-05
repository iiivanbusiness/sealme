import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { workspace, deal, client, reportError } = vi.hoisted(() => ({
  workspace: { findUnique: vi.fn() },
  deal: { findUnique: vi.fn(), update: vi.fn() },
  client: { update: vi.fn() },
  reportError: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { workspace, deal, client } }));
vi.mock("@/lib/error-report", () => ({ reportError }));

import { checkHubspotStages, hubspotStageFor, readHubspotPipelines, syncDealToHubspot, type HubspotPipeline } from "./hubspot";

const off = { hubspotPipelineId: null, hubspotSentStageId: null, hubspotSignedStageId: null };
const picked = { hubspotPipelineId: "default", hubspotSentStageId: "contractsent", hubspotSignedStageId: "closedwon" };

describe("Which HubSpot stage a deal goes to", () => {
  it("sends no stage until the admin picks them", () => {
    expect(hubspotStageFor("sent", off)).toBeNull();
    expect(hubspotStageFor("signed", off)).toBeNull();
  });

  it("moves the deal when its contract is sent and when it's signed", () => {
    expect(hubspotStageFor("sent", picked)).toEqual({ pipeline: "default", dealstage: "contractsent" });
    expect(hubspotStageFor("signed", picked)).toEqual({ pipeline: "default", dealstage: "closedwon" });
  });

  it("leaves earlier statuses, and a moment with no stage picked, alone", () => {
    expect(hubspotStageFor("ready", picked)).toBeNull();
    expect(hubspotStageFor("changes_requested", picked)).toBeNull();
    expect(hubspotStageFor("sent", { ...picked, hubspotSentStageId: null })).toBeNull();
  });
});

describe("HubSpot pipelines for the picker", () => {
  const pipelines = readHubspotPipelines([
    {
      id: "p2",
      label: "Renewals",
      displayOrder: 1,
      stages: [
        { id: "s3", label: "Won", displayOrder: 2, metadata: { isClosed: "true", probability: "1.0" } },
        { id: "s1", label: "Agreement Sent", displayOrder: 0 },
        { id: "s2", label: "Lost", displayOrder: 1, metadata: { isClosed: "true", probability: "0.0" } },
      ],
    },
    {
      id: "default",
      label: "Sales Pipeline",
      displayOrder: 0,
      stages: [
        { id: "appointmentscheduled", label: "Appointment Scheduled", displayOrder: 0 },
        { id: "contractsent", label: "Contract Sent", displayOrder: 1 },
        { id: "closedwon", label: "Closed Won", displayOrder: 2 },
        { id: "old", label: "Old stage", displayOrder: 3, archived: true },
      ],
    },
    { id: "gone", label: "Archived pipeline", archived: true, stages: [] },
  ]);

  it("lists open pipelines and stages in HubSpot's order", () => {
    expect(pipelines.map((p) => p.id)).toEqual(["default", "p2"]);
    expect(pipelines[0].stages.map((s) => s.id)).toEqual(["appointmentscheduled", "contractsent", "closedwon"]);
    expect(pipelines[1].stages.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("suggests the usual stages for sent and signed", () => {
    expect(pipelines[0]).toMatchObject({ suggestedSent: "contractsent", suggestedSigned: "closedwon" });
    // A custom pipeline: no "Contract sent", but its closed stage that counts as won.
    expect(pipelines[1]).toMatchObject({ suggestedSent: null, suggestedSigned: "s3" });
  });
});

describe("Saving the stages", () => {
  const pipelines: HubspotPipeline[] = [
    { id: "default", label: "Sales Pipeline", stages: [{ id: "contractsent", label: "Contract Sent" }, { id: "closedwon", label: "Closed Won" }], suggestedSent: null, suggestedSigned: null },
    { id: "p2", label: "Renewals", stages: [{ id: "s3", label: "Won" }], suggestedSent: null, suggestedSigned: null },
  ];
  const choice = (o: Partial<{ pipelineId: string; sentStageId: string; signedStageId: string }>) => ({ pipelineId: "default", sentStageId: "", signedStageId: "", ...o });

  it("turns stages off when no pipeline is picked", () => {
    expect(checkHubspotStages([], choice({ pipelineId: "", sentStageId: "contractsent" }))).toEqual({ data: off });
  });

  it("saves stages from the chosen pipeline", () => {
    expect(checkHubspotStages(pipelines, choice({ sentStageId: "contractsent", signedStageId: "closedwon" }))).toEqual({ data: picked });
    expect(checkHubspotStages(pipelines, choice({ signedStageId: "closedwon" }))).toEqual({ data: { ...picked, hubspotSentStageId: null } });
  });

  it("turns down a pipeline or stage HubSpot doesn't have", () => {
    expect(checkHubspotStages(pipelines, choice({ pipelineId: "nope", signedStageId: "closedwon" }))).toHaveProperty("error");
    expect(checkHubspotStages(pipelines, choice({ signedStageId: "s3" }))).toEqual({ error: "Pick stages from the Sales Pipeline pipeline" });
    expect(checkHubspotStages(pipelines, choice({}))).toHaveProperty("error");
  });
});

describe("Pushing a deal to HubSpot", () => {
  const calls: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  let rejectStage = false;

  beforeEach(() => {
    vi.resetAllMocks();
    calls.length = 0;
    rejectStage = false;
    deal.findUnique.mockResolvedValue({
      id: "d1",
      service: "SEO retainer",
      feeDisplay: "$5,000 / month",
      status: "signed",
      hubspotDealId: "HD1",
      client: { id: "c1", name: "Jordan Lee", company: "Harbor Logistics", email: "jordan@harbor.example", hubspotContactId: "HC1" },
    });
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const path = new URL(url).pathname;
      calls.push({ method: init?.method ?? "GET", path, body });
      const properties = (body?.properties ?? {}) as Record<string, string>;
      if (rejectStage && properties.dealstage) {
        return new Response('{"status":"error","message":"Property values were not valid","errors":[{"name":"dealstage","error":"INVALID_OPTION"}]}', { status: 400 });
      }
      return new Response(JSON.stringify({ id: "HD1", properties: {} }), { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const dealWrites = () => calls.filter((c) => c.path === "/crm/v3/objects/deals/HD1").map((c) => c.body?.properties);

  it("sends the picked pipeline and stage", async () => {
    workspace.findUnique.mockResolvedValue({ hubspotEnabled: true, hubspotAccessToken: "pat", ...picked });
    await syncDealToHubspot("ws1", "d1");
    expect(dealWrites()).toEqual([{ dealname: "SEO retainer", amount: "5000", pipeline: "default", dealstage: "closedwon" }]);
  });

  it("sends no stage when none are picked, as before", async () => {
    workspace.findUnique.mockResolvedValue({ hubspotEnabled: true, hubspotAccessToken: "pat", ...off });
    await syncDealToHubspot("ws1", "d1");
    expect(dealWrites()).toEqual([{ dealname: "SEO retainer", amount: "5000" }]);
  });

  it("still pushes the deal when HubSpot no longer has the stage, and says so", async () => {
    rejectStage = true;
    workspace.findUnique.mockResolvedValue({ hubspotEnabled: true, hubspotAccessToken: "pat", ...picked });
    await syncDealToHubspot("ws1", "d1");
    expect(dealWrites()).toEqual([
      { dealname: "SEO retainer", amount: "5000", pipeline: "default", dealstage: "closedwon" },
      { dealname: "SEO retainer", amount: "5000" },
    ]);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0][1]).toBe("HubSpot deal stage");
  });
});
