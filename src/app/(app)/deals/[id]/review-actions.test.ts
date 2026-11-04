import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, currentUserWithRole, notifyStepAssignee, notifyChangesRequested, performActualSend } = vi.hoisted(() => ({
  prisma: {
    deal: { findFirst: vi.fn(), update: vi.fn() },
    user: { findFirst: vi.fn() },
    reviewStep: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn(), aggregate: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    approvalDelegate: { findFirst: vi.fn() },
    contract: { update: vi.fn() },
    reviewChain: { findMany: vi.fn() },
  },
  currentUserWithRole: vi.fn(),
  notifyStepAssignee: vi.fn(),
  notifyChangesRequested: vi.fn(),
  performActualSend: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: {} }) }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
// The real canSendContract, with sending and notifying stubbed out.
vi.mock("@react-pdf/renderer", () => ({}));
vi.mock("@/lib/contract-pdf", () => ({}));
vi.mock("@/lib/docusign", () => ({}));
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

import { decideReviewStep, sendForReviewTo } from "./review-actions";

const rep = { id: "rep", email: "rep@agency.test", role: { canManageWorkspace: false } };
const admin = { id: "admin", email: "admin@agency.test", role: { canManageWorkspace: true } };
// Maria (Finance) has the chain's step for this deal.
const financeStep = { id: "step1", contractId: "k1", assigneeId: "maria", order: 1, status: "pending" };

function dealWithContract(status: string) {
  return {
    id: "d1",
    workspaceId: "w1",
    teamId: null,
    feeDisplay: "$60,000",
    contract: { id: "k1", status, deliveryMethod: "sealme", expiresAt: null, pendingTo: "c@x.test", pendingSubject: "s", pendingMessage: "m" },
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

  it("sends once the last pending step is approved", async () => {
    prisma.deal.findFirst.mockResolvedValue(dealWithContract("pending_approval"));
    prisma.reviewStep.findFirst.mockResolvedValueOnce(financeStep).mockResolvedValueOnce(null);

    expect(await decide("approve")).toEqual({});
    expect(prisma.reviewStep.findFirst).toHaveBeenLastCalledWith({ where: { contractId: "k1", order: { gt: 1 }, status: "pending" }, orderBy: { order: "asc" } });
    expect(performActualSend).toHaveBeenCalledWith("k1");
  });
});
