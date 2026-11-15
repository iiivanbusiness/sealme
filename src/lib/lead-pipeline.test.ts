import { describe, expect, it, vi } from "vitest";

const { lead, deal, webhook, leadsUpdated } = vi.hoisted(() => ({
  lead: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  deal: { findUnique: vi.fn(), update: vi.fn() },
  webhook: vi.fn(),
  leadsUpdated: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { lead, deal } }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: webhook }));
vi.mock("@/lib/webhook-events", () => ({ dispatchLeadsUpdated: leadsUpdated, leadChanges: (id: string) => ({ leadId: id, changed: ["stage"], previousStage: null }) }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));

import { leadIsInactive, markLeadClient, pipelineStageFor, refreshLeadPipeline, wentOut } from "./lead-pipeline";

const open = { isClient: false, pipelineStage: "new" };
const doc = (kind: string, status: string) => ({ kind, contract: { status } });

describe("Where a lead stands", () => {
  it("follows the lead's documents: a contract out beats a proposal out", () => {
    expect(pipelineStageFor(open, [])).toBe("new");
    expect(pipelineStageFor(open, [doc("proposal", "draft")])).toBe("new");
    expect(pipelineStageFor(open, [doc("proposal", "sent")])).toBe("proposal_sent");
    expect(pipelineStageFor(open, [doc("proposal", "sent"), doc("contract", "sent")])).toBe("contract_sent");
    expect(pipelineStageFor(open, [doc("contract", "partially_signed")])).toBe("contract_sent");
    // A deal with no contract row yet says nothing.
    expect(pipelineStageFor(open, [{ kind: "contract", contract: null }])).toBe("new");
  });

  it("calls a contract that ran out not signed when the lead was waiting on it", () => {
    const waiting = { isClient: false, pipelineStage: "contract_sent" };
    expect(pipelineStageFor(waiting, [doc("contract", "expired")])).toBe("not_signed");
    expect(pipelineStageFor(waiting, [doc("contract", "not_signed")])).toBe("not_signed");
    expect(pipelineStageFor({ ...waiting, pipelineStage: "not_signed" }, [doc("contract", "expired")])).toBe("not_signed");
    // A new proposal sent after that contract is still out with the client.
    const at = (day: string) => new Date(`2026-11-${day}T12:00:00Z`);
    expect(pipelineStageFor(waiting, [{ kind: "contract", contract: { status: "expired", sentAt: at("01") } }, { kind: "proposal", contract: { status: "sent", sentAt: at("05") } }])).toBe("proposal_sent");
    // Active again after a new call or Reactivate: the old contract is history.
    expect(pipelineStageFor(open, [doc("contract", "expired")])).toBe("new");
    // Working it out for the first time.
    expect(pipelineStageFor(open, [doc("contract", "expired")], { fromScratch: true })).toBe("not_signed");
  });

  it("counts only what really went to the client as out with them", () => {
    const at = new Date("2026-11-01");
    const sent = (kind: string, status: string) => ({ kind, contract: { status, sentAt: at } });
    // A reviewer sent it back before it ever went out: nothing's with the client.
    expect(pipelineStageFor(open, [{ kind: "contract", contract: { status: "changes_requested", sentAt: null } }])).toBe("new");
    // The client asked for changes, or a new version waits on approval: still theirs.
    expect(pipelineStageFor(open, [sent("contract", "changes_requested")])).toBe("contract_sent");
    expect(pipelineStageFor(open, [sent("contract", "pending_approval")])).toBe("contract_sent");
    expect(pipelineStageFor(open, [{ kind: "proposal", contract: { status: "pending_approval", sentAt: null } }])).toBe("new");
  });

  it("stops counting a proposal once a contract went out after it", () => {
    const at = (day: string) => new Date(`2026-11-${day}T12:00:00Z`);
    const dated = (kind: string, status: string, day: string | null) => ({ kind, contract: { status, sentAt: day ? at(day) : null } });
    const waiting = { isClient: false, pipelineStage: "contract_sent" };
    // The contract made from the proposal ran out, or the rep marked it not signed.
    expect(pipelineStageFor(waiting, [dated("proposal", "sent", "01"), dated("contract", "expired", "03")])).toBe("not_signed");
    expect(pipelineStageFor(waiting, [dated("proposal", "sent", "01"), dated("contract", "not_signed", "03")])).toBe("not_signed");
    // The latest contract decides, not the first one.
    expect(pipelineStageFor(waiting, [dated("contract", "expired", "01"), dated("proposal", "sent", "03"), dated("contract", "not_signed", "05")])).toBe("not_signed");
    // A proposal sent after the contract is a new offer, still out.
    expect(pipelineStageFor(waiting, [dated("contract", "not_signed", "01"), dated("proposal", "sent", "03")])).toBe("proposal_sent");
    // Without dates to compare, a contract that went out wins.
    expect(pipelineStageFor(waiting, [dated("proposal", "sent", null), dated("contract", "expired", "03")])).toBe("not_signed");
    expect(pipelineStageFor(waiting, [dated("proposal", "sent", "05"), dated("contract", "expired", null)])).toBe("not_signed");
    // A contract that never went out (a draft) doesn't answer the proposal.
    expect(pipelineStageFor({ ...open }, [dated("proposal", "sent", "01"), dated("contract", "draft", null)])).toBe("proposal_sent");
    // After Reactivate the old contract is history, and so is the proposal it answered.
    expect(pipelineStageFor(open, [dated("proposal", "sent", "01"), dated("contract", "expired", "03")])).toBe("new");
  });

  it("keeps clients clients, and leaves lost and not now to whoever set them", () => {
    expect(pipelineStageFor({ isClient: true, pipelineStage: "client" }, [doc("contract", "expired")])).toBe("client");
    expect(pipelineStageFor({ isClient: false, pipelineStage: "lost" }, [doc("contract", "sent")])).toBe("lost");
    expect(pipelineStageFor({ isClient: false, pipelineStage: "not_now" }, [])).toBe("not_now");
  });

  it("puts leads with nothing going on for 30 days on Inactive, never clients", () => {
    const now = new Date("2026-11-14");
    const base = { isClient: false, pipelineStage: "new", createdAt: new Date("2026-01-01") };
    expect(leadIsInactive({ ...base, lastActivityAt: new Date("2026-11-01") }, now)).toBe(false);
    expect(leadIsInactive({ ...base, lastActivityAt: new Date("2026-10-01") }, now)).toBe(true);
    expect(leadIsInactive({ ...base, lastActivityAt: null }, now)).toBe(true);
    expect(leadIsInactive({ ...base, pipelineStage: "lost", lastActivityAt: new Date("2026-11-13") }, now)).toBe(true);
    expect(leadIsInactive({ ...base, isClient: true, pipelineStage: "client", lastActivityAt: null }, now)).toBe(false);
  });

  it("writes the stage only when it moved, and only over the stage it read", async () => {
    lead.updateMany.mockClear();
    lead.updateMany.mockResolvedValue({ count: 1 });
    lead.findUnique.mockResolvedValueOnce({ ...open, deals: [doc("contract", "sent")] });
    await refreshLeadPipeline("l1");
    // A signature or Mark as lost that landed in between isn't undone.
    expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1", isClient: false, pipelineStage: "new" }, data: expect.objectContaining({ pipelineStage: "contract_sent" }) });

    lead.updateMany.mockClear();
    lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "contract_sent", deals: [doc("contract", "sent")] });
    await refreshLeadPipeline("l1");
    expect(lead.updateMany).not.toHaveBeenCalled();
    await refreshLeadPipeline(null);
    expect(lead.findUnique).toHaveBeenCalledTimes(2);
  });

  it("counts a document going out as activity, but not one running out on its own", async () => {
    lead.updateMany.mockClear();
    lead.updateMany.mockResolvedValue({ count: 1 });
    lead.findUnique.mockResolvedValueOnce({ ...open, deals: [doc("proposal", "sent")] });
    await refreshLeadPipeline("l1", { sentNow: true });
    expect(lead.updateMany).toHaveBeenCalledTimes(1);
    expect(lead.updateMany.mock.calls[0][0].data).toEqual({ pipelineStage: "proposal_sent", lastActivityAt: expect.any(Date) });

    // Expiry drops contract_sent back: a stage change, but nobody did anything.
    lead.updateMany.mockClear();
    lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "contract_sent", deals: [doc("contract", "expired")] });
    await refreshLeadPipeline("l1");
    expect(lead.updateMany.mock.calls[0][0].data).toEqual({ pipelineStage: "not_signed" });

    // A stage change found later (a move, a restore) isn't a send either.
    lead.updateMany.mockClear();
    lead.findUnique.mockResolvedValueOnce({ ...open, deals: [doc("contract", "sent")] });
    await refreshLeadPipeline("l1");
    expect(lead.updateMany.mock.calls[0][0].data).toEqual({ pipelineStage: "contract_sent" });
  });

  it("moves a lead to Not signed when the rep marks its contract not signed, even after Reactivate", async () => {
    lead.updateMany.mockClear();
    lead.updateMany.mockResolvedValue({ count: 1 });
    lead.findUnique.mockResolvedValueOnce({ ...open, deals: [doc("contract", "not_signed")] });
    await refreshLeadPipeline("l1", { unsignedNow: true });
    expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1", isClient: false, pipelineStage: "new" }, data: { pipelineStage: "not_signed" } });

    // Something else still out with the client keeps the lead where it is.
    lead.updateMany.mockClear();
    lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "contract_sent", deals: [doc("contract", "not_signed"), doc("contract", "sent")] });
    await refreshLeadPipeline("l1", { unsignedNow: true });
    expect(lead.updateMany).not.toHaveBeenCalled();

    // Lost stays lost, and a client stays a client.
    lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "lost", deals: [doc("contract", "not_signed")] });
    await refreshLeadPipeline("l1", { unsignedNow: true });
    lead.findUnique.mockResolvedValueOnce({ isClient: true, pipelineStage: "client", deals: [doc("contract", "not_signed")] });
    await refreshLeadPipeline("l1", { unsignedNow: true });
    expect(lead.updateMany).not.toHaveBeenCalled();

    // Without it, a lead that wasn't waiting on the contract stays new.
    lead.findUnique.mockResolvedValueOnce({ ...open, deals: [doc("contract", "not_signed")] });
    await refreshLeadPipeline("l1");
    expect(lead.updateMany).not.toHaveBeenCalled();
  });

  it("brings a lead set aside back when the rep sends it a document", async () => {
    lead.updateMany.mockClear();
    leadsUpdated.mockClear();
    lead.updateMany.mockResolvedValue({ count: 1 });
    lead.findUnique.mockResolvedValueOnce({ workspaceId: "w1", isClient: false, pipelineStage: "lost", stage: "lost", deals: [doc("proposal", "sent")] });
    await refreshLeadPipeline("l1", { sentNow: true });
    expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1", isClient: false, pipelineStage: "lost" }, data: { pipelineStage: "proposal_sent", lastActivityAt: expect.any(Date), stage: "contacted" } });
    expect(leadsUpdated).toHaveBeenCalledTimes(1);

    // Not now comes back the same way; the API stage wasn't "lost", so it stays.
    lead.updateMany.mockClear();
    leadsUpdated.mockClear();
    lead.findUnique.mockResolvedValueOnce({ workspaceId: "w1", isClient: false, pipelineStage: "not_now", stage: "interested", deals: [doc("contract", "sent")] });
    await refreshLeadPipeline("l1", { sentNow: true });
    expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1", isClient: false, pipelineStage: "not_now" }, data: { pipelineStage: "contract_sent", lastActivityAt: expect.any(Date) } });
    expect(leadsUpdated).not.toHaveBeenCalled();

    // Without a send (a contract running out, a restore), Lost stays lost.
    lead.updateMany.mockClear();
    lead.findUnique.mockResolvedValueOnce({ workspaceId: "w1", isClient: false, pipelineStage: "lost", stage: "lost", deals: [doc("proposal", "sent")] });
    await refreshLeadPipeline("l1");
    expect(lead.updateMany).not.toHaveBeenCalled();
  });

  it("counts a re-send as activity even when the stage stays put", async () => {
    lead.updateMany.mockClear();
    lead.updateMany.mockResolvedValue({ count: 1 });
    lead.findUnique.mockResolvedValueOnce({ isClient: false, pipelineStage: "contract_sent", deals: [doc("contract", "sent")] });
    await refreshLeadPipeline("l1", { sentNow: true });
    expect(lead.updateMany).toHaveBeenCalledTimes(1);
    expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1" }, data: { lastActivityAt: expect.any(Date) } });

    // An amendment sent to a client.
    lead.updateMany.mockClear();
    lead.findUnique.mockResolvedValueOnce({ isClient: true, pipelineStage: "client", deals: [doc("contract", "sent")] });
    await refreshLeadPipeline("l1", { sentNow: true });
    expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1" }, data: { lastActivityAt: expect.any(Date) } });
  });

  it("still counts the send when the stage moved meanwhile", async () => {
    lead.updateMany.mockClear();
    // Someone marked it lost between the read and the write.
    lead.updateMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    lead.findUnique.mockResolvedValueOnce({ ...open, deals: [doc("proposal", "sent")] });
    await refreshLeadPipeline("l1", { sentNow: true });
    expect(lead.updateMany).toHaveBeenCalledTimes(2);
    expect(lead.updateMany.mock.calls[1][0]).toEqual({ where: { id: "l1" }, data: { lastActivityAt: expect.any(Date) } });
  });

  it("counts what ever went to the client as gone out, even without a send date", () => {
    expect(wentOut({ status: "draft", sentAt: null })).toBe(false);
    expect(wentOut({ status: "pending_approval", sentAt: null })).toBe(false);
    expect(wentOut({ status: "changes_requested", sentAt: new Date() })).toBe(true);
    // A signed contract brought in from a spreadsheet.
    expect(wentOut({ status: "signed", sentAt: null })).toBe(true);
    expect(wentOut({ status: "expired", sentAt: null })).toBe(true);
  });
});

const { leadForClient } = vi.hoisted(() => ({ leadForClient: vi.fn() }));
vi.mock("@/lib/client-lead", () => ({ leadForClient }));

describe("A signed contract makes a client", () => {
  const client = { id: "c1", name: "Dana", company: "Acme", email: "dana@acme.test", phone: null };
  const signed = (over: object) => ({
    id: "d1",
    workspaceId: "w1",
    kind: "contract",
    clientId: "c1",
    ownerId: "u1",
    trashedAt: null,
    client,
    lead: { id: "l1", name: "Dana", company: "Acme", isClient: false, stage: "meeting", convertedAt: null, convertedClientId: null, convertedDealId: null, ...over },
  });

  it("marks the lead a client once and tells the API it converted", async () => {
    deal.findUnique.mockResolvedValueOnce(signed({}));
    lead.updateMany.mockResolvedValueOnce({ count: 1 });
    await markLeadClient("d1");
    expect(lead.updateMany).toHaveBeenCalledWith({
      where: { id: "l1", isClient: false },
      data: expect.objectContaining({ isClient: true, pipelineStage: "client", stage: "converted", convertedClientId: "c1", convertedDealId: "d1" }),
    });
    expect(webhook).toHaveBeenCalledWith("w1", "lead.converted", expect.objectContaining({ leadId: "l1", dealId: "d1", clientId: "c1" }));
  });

  it("doesn't announce a lead twice, or one older code already announced", async () => {
    webhook.mockClear();
    deal.findUnique.mockResolvedValueOnce(signed({ stage: "converted", convertedDealId: "d0" }));
    lead.updateMany.mockResolvedValueOnce({ count: 1 });
    await markLeadClient("d1");
    expect(webhook).not.toHaveBeenCalled();

    // A second signature (an amendment) on a lead that's already a client.
    deal.findUnique.mockResolvedValueOnce(signed({ isClient: true, stage: "converted", convertedDealId: "d1" }));
    lead.updateMany.mockClear();
    await markLeadClient("d1");
    expect(lead.updateMany).not.toHaveBeenCalled();
    expect(webhook).not.toHaveBeenCalled();
  });

  it("announces a lead someone set to converted by hand, and clients marked when old deals were linked", async () => {
    webhook.mockClear();
    deal.findUnique.mockResolvedValueOnce(signed({ stage: "converted" }));
    lead.updateMany.mockResolvedValueOnce({ count: 1 });
    await markLeadClient("d1");
    expect(webhook).toHaveBeenCalledWith("w1", "lead.converted", expect.anything());

    webhook.mockClear();
    lead.update.mockClear();
    deal.findUnique.mockResolvedValueOnce(signed({ isClient: true, stage: "meeting" }));
    await markLeadClient("d1");
    expect(lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: expect.objectContaining({ stage: "converted", convertedDealId: "d1" }) });
    expect(webhook).toHaveBeenCalledWith("w1", "lead.converted", expect.anything());
  });

  it("makes a lead that was lost, not now or not signed a client too", async () => {
    for (const pipelineStage of ["lost", "not_now", "not_signed"]) {
      lead.updateMany.mockClear();
      deal.findUnique.mockResolvedValueOnce(signed({ pipelineStage, stage: pipelineStage === "lost" ? "lost" : "contacted" }));
      lead.updateMany.mockResolvedValueOnce({ count: 1 });
      await markLeadClient("d1");
      expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1", isClient: false }, data: expect.objectContaining({ isClient: true, pipelineStage: "client", stage: "converted" }) });
    }
  });

  it("ties a client that's already one to the client it became, when nothing did yet", async () => {
    lead.update.mockClear();
    deal.findUnique.mockResolvedValueOnce(signed({ isClient: true, stage: "converted", convertedDealId: "d0", convertedClientId: null }));
    await markLeadClient("d1");
    expect(lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: expect.objectContaining({ pipelineStage: "client", convertedClientId: "c1" }) });

    lead.update.mockClear();
    deal.findUnique.mockResolvedValueOnce(signed({ isClient: true, stage: "converted", convertedDealId: "d0", convertedClientId: "c0" }));
    await markLeadClient("d1");
    expect(lead.update.mock.calls[0][0].data).not.toHaveProperty("convertedClientId");
  });

  it("finds or makes the lead of a deal that has none, links it and makes it a client", async () => {
    webhook.mockClear();
    lead.updateMany.mockClear();
    deal.update.mockClear();
    leadForClient.mockClear();
    deal.findUnique.mockResolvedValueOnce({ ...signed({}), lead: null });
    leadForClient.mockResolvedValueOnce("l9");
    lead.findUnique.mockResolvedValueOnce({ id: "l9", name: "Dana", company: "Acme", isClient: false, stage: "new", convertedAt: null, convertedClientId: "c1", convertedDealId: null });
    lead.updateMany.mockResolvedValueOnce({ count: 1 });
    await markLeadClient("d1");
    expect(leadForClient).toHaveBeenCalledWith("w1", client, { ownerId: "u1" });
    expect(deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { leadId: "l9" } });
    expect(lead.updateMany).toHaveBeenCalledWith({ where: { id: "l9", isClient: false }, data: expect.objectContaining({ isClient: true, pipelineStage: "client", convertedDealId: "d1" }) });
    expect(webhook).toHaveBeenCalledWith("w1", "lead.converted", expect.objectContaining({ leadId: "l9", dealId: "d1" }));
  });

  it("leaves proposals and deals in the trash alone", async () => {
    lead.updateMany.mockClear();
    lead.update.mockClear();
    leadForClient.mockClear();
    deal.findUnique.mockResolvedValueOnce({ ...signed({}), kind: "proposal" });
    await markLeadClient("d1");
    deal.findUnique.mockResolvedValueOnce({ ...signed({}), trashedAt: new Date() });
    await markLeadClient("d1");
    deal.findUnique.mockResolvedValueOnce({ ...signed({}), lead: null, trashedAt: new Date() });
    await markLeadClient("d1");
    expect(lead.updateMany).not.toHaveBeenCalled();
    expect(lead.update).not.toHaveBeenCalled();
    expect(leadForClient).not.toHaveBeenCalled();
  });
});
