import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, applyExtraction, suggest, runProcessing, addUsage, dispatchCreated, dispatchCompleted, refreshPipeline } = vi.hoisted(() => ({
  db: {
    phoneCall: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    deal: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    contractTemplate: { findMany: vi.fn() },
    client: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    dealField: { findMany: vi.fn(), createMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    contract: { upsert: vi.fn(), updateMany: vi.fn() },
    lead: { update: vi.fn() },
    localCaptureToken: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
  applyExtraction: vi.fn(),
  suggest: vi.fn(),
  runProcessing: vi.fn(),
  addUsage: vi.fn(),
  dispatchCreated: vi.fn(),
  dispatchCompleted: vi.fn(),
  refreshPipeline: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
// Template "B" asks for other terms than the rest.
vi.mock("@/lib/contract", () => ({ extractPlaceholderKeys: (clauses: string) => (clauses === "B" ? ["clientName", "seats"] : ["clientName", "fee", "startDate"]) }));
vi.mock("@/lib/extract-deal", () => ({
  buildDealFieldRows: (_: unknown, keys: string[]) => ({ fieldRows: keys.map((fieldKey, orderIndex) => ({ fieldKey, label: fieldKey, groupLabel: "Terms", value: null, status: "missing", orderIndex })) }),
}));
vi.mock("@/lib/deal-live", () => ({ applyExtractionToDeal: applyExtraction }));
vi.mock("@/lib/call-deal", () => ({ suggestTemplateId: suggest }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead from a call", PLACEHOLDER_CLIENT: "New client" }));
vi.mock("@/lib/call-inbox", () => ({ runCallProcessing: runProcessing, addCallAiUsage: addUsage }));
vi.mock("@/lib/webhooks", () => ({ dispatchDealCreated: dispatchCreated }));
vi.mock("@/lib/webhook-events", () => ({ dispatchCallCompleted: dispatchCompleted }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline: refreshPipeline }));
vi.mock("@/lib/tasks", () => ({ isValidTimeZone: (tz: string) => tz === "Europe/Belgrade" }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));

import { startLiveDeal, refreshLiveDeals, finishLiveCall, finishAbandonedLiveCalls, LIVE_EXTRACT_EVERY_MS } from "./live-call";
import { recordAiUsage } from "@/lib/ai-usage";

const lead = { id: "l1", name: "Dana Reyes", company: "Northwind", email: "dana@northwind.test", ownerId: "u1", convertedClientId: null };
const call = (over: object = {}) => ({ id: "pc1", workspaceId: "w1", userId: "u1", status: "recording", transcript: null, dealId: null, templateId: null, lead, user: { teamId: null }, ...over });
const templates = [
  { id: "tA", name: "A", description: null, clauses: "" },
  { id: "tB", name: "B", description: null, clauses: "B" },
];
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  db.deal.findFirst.mockResolvedValue(null);
  db.contractTemplate.findMany.mockResolvedValue(templates);
  db.client.create.mockResolvedValue({ id: "c1" });
  db.deal.create.mockResolvedValue({ id: "d1" });
  db.deal.updateMany.mockResolvedValue({ count: 1 });
  // Still one SealMe may fill in when its turn comes.
  db.deal.count.mockResolvedValue(1);
  applyExtraction.mockResolvedValue({ hasMissing: true });
  runProcessing.mockResolvedValue(undefined);
  addUsage.mockResolvedValue(undefined);
  dispatchCompleted.mockResolvedValue(undefined);
  db.phoneCall.findUnique.mockResolvedValue(null);
  db.dealField.findMany.mockResolvedValue([]);
  suggest.mockReset();
});

describe("Proposal or contract made while the call records", () => {
  it("starts on the lead, with who the call is with already filled in", async () => {
    db.phoneCall.findUnique.mockResolvedValue(call());

    expect(await startLiveDeal("pc1", "contract")).toEqual({ dealId: "d1" });
    // Nothing heard yet: the first template, not a guess.
    expect(suggest).not.toHaveBeenCalled();
    expect(db.deal.create.mock.calls[0][0].data).toMatchObject({ clientId: "c1", leadId: "l1", phoneCallId: "pc1", kind: "contract", templateId: "tA", status: "processing", source: "local" });
    expect(db.client.create.mock.calls[0][0].data).toMatchObject({ name: "Dana Reyes", company: "Northwind", email: "dana@northwind.test" });
    const rows = db.dealField.createMany.mock.calls[0][0].data;
    expect(rows.find((r: { fieldKey: string }) => r.fieldKey === "clientName")).toMatchObject({ value: "Dana Reyes", status: "extracted" });
    expect(rows.find((r: { fieldKey: string }) => r.fieldKey === "fee")).toMatchObject({ value: null, status: "missing" });
    // The call points at its contract and asks for one, so writing it up
    // treats it as the call that made it; the lead remembers the client. The
    // call's template stays the rep's pick (none) while it records.
    expect(db.phoneCall.update).toHaveBeenCalledWith({ where: { id: "pc1" }, data: { dealId: "d1", wantsContract: true } });
    expect(db.lead.update.mock.calls[0][0].data).toMatchObject({ convertedClientId: "c1" });
    // Nothing picked from what was said, so it can still be picked again.
    expect(db.deal.create.mock.calls[0][0].data.lastExtractedTranscript).toBeUndefined();
  });

  it("picks the template that fits once enough has been said, counts what that cost, and never makes a second of the same kind", async () => {
    db.phoneCall.findUnique.mockResolvedValue(call({ transcript: words(70), dealId: "d-contract" }));
    suggest.mockImplementation(async () => {
      recordAiUsage({ model: "claude-haiku-4-5", usage: { input_tokens: 800, output_tokens: 2 } });
      return "tB";
    });
    await startLiveDeal("pc1", "proposal");
    // Picked from enough words: marked so, so it's never picked again.
    expect(db.deal.create.mock.calls[0][0].data).toMatchObject({ kind: "proposal", templateId: "tB", lastExtractedTranscript: words(70) });
    expect(db.dealField.createMany.mock.calls[0][0].data.map((r: { fieldKey: string }) => r.fieldKey)).toEqual(["clientName", "seats"]);
    expect(addUsage).toHaveBeenCalledWith("pc1", expect.objectContaining({ inputTokens: 800, outputTokens: 2 }));
    // A proposal asks for one on the call, and leaves the contract it points at.
    expect(db.phoneCall.update).toHaveBeenCalledWith({ where: { id: "pc1" }, data: { wantsProposal: true } });

    db.deal.create.mockClear();
    db.deal.findFirst.mockResolvedValue({ id: "d0" });
    expect(await startLiveDeal("pc1", "proposal")).toEqual({ dealId: "d0" });
    expect(db.deal.create).not.toHaveBeenCalled();
  });

  it("won't start one on a call that has ended, or with no template of that kind", async () => {
    db.phoneCall.findUnique.mockResolvedValue(call({ status: "processing" }));
    await expect(startLiveDeal("pc1", "contract")).rejects.toThrow(/has ended/);
    db.phoneCall.findUnique.mockResolvedValue(call());
    db.contractTemplate.findMany.mockResolvedValue([]);
    await expect(startLiveDeal("pc1", "contract")).rejects.toThrow(/template first/);
  });

  it("reads the terms at most about every three minutes mid-call, and always on the final", async () => {
    db.deal.findMany.mockResolvedValue([{ id: "d1", template: { clauses: "" } }]);
    applyExtraction.mockImplementation(async () => {
      recordAiUsage({ model: "claude-sonnet-5", usage: { input_tokens: 3000, output_tokens: 400 } });
      return { hasMissing: true };
    });
    await refreshLiveDeals("pc1", "Client: Five thousand works.");
    const claim = db.deal.updateMany.mock.calls[0][0];
    expect(claim.where.id).toBe("d1");
    const cutoff = claim.where.OR[1].lastExtractedAt.lt as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(LIVE_EXTRACT_EVERY_MS - 1000);
    expect(applyExtraction).toHaveBeenCalledTimes(1);

    // Claimed by an overlapping chunk already: no second pass.
    db.deal.updateMany.mockResolvedValue({ count: 0 });
    await refreshLiveDeals("pc1", "Client: Five thousand works.");
    expect(applyExtraction).toHaveBeenCalledTimes(1);

    await refreshLiveDeals("pc1", "Client: Five thousand works.", { final: true });
    expect(applyExtraction).toHaveBeenCalledTimes(2);
    // Each reading's model use goes on the call, like its notes.
    expect(addUsage).toHaveBeenCalledWith("pc1", expect.objectContaining({ inputTokens: 3000, outputTokens: 400 }));
    expect(addUsage.mock.calls.filter((c) => c[1].inputTokens > 0)).toHaveLength(2);
  });
});

describe("A document sent while the call is still on", () => {
  it("is left as it went out when it was sent, or thrown away, before its turn to be read", async () => {
    db.deal.findMany.mockResolvedValue([
      { id: "d1", kind: "contract", template: { clauses: "" } },
      { id: "d2", kind: "proposal", template: { clauses: "" } },
    ]);
    // d2 went out while d1 was being read.
    db.deal.count.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === "d1" ? 1 : 0));

    await refreshLiveDeals("pc1", "Client: Five thousand works.", { final: true });

    expect(applyExtraction).toHaveBeenCalledTimes(1);
    expect(applyExtraction.mock.calls[0][0]).toBe("d1");
    // Checked by the same rule that picked the documents: not sent, not in review, not in the trash.
    const { phoneCallId, ...picked } = db.deal.findMany.mock.calls[0][0].where;
    expect(phoneCallId).toBe("pc1");
    expect(db.deal.count.mock.calls[1][0].where).toEqual({ id: "d2", ...picked });
    expect(picked).toEqual({ trashedAt: null, status: { in: ["processing", "missing_info", "ready"] }, OR: [{ contract: null }, { contract: { status: "draft" } }] });
  });
});

describe("Which template a live document is on", () => {
  // A contract that took the first template before anything was said.
  const started = (over: object = {}) => ({
    id: "d1",
    kind: "contract",
    workspaceId: "w1",
    templateId: "tA",
    lastExtractedTranscript: words(20),
    template: { kind: "contract", clauses: "" },
    lead: { name: "Dana Reyes", company: "Northwind", email: "dana@northwind.test" },
    ...over,
  });

  it("is picked again from what was said once the call says enough, while only who it's with is filled in", async () => {
    db.deal.findMany.mockResolvedValue([started()]);
    db.phoneCall.findUnique.mockResolvedValue({ templateId: null });
    db.dealField.findMany.mockResolvedValue([
      { fieldKey: "clientName", value: "Dana Reyes" },
      { fieldKey: "fee", value: null },
      { fieldKey: "startDate", value: "" },
    ]);
    suggest.mockResolvedValue("tB");

    await refreshLiveDeals("pc1", words(70));

    expect(suggest).toHaveBeenCalledWith(words(70), templates);
    expect(db.deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { templateId: "tB" } });
    expect(db.contract.updateMany).toHaveBeenCalledWith({ where: { dealId: "d1" }, data: { templateId: "tB" } });
    // Who it's with stays only as far as the new template asks (no "Client email" here).
    expect(db.dealField.deleteMany).toHaveBeenCalledWith({ where: { dealId: "d1", fieldKey: { notIn: ["clientName"] } } });
    const created = db.dealField.createMany.mock.calls[0][0];
    expect(created.skipDuplicates).toBe(true);
    expect(created.data.map((r: { fieldKey: string }) => r.fieldKey)).toEqual(["clientName", "seats"]);
    expect(created.data[0]).toMatchObject({ dealId: "d1", value: "Dana Reyes", status: "extracted" });
    // Read on the new template's terms.
    expect(applyExtraction).toHaveBeenCalledWith("d1", words(70), ["clientName", "seats"]);
  });

  it("does the same on the end-of-call reading, and keeps the template when the call picks the same one", async () => {
    db.deal.findMany.mockResolvedValue([started()]);
    db.phoneCall.findUnique.mockResolvedValue({ templateId: null });
    suggest.mockResolvedValue("tA");

    await refreshLiveDeals("pc1", words(70), { final: true });

    expect(suggest).toHaveBeenCalledTimes(1);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(applyExtraction).toHaveBeenCalledWith("d1", words(70), ["clientName", "fee", "startDate"]);
  });

  it("stays when the rep picked it, it was picked from enough words, a term is in, there's nothing to pick from, or too little was said", async () => {
    db.phoneCall.findUnique.mockResolvedValue({ templateId: null });
    const cases: { deal: object; templateId?: string; fields?: object[]; options?: object[]; said?: number }[] = [
      { deal: started(), templateId: "tA" },
      { deal: started({ lastExtractedTranscript: words(65) }) },
      { deal: started(), fields: [{ fieldKey: "fee", value: "$5,000" }] },
      { deal: started(), options: [templates[0]] },
      { deal: started(), said: 59 },
    ];
    for (const c of cases) {
      db.deal.findMany.mockResolvedValue([c.deal]);
      db.phoneCall.findUnique.mockResolvedValue({ templateId: c.templateId ?? null });
      db.dealField.findMany.mockResolvedValue(c.fields ?? []);
      db.contractTemplate.findMany.mockResolvedValue(c.options ?? templates);
      await refreshLiveDeals("pc1", words(c.said ?? 70), { final: true });
    }
    expect(suggest).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(applyExtraction).toHaveBeenCalledTimes(cases.length);
  });
});

describe("The end of a live call", () => {
  it("leaves each document a draft to review, names a New client from the call, then writes the notes", async () => {
    db.phoneCall.findUnique.mockResolvedValue({ transcript: "\nClient: I'm Dana.", leadId: "l1", user: { timezone: "Europe/Belgrade" } });
    db.deal.findMany
      .mockResolvedValueOnce([{ id: "d1", template: { clauses: "" } }])
      .mockResolvedValueOnce([
        { id: "d1", kind: "contract", status: "processing", workspaceId: "w1", templateId: "tA", clientId: "c1", client: { name: "New client", company: "New client" }, fields: [{ value: "Dana Reyes" }] },
      ]);
    db.dealField.count.mockResolvedValue(1);

    await finishLiveCall("pc1");

    expect(applyExtraction).toHaveBeenCalledWith("d1", "\nClient: I'm Dana.", ["clientName", "fee", "startDate"]);
    expect(db.deal.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "processing" }, data: { status: "missing_info" } });
    expect(db.contract.upsert).toHaveBeenCalledWith({ where: { dealId: "d1" }, create: { dealId: "d1", templateId: "tA", status: "draft" }, update: {} });
    expect(db.client.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { name: "Dana Reyes", company: "Dana Reyes" } });
    // The call points at the template its contract ended on.
    expect(db.phoneCall.update).toHaveBeenCalledWith({ where: { id: "pc1" }, data: { templateId: "tA" } });
    expect(dispatchCreated).toHaveBeenCalledWith("w1", "d1");
    expect(runProcessing).toHaveBeenCalledWith("pc1", "Europe/Belgrade", { force: true });
    // Announced once the notes settled which client the contract is on.
    expect(runProcessing.mock.invocationCallOrder[0]).toBeLessThan(dispatchCreated.mock.invocationCallOrder[0]);
    expect(refreshPipeline).toHaveBeenCalledWith("l1");
  });

  it("finishes a call the app never stopped from what it heard, a day on; one that heard nothing just ends", async () => {
    const now = new Date("2026-11-14T12:00:00Z");
    const startedAt = new Date("2026-11-13T09:00:00Z");
    const updatedAt = new Date("2026-11-13T09:20:00Z");
    db.phoneCall.findMany.mockResolvedValue([
      { id: "pc1", workspaceId: "w1", startedAt, updatedAt, transcript: "\nYou: Hi" },
      { id: "pc2", workspaceId: "w1", startedAt, updatedAt, transcript: null },
    ]);
    db.phoneCall.updateMany.mockResolvedValue({ count: 1 });
    db.phoneCall.findUnique.mockResolvedValue({ transcript: "\nYou: Hi", leadId: "l1", user: null });
    db.deal.findMany.mockResolvedValue([]);

    expect(await finishAbandonedLiveCalls(now)).toBe(2);
    expect(db.phoneCall.findMany.mock.calls[0][0].where).toEqual({ source: "desktop", status: "recording", updatedAt: { lt: new Date("2026-11-13T12:00:00Z") } });
    expect(db.phoneCall.updateMany.mock.calls[0][0]).toEqual({ where: { id: "pc1", status: "recording" }, data: { status: "processing", endedAt: updatedAt, durationSec: 1200 } });
    expect(db.phoneCall.updateMany.mock.calls[1][0].data).toMatchObject({ status: "skipped", extracted: { skipped: "no_speech" } });
    expect(db.localCaptureToken.updateMany).toHaveBeenCalledTimes(2);
    expect(runProcessing).toHaveBeenCalledTimes(1);
    expect(runProcessing).toHaveBeenCalledWith("pc1", "America/New_York", { force: true });
    expect(db.deal.updateMany).toHaveBeenCalledWith({ where: { phoneCallId: "pc2", status: "processing" }, data: { status: "missing_info" } });
    // The silent one is done, like any call nothing was heard on; the other
    // fires once it's written up.
    expect(dispatchCompleted).toHaveBeenCalledTimes(1);
    expect(dispatchCompleted).toHaveBeenCalledWith("w1", "pc2");
  });
});
