import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { user: { findFirst: async ({ where }: { where: { email: { equals: string } } }) => (where.email.equals.toLowerCase() === "rep@example.com" ? { id: "u1" } : null) } },
}));

import { apiStagePipeline, parseLeadInput, withoutStage } from "./api-leads";

describe("parseLeadInput", () => {
  it("cleans what it's given", async () => {
    const r = await parseLeadInput("w", { name: "  Ana  ", email: "Ana@Example.COM", phone: "+1 (202) 555-0150", domain: "https://acme.com/about", stage: "converted", nextStepAt: "2026-10-20", ownerEmail: "Rep@example.com" }, { requireName: true });
    expect("data" in r && r.data).toMatchObject({ name: "Ana", email: "ana@example.com", phone: "+12025550150", domain: "acme.com", stage: "converted", ownerId: "u1" });
    expect("data" in r && r.data.convertedAt).toBeInstanceOf(Date);
    expect("data" in r && r.data.nextStepAt?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });
  it("only touches the keys that were sent, and null clears", async () => {
    const r = await parseLeadInput("w", { title: null, ownerEmail: null }, { requireName: false });
    expect("data" in r && r.data).toEqual({ title: null, ownerId: null });
  });
  it("keeps their own id as text, and null clears it", async () => {
    const a = await parseLeadInput("w", { name: "A", externalId: 48213 }, { requireName: true });
    expect("data" in a && a.data.externalId).toBe("48213");
    const b = await parseLeadInput("w", { externalId: null }, { requireName: false });
    expect("data" in b && b.data).toEqual({ externalId: null });
    const c = await parseLeadInput("w", { name: "A", externalId: { id: 1 } }, { requireName: true });
    expect("error" in c && c.error).toMatch(/externalId/);
  });
  it("explains what's wrong", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{}, /name.*required/],
      [{ name: "" }, /required/],
      [{ name: "A", email: "nope" }, /email/],
      [{ name: "A", stage: "won" }, /stage/],
      [{ name: "A", interest: "lukewarm" }, /interest/],
      [{ name: "A", nextStepAt: "20/10/2026" }, /nextStepAt/],
      [{ name: "A", nextStepAt: "2026-13-45" }, /real date/],
      [{ name: "A", ownerEmail: "stranger@example.com" }, /ownerEmail/],
    ];
    for (const [body, msg] of cases) {
      const r = await parseLeadInput("w", body, { requireName: true });
      expect("error" in r && r.error, JSON.stringify(body)).toMatch(msg);
    }
  });
});

describe("apiStagePipeline", () => {
  const now = new Date("2026-11-14T10:00:00Z");
  const lead = (over: Partial<{ stage: string; isClient: boolean; pipelineStage: string }> = {}) => ({ stage: "contacted", isClient: false, pipelineStage: "new", ...over });
  const nothing = { data: {}, notClient: false, refresh: false };

  it("leaves the lead where it is when no stage is sent", () => {
    expect(apiStagePipeline(lead(), undefined, now)).toEqual(nothing);
    expect(apiStagePipeline(lead({ isClient: true, pipelineStage: "client", stage: "converted" }), undefined, now)).toEqual(nothing);
  });
  it("takes a lead marked lost off Active, only while it isn't a client", () => {
    expect(apiStagePipeline(lead(), "lost", now)).toEqual({ data: { pipelineStage: "lost" }, notClient: true, refresh: false });
    // Lost on a call earlier but still active: lost now means it.
    expect(apiStagePipeline(lead({ stage: "lost" }), "lost", now)).toEqual({ data: { pipelineStage: "lost" }, notClient: true, refresh: false });
  });
  it("adds a new lead sent as lost straight to Inactive", () => {
    expect(apiStagePipeline(null, "lost", now)).toEqual({ data: { pipelineStage: "lost" }, notClient: false, refresh: false });
    expect(apiStagePipeline(null, "contacted", now)).toEqual(nothing);
    expect(apiStagePipeline(null, "converted", now)).toEqual(nothing);
  });
  it("brings a lead that's set aside back to Active on a working stage", () => {
    for (const pipelineStage of ["lost", "not_now", "not_signed"]) {
      const r = apiStagePipeline(lead({ stage: pipelineStage === "lost" ? "lost" : "contacted", pipelineStage }), "meeting", now);
      expect(r, pipelineStage).toEqual({ data: { pipelineStage: "new", lastActivityAt: now }, notClient: true, refresh: true });
    }
  });
  it("leaves a set-aside lead alone when the stage it already has comes again", () => {
    expect(apiStagePipeline(lead({ stage: "contacted", pipelineStage: "not_now" }), "contacted", now)).toEqual({ data: {}, notClient: true, refresh: false });
    expect(apiStagePipeline(lead({ stage: "meeting", pipelineStage: "not_signed" }), "meeting", now)).toEqual({ data: {}, notClient: true, refresh: false });
  });
  it("doesn't move an active lead on a working stage", () => {
    expect(apiStagePipeline(lead({ pipelineStage: "proposal_sent" }), "interested", now)).toEqual({ data: {}, notClient: true, refresh: false });
  });
  it("only records converted: a signature makes a client", () => {
    expect(apiStagePipeline(lead(), "converted", now)).toEqual(nothing);
    expect(apiStagePipeline(lead({ stage: "lost", pipelineStage: "lost" }), "converted", now)).toEqual(nothing);
  });
  it("keeps a client converted", () => {
    const client = lead({ isClient: true, pipelineStage: "client", stage: "converted" });
    expect(apiStagePipeline(client, "converted", now)).toEqual(nothing);
    // Any other stage is left out, so the rest of a sync's changes still go in.
    for (const stage of ["new", "contacted", "interested", "meeting", "lost"]) {
      expect(apiStagePipeline(client, stage, now), stage).toEqual({ data: {}, notClient: false, refresh: false, dropStage: true });
    }
  });
});

describe("withoutStage", () => {
  it("takes out the stage and what it brings along, and nothing else", () => {
    const at = new Date("2026-11-14T10:00:00Z");
    expect(withoutStage({ stage: "lost", convertedAt: null, pipelineStage: "lost", lastActivityAt: at, notes: "Renewal", phone: null })).toEqual({ notes: "Renewal", phone: null });
    expect(withoutStage({})).toEqual({});
  });
});
