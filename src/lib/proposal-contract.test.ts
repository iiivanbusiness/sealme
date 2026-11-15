import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, suggestTemplateId, extractDealFromTranscript, logAudit, reportError, announceNewDeal, requestOrSendReview, revalidatePath, afterCallbacks } = vi.hoisted(() => {
  const prisma = {
    user: { findFirst: vi.fn() },
    deal: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    contractTemplate: { findMany: vi.fn() },
    phoneCall: { updateMany: vi.fn(), count: vi.fn() },
    lead: { updateMany: vi.fn() },
    client: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    prisma,
    suggestTemplateId: vi.fn(),
    extractDealFromTranscript: vi.fn(),
    logAudit: vi.fn(),
    reportError: vi.fn(),
    announceNewDeal: vi.fn(),
    requestOrSendReview: vi.fn(),
    revalidatePath: vi.fn(),
    afterCallbacks: [] as (() => unknown)[],
  };
});
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/call-deal", () => ({ suggestTemplateId }));
vi.mock("@/lib/extract-deal", () => ({ extractDealFromTranscript }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead from a call", PLACEHOLDER_CLIENT: "New client" }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/error-report", () => ({ reportError }));
// Where a rep's Send goes; making a contract from a proposal never gets there.
vi.mock("@/lib/review", () => ({ requestOrSendReview }));
// The server action's own surroundings.
vi.mock("@/lib/api-deals", () => ({ announceNewDeal }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void afterCallbacks.push(fn) }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: { OR: [{ ownerId: "u1" }] }, userId: "u1" }) }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: async () => ({ id: "u1", teamId: "t1", role: null }) }));

import { createContractFromProposal } from "./proposal-contract";
import { createContractFromProposalAction } from "@/app/(app)/deals/[id]/proposal-actions";

type Row = { fieldKey: string; value: string | null; status: string; label: string; groupLabel: string; sourceQuote: string | null; confidence: number | null; orderIndex: number };

function field(fieldKey: string, value: string | null, orderIndex: number) {
  return { id: `f-${fieldKey}`, dealId: "p1", groupLabel: "Proposal terms", label: `Proposal ${fieldKey}`, fieldKey, value, status: "extracted", confidence: 0.9, sourceQuote: `said ${fieldKey}`, orderIndex };
}

function makeProposal(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    workspaceId: "w1",
    clientId: "c1",
    leadId: "l1",
    phoneCallId: "pc1",
    kind: "proposal",
    service: "a twelve-week sales program",
    feeDisplay: "$4,000 / month",
    summary: "They want coaching for 8 SDRs.",
    liveTranscript: null,
    fields: [
      field("clientName", "Acme Inc", -1),
      field("service", "a twelve-week sales program", 0),
      field("fee", "$4,000 / month", 1),
      field("startDate", "March 1", 2),
      field("roiEstimate", "3x pipeline", 3),
    ],
    client: { id: "c1", name: "Jane Doe", company: "Acme Inc", email: "jane@acme.test", phone: "+15555550100", billingAddress: null },
    lead: { id: "l1", name: "Jane Doe", title: "VP Sales", email: "jane@acme.test", phone: "+15555550100" },
    phoneCall: { id: "pc1", status: "processed", transcript: "We agreed on net 30.", templateId: null },
    calls: [],
    derivedDeals: [],
    ...over,
  };
}

// deal.findFirst serves three lookups: the proposal (include), the server
// action's visibility check (select, kind "proposal") and the call's own
// contract (kind "not proposal"), which is callContract (none by default).
function proposalIs(proposal: ReturnType<typeof makeProposal> | null, callContract: { id: string; status: string } | null = null) {
  prisma.deal.findFirst.mockImplementation(async (args: { where?: { kind?: unknown }; select?: unknown }) => {
    if (args.where?.kind && typeof args.where.kind === "object") return callContract;
    if (args.select) return proposal && { id: "p1", leadId: "l1" };
    return proposal;
  });
}

function template(id: string, keys: string[], name = id) {
  return { id, name, description: "", clauses: JSON.stringify([{ title: "Terms", body: keys.map((k) => `{${k}}`).join(" and ") }]) };
}

function createdData() {
  expect(prisma.deal.create).toHaveBeenCalledTimes(1);
  return prisma.deal.create.mock.calls[0][0].data as Record<string, unknown> & { fields: { create: Row[] } };
}

function rowFor(key: string): Row | undefined {
  return createdData().fields.create.find((r) => r.fieldKey === key);
}

beforeEach(() => {
  vi.clearAllMocks();
  afterCallbacks.length = 0;
  prisma.user.findFirst.mockResolvedValue({ id: "u1", workspaceId: "w1", teamId: "t1", email: "rep@agency.test" });
  proposalIs(makeProposal());
  prisma.deal.create.mockResolvedValue({ id: "new1" });
  prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["clientName", "service", "fee", "startDate"])]);
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  suggestTemplateId.mockImplementation(async (_t: string, list: { id: string }[]) => list[0].id);
  announceNewDeal.mockResolvedValue(undefined);
});

describe("Contract from a proposal: terms", () => {
  it("copies every field the two templates share, with the same values", async () => {
    const made = await createContractFromProposal("p1", "u1");

    expect(made).toEqual({ dealId: "new1", existed: false, hasMissing: false });
    const data = createdData();
    expect(data).toMatchObject({
      workspaceId: "w1",
      clientId: "c1",
      leadId: "l1",
      phoneCallId: "pc1",
      sourceDealId: "p1",
      kind: "contract",
      templateId: "ct-a",
      ownerId: "u1",
      teamId: "t1",
      service: "a twelve-week sales program",
      feeDisplay: "$4,000 / month",
      summary: "They want coaching for 8 SDRs.",
      status: "ready",
      source: "proposal",
      contract: { create: { templateId: "ct-a", status: "draft" } },
    });
    for (const key of ["clientName", "service", "fee", "startDate"]) {
      const original = makeProposal().fields.find((f) => f.fieldKey === key);
      expect(rowFor(key)).toMatchObject({ value: original?.value, label: original?.label, groupLabel: original?.groupLabel, sourceQuote: original?.sourceQuote, status: "confirmed" });
    }
    // In the contract template's order.
    expect(data.fields.create.map((r) => r.fieldKey)).toEqual(["clientName", "service", "fee", "startDate"]);
    // Nothing was missing, so the call wasn't read again.
    expect(extractDealFromTranscript).not.toHaveBeenCalled();
    expect(prisma.phoneCall.updateMany).toHaveBeenCalledWith({ where: { id: "pc1" }, data: { dealId: "new1", templateId: "ct-a" } });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: "l1" }, data: { lastActivityAt: expect.any(Date) } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "deal.contract_from_proposal", targetId: "new1", metadata: { fromDealId: "p1" } }));
  });

  it("drops a field only the proposal has", async () => {
    await createContractFromProposal("p1", "u1");
    expect(rowFor("roiEstimate")).toBeUndefined();
  });

  it("fills a contract-only field from the lead, then from the call, and leaves the rest missing", async () => {
    prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["clientName", "service", "clientSignerTitle", "paymentTerms", "governingLaw"])]);
    extractDealFromTranscript.mockResolvedValue({
      clientName: "Jane Doe",
      company: null,
      email: null,
      summary: null,
      fields: [
        { fieldKey: "service", value: "something else", sourceQuote: "x", confidence: 0.5 },
        { fieldKey: "paymentTerms", value: "Net 30", sourceQuote: "We agreed on net 30.", confidence: 0.9 },
        { fieldKey: "governingLaw", value: null, sourceQuote: null, confidence: 0 },
      ],
    });

    const made = await createContractFromProposal("p1", "u1");

    expect(made.hasMissing).toBe(true);
    expect(rowFor("clientSignerTitle")).toMatchObject({ value: "VP Sales", status: "confirmed" });
    // One reading, for just what's still unknown.
    expect(extractDealFromTranscript).toHaveBeenCalledTimes(1);
    expect(extractDealFromTranscript).toHaveBeenCalledWith("We agreed on net 30.", ["paymentTerms", "governingLaw"]);
    expect(rowFor("paymentTerms")).toMatchObject({ value: "Net 30", status: "extracted", sourceQuote: "We agreed on net 30.", confidence: 0.9 });
    expect(rowFor("governingLaw")).toMatchObject({ value: null, status: "missing", label: "Governing law", groupLabel: "Deal details" });
    // A shared field the proposal filled isn't read over.
    expect(rowFor("service")).toMatchObject({ value: "a twelve-week sales program", status: "confirmed" });
    expect(createdData().status).toBe("missing_info");
  });

  it("leaves the gaps missing when reading the call fails", async () => {
    prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["clientName", "paymentTerms"])]);
    extractDealFromTranscript.mockRejectedValue(new Error("overloaded"));

    const made = await createContractFromProposal("p1", "u1");

    expect(made.hasMissing).toBe(true);
    expect(rowFor("paymentTerms")).toMatchObject({ value: null, status: "missing" });
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("doesn't read the call when there's no transcript", async () => {
    proposalIs(makeProposal({ phoneCall: null, phoneCallId: null }));
    prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["clientName", "paymentTerms"])]);

    await createContractFromProposal("p1", "u1");

    expect(extractDealFromTranscript).not.toHaveBeenCalled();
    expect(rowFor("paymentTerms")?.status).toBe("missing");
    expect(prisma.phoneCall.updateMany).not.toHaveBeenCalled();
  });

  it("takes service and fee from the proposal itself when its template never asked for them", async () => {
    proposalIs(makeProposal({ fields: [field("clientName", "Acme Inc", -1), field("startDate", "March 1", 0)] }));

    const made = await createContractFromProposal("p1", "u1");

    expect(made.hasMissing).toBe(false);
    expect(rowFor("service")).toMatchObject({ value: "a twelve-week sales program", status: "confirmed", label: "Service" });
    expect(rowFor("fee")).toMatchObject({ value: "$4,000 / month", status: "confirmed", label: "Fee" });
    expect(createdData()).toMatchObject({ service: "a twelve-week sales program", feeDisplay: "$4,000 / month" });
  });

  it("names the client when the contract template doesn't ask for it", async () => {
    prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["service", "fee"])]);

    await createContractFromProposal("p1", "u1");

    expect(createdData().fields.create[0]).toMatchObject({ fieldKey: "clientName", value: "Acme Inc", status: "confirmed", orderIndex: -1 });
  });

  it("asks for an email when neither the client nor the lead has one, and takes the lead's when it has one", async () => {
    const noEmail = { id: "c1", name: "Jane Doe", company: "Acme Inc", email: null, phone: null, billingAddress: null };
    proposalIs(makeProposal({ client: noEmail, lead: { id: "l1", name: "Jane Doe", title: null, email: null, phone: null } }));

    const made = await createContractFromProposal("p1", "u1");
    expect(made.hasMissing).toBe(true);
    expect(rowFor("clientEmail")).toMatchObject({ value: null, status: "missing", label: "Client email" });
    expect(prisma.client.updateMany).not.toHaveBeenCalled();

    vi.clearAllMocks();
    prisma.deal.create.mockResolvedValue({ id: "new1" });
    proposalIs(makeProposal({ client: noEmail, lead: { id: "l1", name: "Jane Doe", title: null, email: "Jane@Acme.test", phone: null } }));
    const second = await createContractFromProposal("p1", "u1");
    expect(second.hasMissing).toBe(false);
    expect(rowFor("clientEmail")).toMatchObject({ value: "Jane@Acme.test", status: "confirmed" });
    // The client gets it too, so the send page has someone to send to.
    expect(prisma.client.updateMany).toHaveBeenCalledWith({ where: { id: "c1", email: null }, data: { email: "jane@acme.test" } });
  });

  it("never gives a signer the name of an unnamed lead", async () => {
    prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["clientName", "clientSignerName"])]);
    proposalIs(
      makeProposal({ phoneCall: null, phoneCallId: null, lead: { id: "l1", name: "New lead from a call", title: null, email: null, phone: null }, client: { id: "c1", name: "Jane Doe", company: "Acme Inc", email: "jane@acme.test", phone: null, billingAddress: null } }),
    );

    await createContractFromProposal("p1", "u1");

    expect(rowFor("clientSignerName")).toMatchObject({ value: "Jane Doe", status: "confirmed" });
  });

  it("never makes the call's \"New client\" who the contract is with, or who signs it", async () => {
    prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["clientName", "clientSignerName"])]);
    const unnamed = { id: "l1", name: "New lead from a call", company: null, title: null, email: null, phone: null };
    const placeholder = { id: "c1", name: "New client", company: "New client", email: "jane@acme.test", phone: null, billingAddress: null };
    proposalIs(makeProposal({ phoneCall: null, phoneCallId: null, fields: [field("service", "coaching", 0)], lead: unnamed, client: placeholder }));

    const made = await createContractFromProposal("p1", "u1");

    expect(made.hasMissing).toBe(true);
    expect(rowFor("clientName")).toMatchObject({ value: null, status: "missing" });
    expect(rowFor("clientSignerName")).toMatchObject({ value: null, status: "missing" });
    expect(createdData().status).toBe("missing_info");
  });

  it("takes who it's with from the lead when the client is still \"New client\"", async () => {
    const lead = { id: "l1", name: "New lead from a call", company: "Globex", title: null, email: null, phone: null };
    const placeholder = { id: "c1", name: "New client", company: "Globex", email: "x@globex.test", phone: null, billingAddress: null };
    proposalIs(makeProposal({ phoneCall: null, phoneCallId: null, fields: [field("service", "coaching", 0)], lead, client: { ...placeholder, company: "New client" } }));

    await createContractFromProposal("p1", "u1");

    expect(rowFor("clientName")).toMatchObject({ value: "Globex", status: "confirmed" });
  });

  it("belongs to the proposal's owner, even when someone else clicked", async () => {
    proposalIs(makeProposal({ ownerId: "u2" }));
    prisma.user.findFirst
      .mockResolvedValueOnce({ id: "u1", workspaceId: "w1", teamId: "t1", email: "manager@agency.test" })
      .mockResolvedValueOnce({ id: "u2", teamId: "t2" });

    await createContractFromProposal("p1", "u1");

    expect(prisma.user.findFirst).toHaveBeenLastCalledWith({ where: { id: "u2", workspaceId: "w1", deactivatedAt: null }, select: { id: true, teamId: true } });
    expect(createdData()).toMatchObject({ ownerId: "u2", teamId: "t2" });
  });

  it("falls back to whoever clicked when the owner is gone", async () => {
    proposalIs(makeProposal({ ownerId: "u2" }));
    prisma.user.findFirst.mockResolvedValueOnce({ id: "u1", workspaceId: "w1", teamId: "t1", email: "manager@agency.test" }).mockResolvedValueOnce(null);

    await createContractFromProposal("p1", "u1");

    expect(createdData()).toMatchObject({ ownerId: "u1", teamId: "t1" });
  });
});

describe("Contract from a proposal: template", () => {
  const two = [template("ct-a", ["clientName", "service"], "Retainer"), template("ct-b", ["clientName", "fee"], "Project")];

  it("ignores the call's template when it's a proposal template", async () => {
    proposalIs(makeProposal({ phoneCall: { id: "pc1", status: "processed", transcript: "We agreed on net 30.", templateId: "pt-1" } }));
    prisma.contractTemplate.findMany.mockResolvedValue(two);
    suggestTemplateId.mockResolvedValue("ct-b");

    await createContractFromProposal("p1", "u1");

    expect(prisma.contractTemplate.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w1", kind: { not: "proposal" } } }));
    expect(suggestTemplateId).toHaveBeenCalledWith("We agreed on net 30.", two);
    expect(createdData()).toMatchObject({ templateId: "ct-b", contract: { create: { templateId: "ct-b", status: "draft" } } });
  });

  it("uses the call's contract template, and the rep's pick over both", async () => {
    proposalIs(makeProposal({ phoneCall: { id: "pc1", status: "processed", transcript: "x", templateId: "ct-b" } }));
    prisma.contractTemplate.findMany.mockResolvedValue(two);

    await createContractFromProposal("p1", "u1");
    expect(createdData().templateId).toBe("ct-b");
    expect(suggestTemplateId).not.toHaveBeenCalled();

    prisma.deal.create.mockClear();
    await createContractFromProposal("p1", "u1", { templateId: "ct-a" });
    expect(createdData().templateId).toBe("ct-a");

    // A pick that isn't one of the workspace's contract templates is ignored.
    prisma.deal.create.mockClear();
    await createContractFromProposal("p1", "u1", { templateId: "pt-1" });
    expect(createdData().templateId).toBe("ct-b");
  });

  it("picks from the proposal's terms when there's no call to read", async () => {
    proposalIs(makeProposal({ phoneCall: null, phoneCallId: null }));
    prisma.contractTemplate.findMany.mockResolvedValue(two);

    await createContractFromProposal("p1", "u1");

    const [text] = suggestTemplateId.mock.calls[0];
    expect(text).toContain("They want coaching for 8 SDRs.");
    expect(text).toContain("Proposal startDate: March 1");
  });
});

describe("Contract from a proposal: when it isn't made", () => {
  it("returns the contract the proposal already has", async () => {
    proposalIs(makeProposal({ derivedDeals: [{ id: "old1", status: "ready" }] }));

    expect(await createContractFromProposal("p1", "u1")).toEqual({ dealId: "old1", existed: true, hasMissing: false });
    expect(prisma.deal.create).not.toHaveBeenCalled();
    expect(prisma.contractTemplate.findMany).not.toHaveBeenCalled();
  });

  it("returns the contract the call already made, and links it to the proposal", async () => {
    proposalIs(makeProposal(), { id: "c9", status: "missing_info" });

    expect(await createContractFromProposal("p1", "u1")).toEqual({ dealId: "c9", existed: true, hasMissing: true });
    expect(prisma.deal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { workspaceId: "w1", phoneCallId: "pc1", kind: { not: "proposal" }, trashedAt: null } }));
    expect(prisma.deal.updateMany).toHaveBeenCalledWith({ where: { id: "c9", sourceDealId: null }, data: { sourceDealId: "p1" } });
    expect(prisma.deal.create).not.toHaveBeenCalled();
    expect(prisma.phoneCall.updateMany).not.toHaveBeenCalled();
  });

  it("goes by an old call's pointer only when it's that call's alone", async () => {
    const oldCall = { id: "pc1", leadId: "l1", dealId: "old9", status: "processed", transcript: "x", templateId: null };
    prisma.phoneCall.count.mockResolvedValue(0);
    let lookups = 0;
    prisma.deal.findFirst.mockImplementation(async (args: { where?: { id?: string; kind?: unknown } }) => {
      if (args.where?.kind && typeof args.where.kind === "object") return args.where.id === "old9" ? { id: "old9", status: "ready" } : null;
      lookups++;
      return makeProposal({ phoneCall: oldCall });
    });

    expect(await createContractFromProposal("p1", "u1")).toEqual({ dealId: "old9", existed: true, hasMissing: false });
    expect(prisma.phoneCall.count).toHaveBeenCalledWith({ where: { leadId: "l1", dealId: "old9", id: { not: "pc1" }, status: { in: ["processed", "processing", "recording"] } } });
    expect(lookups).toBe(1);

    // Shared with another call on the lead: it's the lead's one old deal, so a
    // contract is made and the call keeps pointing where it did.
    prisma.phoneCall.count.mockResolvedValue(1);
    expect((await createContractFromProposal("p1", "u1")).existed).toBe(false);
    expect(prisma.phoneCall.updateMany).toHaveBeenCalledWith({ where: { id: "pc1" }, data: { templateId: "ct-a" } });
  });

  it("waits while SealMe is still writing the contract the call asked for", async () => {
    const writing = { id: "pc1", status: "processed", transcript: "x", templateId: null, wantsContract: true, processedAt: new Date(), extracted: null };
    proposalIs(makeProposal({ phoneCall: writing }));
    await expect(createContractFromProposal("p1", "u1")).rejects.toThrow("SealMe is still writing up the call. Try again in a minute.");
    expect(prisma.deal.create).not.toHaveBeenCalled();

    // Writing it failed: nothing is coming, so the rep's click makes it.
    proposalIs(makeProposal({ phoneCall: { ...writing, extracted: { docFailed: { contract: true } } } }));
    expect((await createContractFromProposal("p1", "u1")).existed).toBe(false);

    // Long after the call: whatever was coming would be here by now.
    prisma.deal.create.mockClear();
    proposalIs(makeProposal({ phoneCall: { ...writing, processedAt: new Date(Date.now() - 10 * 60 * 1000) } }));
    expect((await createContractFromProposal("p1", "u1")).existed).toBe(false);
  });

  it("refuses while the call is still going or being written up", async () => {
    for (const [status, message] of [
      ["recording", "Finish the call first"],
      ["dialing", "Finish the call first"],
      ["processing", "SealMe is still writing up the call. Try again in a minute."],
    ]) {
      proposalIs(makeProposal({ phoneCall: { id: "pc1", status, transcript: "so far", templateId: null } }));
      await expect(createContractFromProposal("p1", "u1")).rejects.toThrow(message);
    }
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  it("needs a contract template", async () => {
    prisma.contractTemplate.findMany.mockResolvedValue([]);
    await expect(createContractFromProposal("p1", "u1")).rejects.toThrow("Add a contract template first");
    expect(suggestTemplateId).not.toHaveBeenCalled();
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  it("only works on a live proposal in the rep's workspace", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    await expect(createContractFromProposal("p1", "u1")).rejects.toThrow("Proposal not found");
    expect(prisma.deal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "p1", workspaceId: "w1", kind: "proposal", trashedAt: null } }));
  });
});

describe("Create contract from proposal (server action)", () => {
  beforeEach(() => {
    // The action's visibility check selects; the lib's load includes.
    proposalIs(makeProposal());
  });

  it("makes a draft, announces it once after the response, and never sends it", async () => {
    const result = await createContractFromProposalAction("p1");

    expect(result).toEqual({ dealId: "new1", hasMissing: false });
    expect(prisma.deal.findFirst.mock.calls[0][0].where).toEqual({ id: "p1", workspaceId: "w1", kind: "proposal", trashedAt: null, OR: [{ ownerId: "u1" }] });
    expect(announceNewDeal).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(announceNewDeal).toHaveBeenCalledTimes(1);
    expect(announceNewDeal).toHaveBeenCalledWith("w1", "new1");
    expect(requestOrSendReview).not.toHaveBeenCalled();
    expect(createdData()).toMatchObject({ contract: { create: { status: "draft" } } });
    expect(revalidatePath).toHaveBeenCalledWith("/deals/p1");
    expect(revalidatePath).toHaveBeenCalledWith("/deals/p1/contract");
    expect(revalidatePath).toHaveBeenCalledWith("/leads/l1");
  });

  it("opens the existing contract without announcing it again", async () => {
    proposalIs(makeProposal({ derivedDeals: [{ id: "old1", status: "missing_info" }] }));

    expect(await createContractFromProposalAction("p1")).toEqual({ dealId: "old1", hasMissing: true });
    expect(afterCallbacks).toHaveLength(0);
    expect(prisma.deal.create).not.toHaveBeenCalled();
  });

  it("says when the proposal can't be seen", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    expect(await createContractFromProposalAction("p1")).toEqual({ error: "That proposal isn't available" });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("tells the rep what to do, and hides anything unexpected", async () => {
    prisma.contractTemplate.findMany.mockResolvedValue([]);
    expect(await createContractFromProposalAction("p1")).toEqual({ error: "Add a contract template first" });
    expect(reportError).not.toHaveBeenCalled();

    prisma.contractTemplate.findMany.mockResolvedValue([template("ct-a", ["clientName"])]);
    prisma.$transaction.mockRejectedValue(new Error("connection reset"));
    expect(await createContractFromProposalAction("p1")).toEqual({ error: "Couldn't make the contract. Try again in a minute." });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(afterCallbacks).toHaveLength(0);
  });
});
