import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, advanceSigningOrFinalize, notifyChangesRequested, logAudit } = vi.hoisted(() => ({
  prisma: {
    contract: { updateMany: vi.fn(), findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
    clauseComment: { create: vi.fn() },
    deal: { update: vi.fn(), findUniqueOrThrow: vi.fn() },
  },
  advanceSigningOrFinalize: vi.fn(),
  notifyChangesRequested: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/review", () => ({ notifyChangesRequested }));
vi.mock("@/lib/signing", () => ({ advanceSigningOrFinalize }));

import { requestClauseChange, signContract } from "./actions";

const PROPOSAL_ERROR = "This is a proposal. There's nothing to sign.";

function signForm() {
  const fd = new FormData();
  fd.append("signerName", "Priya Shah");
  fd.append("signatureImage", "data:image/png;base64,AAAA");
  return fd;
}

const sentProposal = {
  id: "k1",
  dealId: "d1",
  status: "sent",
  deliveryMethod: "sealme",
  expiresAt: null,
  deal: { kind: "proposal", workspaceId: "w1", workspace: { name: "Agency" } },
};

describe("Signing a proposal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is refused by the write itself, and nothing that follows a signature runs", async () => {
    prisma.contract.updateMany.mockResolvedValue({ count: 0 });
    prisma.contract.findUnique.mockResolvedValue(sentProposal);

    expect(await signContract("k1", signForm())).toEqual({ error: PROPOSAL_ERROR });
    expect(prisma.contract.updateMany.mock.calls[0][0].where).toMatchObject({ id: "k1", status: "sent", deal: { kind: { not: "proposal" } } });
    expect(advanceSigningOrFinalize).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("still signs a contract", async () => {
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.contract.findUniqueOrThrow.mockResolvedValue({ id: "k1", dealId: "d1" });
    prisma.deal.findUniqueOrThrow.mockResolvedValue({ workspaceId: "w1" });

    await expect(signContract("k1", signForm())).rejects.toThrow("redirect /sign/k1");
    expect(advanceSigningOrFinalize).toHaveBeenCalledWith("k1");
  });
});

describe("Signing a contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs the client's signature once, leaving contract.signed to when everyone has signed", async () => {
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.contract.findUniqueOrThrow.mockResolvedValue({ id: "k1", dealId: "d1" });
    prisma.deal.findUniqueOrThrow.mockResolvedValue({ workspaceId: "w1" });

    await expect(signContract("k1", signForm())).rejects.toThrow("redirect /sign/k1");
    expect(logAudit).toHaveBeenCalledOnce();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "w1", action: "contract.client_signed", actorEmail: "Priya Shah", ip: "203.0.113.7", targetId: "k1" }));
  });
});

describe("Commenting on a proposal's clause", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is refused before anything changes", async () => {
    prisma.contract.findUnique.mockResolvedValue(sentProposal);
    const fd = new FormData();
    fd.append("comment", "Lower the fee");

    expect(await requestClauseChange("k1", "Fees", fd)).toEqual({ error: PROPOSAL_ERROR });
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(prisma.clauseComment.create).not.toHaveBeenCalled();
    expect(notifyChangesRequested).not.toHaveBeenCalled();
  });

  it("keeps a proposal out of the guarded write too", async () => {
    prisma.contract.findUnique.mockResolvedValue({ ...sentProposal, deal: { ...sentProposal.deal, kind: "contract" } });
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    const fd = new FormData();
    fd.append("comment", "Lower the fee");

    await expect(requestClauseChange("k1", "Fees", fd)).rejects.toThrow("redirect /sign/k1?feedbackSent=1");
    expect(prisma.contract.updateMany.mock.calls[0][0].where).toMatchObject({ deal: { kind: { not: "proposal" } } });
  });
});
