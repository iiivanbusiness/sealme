import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, currentUserWithRole, notifyStepAssignee, notifyChangesRequested, performActualSend, refreshLeadPipeline, envelopeStatus, voidEnvelope, finalize, reportError } = vi.hoisted(() => ({
  prisma: {
    deal: { findFirst: vi.fn(), update: vi.fn() },
    user: { findFirst: vi.fn() },
    reviewStep: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), aggregate: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    approvalDelegate: { findFirst: vi.fn() },
    contract: { update: vi.fn(), updateMany: vi.fn() },
    contractSigner: { findMany: vi.fn(), updateMany: vi.fn() },
    reviewChain: { findMany: vi.fn() },
  },
  currentUserWithRole: vi.fn(),
  notifyStepAssignee: vi.fn(),
  notifyChangesRequested: vi.fn(),
  performActualSend: vi.fn(),
  refreshLeadPipeline: vi.fn(),
  envelopeStatus: vi.fn(),
  voidEnvelope: vi.fn(),
  finalize: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: {} }) }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
// The real canSendContract, with sending and notifying stubbed out.
vi.mock("@react-pdf/renderer", () => ({}));
vi.mock("@/lib/contract-pdf", () => ({}));
// The real check of the envelope sent before (docusign-sync), with DocuSign
// itself and the signing that follows stubbed out.
vi.mock("@/lib/docusign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docusign")>()),
  docusignEnvelopeStatus: envelopeStatus,
  voidDocusignEnvelope: voidEnvelope,
}));
vi.mock("@/lib/signing", () => ({ finalizeContractSigned: finalize }));
vi.mock("@/lib/error-report", () => ({ reportError }));
vi.mock("@/lib/email", () => ({}));
vi.mock("@/lib/notifications", () => ({}));
vi.mock("@/lib/client-portal", () => ({}));
vi.mock("@/lib/webhooks", () => ({}));
vi.mock("@/lib/slack", () => ({}));
vi.mock("@/lib/hubspot", () => ({}));
vi.mock("@/lib/salesforce", () => ({}));
vi.mock("@/lib/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review")>()),
  notifyStepAssignee,
  notifyChangesRequested,
  performActualSend,
}));

import { DOCUSIGN_NOT_CONNECTED } from "@/lib/docusign";
import { decideReviewStep, sendForReviewTo } from "./review-actions";

const rep = { id: "rep", email: "rep@agency.test", role: { canManageWorkspace: false } };
const admin = { id: "admin", email: "admin@agency.test", role: { canManageWorkspace: true } };
// Went out by DocuSign as env-1 before, and the next round goes that way too.
const byDocusign = { deliveryMethod: "docusign", docusignEnvelopeId: "env-1" };
// Went out by DocuSign as env-1, then the rep picked a SealMe link, which
// is how the next round goes.
const bySealme = { deliveryMethod: "sealme", docusignEnvelopeId: "env-1" };
// The contract letting go of env-1.
const letGo = { where: { id: "k1", docusignEnvelopeId: "env-1" }, data: { docusignEnvelopeId: null } };
// Maria (Finance) has the chain's step for this deal.
const financeStep = { id: "step1", contractId: "k1", assigneeId: "maria", order: 1, status: "pending" };

function dealWithContract(status: string, contract: Record<string, unknown> = {}) {
  return {
    id: "d1",
    workspaceId: "w1",
    teamId: null,
    feeDisplay: "$60,000",
    contract: { id: "k1", status, deliveryMethod: "sealme", expiresAt: null, pendingTo: "c@x.test", pendingSubject: "s", pendingMessage: "m", ...contract },
    client: { name: "Priya", email: "c@x.test" },
    template: { name: "Retainer" },
    workspace: { name: "Agency" },
  };
}

describe("Send to a teammate for review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findFirst.mockResolvedValue({ id: "tom", name: "Tom" });
    prisma.reviewStep.aggregate.mockResolvedValue({ _max: { order: 1 } });
    prisma.reviewStep.create.mockResolvedValue({ id: "step2" });
    prisma.approvalDelegate.findFirst.mockResolvedValue(null);
    prisma.reviewChain.findMany.mockResolvedValue([]);
  });

  it("lets a rep add Tom after Finance, but not take Finance off the deal", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval"));
    prisma.reviewStep.findFirst.mockResolvedValue(financeStep);
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.reviewStep.update).not.toHaveBeenCalled();
    expect(prisma.reviewStep.create).toHaveBeenCalledWith({ data: { contractId: "k1", assigneeId: "tom", order: 2, status: "pending" } });
    // Tom hears about it when it's his turn, not now.
    expect(notifyStepAssignee).not.toHaveBeenCalled();
  });

  it("lets an admin hand Finance's step to Tom", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval"));
    prisma.reviewStep.findFirst.mockResolvedValue(financeStep);
    currentUserWithRole.mockResolvedValue(admin);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.reviewStep.update).toHaveBeenCalledWith({ where: { id: "step1" }, data: { assigneeId: "tom" } });
    expect(notifyStepAssignee).toHaveBeenCalledWith("d1", "step1");
  });

  it("starts a new round over steps a rejection left queued", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("changes_requested"));
    prisma.reviewStep.aggregate.mockResolvedValue({ _max: { order: 2 } });
    prisma.reviewStep.create.mockResolvedValue({ id: "step3" });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.reviewStep.findFirst).not.toHaveBeenCalled();
    expect(prisma.reviewStep.deleteMany).toHaveBeenCalledWith({ where: { contractId: "k1", status: "pending" } });
    expect(prisma.reviewStep.create).toHaveBeenCalledWith({ data: { contractId: "k1", assigneeId: "tom", order: 3, status: "pending" } });
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval" } });
    expect(notifyStepAssignee).toHaveBeenCalledWith("d1", "step3");
  });

  it("keeps the review chain in a new round, with Tom after it", async () => {
    // Legal asked for changes; the deal is still over Finance's threshold.
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("changes_requested"));
    prisma.reviewChain.findMany.mockResolvedValue([{ id: "c1", name: "Big deals", teamId: null, minDealValue: 50000, steps: [{ assigneeId: "maria", order: 1 }, { assigneeId: "lee", order: 2 }] }]);
    prisma.reviewStep.aggregate.mockResolvedValue({ _max: { order: 2 } });
    prisma.reviewStep.create.mockResolvedValueOnce({ id: "step3" }).mockResolvedValueOnce({ id: "step4" }).mockResolvedValueOnce({ id: "step5" });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.reviewStep.create.mock.calls.map((c) => [c[0].data.assigneeId, c[0].data.order])).toEqual([["maria", 3], ["lee", 4], ["tom", 5]]);
    // Maria goes first; Tom hears about it when it's his turn.
    expect(notifyStepAssignee).toHaveBeenCalledTimes(1);
    expect(notifyStepAssignee).toHaveBeenCalledWith("d1", "step3");
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval" } });
  });

  it("lets an admin start a round with just Tom", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("draft"));
    prisma.reviewChain.findMany.mockResolvedValue([{ id: "c1", name: "All", teamId: null, minDealValue: null, steps: [{ assigneeId: "maria", order: 1 }] }]);
    prisma.reviewStep.aggregate.mockResolvedValue({ _max: { order: null } });
    currentUserWithRole.mockResolvedValue(admin);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.reviewStep.create).toHaveBeenCalledTimes(1);
    expect(prisma.reviewStep.create).toHaveBeenCalledWith({ data: { contractId: "k1", assigneeId: "tom", order: 1, status: "pending" } });
    expect(notifyStepAssignee).toHaveBeenCalledWith("d1", "step2");
  });

  it("moves the lead off Not signed when a contract marked not signed goes back to review", async () => {
    prisma.deal.findFirst.mockResolvedValue({ ...dealWithContract("not_signed"), leadId: "lead1" });
    prisma.reviewStep.findFirst.mockResolvedValue(null);
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval" } });
    expect(refreshLeadPipeline).toHaveBeenCalledWith("lead1", { sentNow: true });
  });

  it("leaves the lead alone when a teammate joins a review already under way", async () => {
    prisma.deal.findFirst.mockResolvedValue({ ...dealWithContract("pending_approval"), leadId: "lead1" });
    prisma.reviewStep.findFirst.mockResolvedValue(financeStep);
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
  });

  it("voids the envelope a contract marked not signed still has out before a new round starts", async () => {
    // The void when it was marked not signed didn't reach DocuSign.
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("not_signed", byDocusign));
    envelopeStatus.mockResolvedValue({ status: "delivered", signers: [] });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(envelopeStatus).toHaveBeenCalledWith("w1", "env-1");
    expect(voidEnvelope).toHaveBeenCalledWith("w1", "env-1", "Replaced by a new version of the contract");
    expect(voidEnvelope.mock.invocationCallOrder[0]).toBeLessThan(prisma.reviewStep.create.mock.invocationCallOrder[0]);
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval" } });
  });

  it("finalizes instead of starting a review when the client already signed the old envelope", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("not_signed", byDocusign));
    envelopeStatus.mockResolvedValue({ status: "completed", signers: [{ name: "Priya", email: "c@x.test", routingOrder: "1", status: "completed" }] });
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.contractSigner.findMany.mockResolvedValue([]);
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({ error: "The client already signed this in DocuSign, so nothing was sent again. It's marked signed now" });
    expect(finalize).toHaveBeenCalledWith("k1");
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
    expect(notifyStepAssignee).not.toHaveBeenCalled();
  });

  it("starts no review when the old envelope can't be voided and the next round goes by DocuSign", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("not_signed", byDocusign));
    envelopeStatus.mockResolvedValue({ status: "delivered", signers: [] });
    voidEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope void failed: 503"));
    currentUserWithRole.mockResolvedValue(rep);

    expect((await sendForReviewTo("d1", "tom")).error).toMatch(/Couldn't cancel the DocuSign envelope sent before/);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });

  it("starts no review, whichever way it goes out, while the old envelope may still be signed", async () => {
    currentUserWithRole.mockResolvedValue(rep);
    const cases: [Record<string, unknown>, () => void, RegExp][] = [
      // The void failed, DocuSign couldn't be asked, or the client is signing right now.
      [bySealme, () => { envelopeStatus.mockResolvedValueOnce({ status: "delivered", signers: [] }).mockResolvedValueOnce({ status: "delivered", signers: [] }); voidEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope void failed: 503")); }, /Couldn't cancel the DocuSign envelope sent before/],
      [bySealme, () => envelopeStatus.mockRejectedValueOnce(new Error("fetch failed")), /Couldn't check the DocuSign envelope sent before/],
      [byDocusign, () => envelopeStatus.mockResolvedValueOnce({ status: "signed", signers: [] }), /^The client is signing this in DocuSign right now. Try again in a minute$/],
      [bySealme, () => envelopeStatus.mockResolvedValueOnce({ status: "signed", signers: [] }), /^The client is signing this in DocuSign right now/],
    ];
    for (const [contract, docusign, error] of cases) {
      prisma.deal.findFirst.mockResolvedValueOnce(dealWithContract("not_signed", contract));
      docusign();
      expect((await sendForReviewTo("d1", "tom")).error).toMatch(error);
    }
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(prisma.contract.updateMany).not.toHaveBeenCalledWith(letGo);
    expect(notifyStepAssignee).not.toHaveBeenCalled();
  });

  it("asks to reconnect DocuSign before a review that would end in a DocuSign send", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("changes_requested", { ...byDocusign, sentAt: new Date() }));
    envelopeStatus.mockRejectedValueOnce(new Error(DOCUSIGN_NOT_CONNECTED));
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({ error: DOCUSIGN_NOT_CONNECTED });
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("starts a review that ends in a SealMe link with DocuSign disconnected, letting go of the old envelope", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("changes_requested", { ...bySealme, sentAt: new Date() }));
    envelopeStatus.mockRejectedValueOnce(new Error(DOCUSIGN_NOT_CONNECTED));
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.contract.updateMany).toHaveBeenCalledWith(letGo);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(prisma.contract.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prisma.reviewStep.create.mock.invocationCallOrder[0]);
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval" } });
  });

  it("lets go of an old envelope DocuSign already closed, and starts the review", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("not_signed", byDocusign));
    envelopeStatus.mockResolvedValue({ status: "declined", signers: [] });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.contract.updateMany).toHaveBeenCalledWith(letGo);
    expect(voidEnvelope).not.toHaveBeenCalled();
    expect(notifyStepAssignee).toHaveBeenCalledWith("d1", "step2");
  });

  it("doesn't ask DocuSign when a teammate joins a review already under way", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval", byDocusign));
    prisma.reviewStep.findFirst.mockResolvedValue(financeStep);
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(envelopeStatus).not.toHaveBeenCalled();
  });

  it("won't start a review from the trash", async () => {
    prisma.deal.findFirst.mockResolvedValue({ ...dealWithContract("draft"), trashedAt: new Date() });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({ error: "This contract is in the trash. Restore it first" });
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });

  it("asks for the blanks before a new round, not at the last approval", async () => {
    // The fee is still empty, and the terms lock once the review starts.
    const template = { clauses: JSON.stringify([{ title: "Fees", body: "The fee is {fee}." }]) };
    prisma.deal.findFirst.mockResolvedValue({ ...dealWithContract("not_signed", { ...byDocusign, template }), fields: [{ fieldKey: "fee", label: "Fee", value: "" }] });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({ error: "Fill in Fee before sending. The contract still has blanks" });
    // Nothing happened yet: the old envelope is still out, and no review.
    expect(envelopeStatus).not.toHaveBeenCalled();
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
  });

  it("starts the round once the blanks are filled in", async () => {
    const template = { clauses: JSON.stringify([{ title: "Fees", body: "The fee is {fee}." }]) };
    prisma.deal.findFirst.mockResolvedValue({ ...dealWithContract("draft", { template }), fields: [{ fieldKey: "fee", label: "Fee", value: "$8,500" }] });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval" } });
  });

  it("sends a contract that never went out by DocuSign when it's connected, like a first send from the Send page", async () => {
    const deal = dealWithContract("draft", { sentAt: null });
    prisma.deal.findFirst.mockResolvedValue({ ...deal, workspace: { ...deal.workspace, docusignEnabled: true } });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    // Stored as the review starts, so the last approval sends by DocuSign.
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval", deliveryMethod: "docusign" } });
  });

  it("keeps the way a contract went before, even with DocuSign connected", async () => {
    const deal = dealWithContract("changes_requested", { sentAt: new Date() });
    prisma.deal.findFirst.mockResolvedValue({ ...deal, workspace: { ...deal.workspace, docusignEnabled: true } });
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({});
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "pending_approval" } });
  });

  it("won't start a review on a contract the client already has", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("partially_signed"));
    prisma.reviewStep.findFirst.mockResolvedValue(null);
    currentUserWithRole.mockResolvedValue(rep);

    expect(await sendForReviewTo("d1", "tom")).toEqual({ error: "This contract was already sent" });
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });
});

describe("Deciding a review step", () => {
  const maria = { id: "maria", name: "Maria", email: "maria@agency.test", role: { canManageWorkspace: false } };
  const decide = (decision: "approve" | "reject") => decideReviewStep("d1", "step1", decision, new FormData());

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewStep.findFirst.mockResolvedValue(financeStep);
    prisma.reviewStep.count.mockResolvedValue(0);
    currentUserWithRole.mockResolvedValue(maria);
  });

  it("only while the contract is in review", async () => {
    for (const status of ["changes_requested", "sent", "draft"]) {
      prisma.deal.findFirst.mockResolvedValue(dealWithContract(status));
      expect(await decide("approve")).toEqual({ error: "This contract isn't waiting on review anymore" });
    }
    expect(prisma.reviewStep.update).not.toHaveBeenCalled();
    expect(performActualSend).not.toHaveBeenCalled();
  });

  it("waits only on earlier steps still pending, not on a rejection from an earlier round", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval"));
    await decide("approve");
    expect(prisma.reviewStep.count).toHaveBeenCalledWith({ where: { contractId: "k1", order: { lt: 1 }, status: "pending" } });
  });

  it("on a rejection, clears the steps queued after it so the next round can start", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval"));

    expect(await decide("reject")).toEqual({});
    expect(prisma.reviewStep.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "step1" }, data: expect.objectContaining({ status: "rejected" }) }));
    expect(prisma.reviewStep.deleteMany).toHaveBeenCalledWith({ where: { contractId: "k1", order: { gt: 1 }, status: "pending" } });
    expect(prisma.contract.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { status: "changes_requested" } });
  });

  it("tells the second of two approvers deciding the last step at once that it's already going out", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval"));
    prisma.reviewStep.findFirst.mockResolvedValueOnce(financeStep).mockResolvedValueOnce(null);
    // The other approver's send holds the contract (performActualSend).
    performActualSend.mockRejectedValueOnce(new Error("This contract is already being sent"));

    expect(await decide("approve")).toEqual({ error: "This contract is already being sent" });
    // Their step stays as it is: the send that went out records its own approval.
    expect(prisma.reviewStep.update).not.toHaveBeenCalled();
  });

  it("sends once the last pending step is approved", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval"));
    prisma.reviewStep.findFirst.mockResolvedValueOnce(financeStep).mockResolvedValueOnce(null);

    expect(await decide("approve")).toEqual({});
    expect(prisma.reviewStep.findFirst).toHaveBeenLastCalledWith({ where: { contractId: "k1", order: { gt: 1 }, status: "pending" }, orderBy: { order: "asc" } });
    expect(performActualSend).toHaveBeenCalledWith("k1");
  });
});
