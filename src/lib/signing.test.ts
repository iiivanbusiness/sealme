import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, contractSigner, deal, signedEmail, countersignEmail, extractRenewal, dispatch, slack, hubspot, salesforce, audit } = vi.hoisted(() => ({
  contract: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  contractSigner: { findFirst: vi.fn(), update: vi.fn() },
  deal: { update: vi.fn() },
  signedEmail: vi.fn(),
  countersignEmail: vi.fn(),
  extractRenewal: vi.fn(),
  dispatch: vi.fn(),
  slack: vi.fn(),
  hubspot: vi.fn(),
  salesforce: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { contract, contractSigner, deal } }));
vi.mock("@/lib/email", () => ({ sendSignedNotificationEmail: signedEmail, sendCountersignRequestEmail: countersignEmail }));
vi.mock("@/lib/extract-renewal", () => ({ extractRenewalTerms: extractRenewal }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: dispatch }));
vi.mock("@/lib/slack", () => ({ notifySlack: slack }));
vi.mock("@/lib/hubspot", () => ({ syncDealToHubspot: hubspot }));
vi.mock("@/lib/salesforce", () => ({ syncDealToSalesforce: salesforce }));
vi.mock("@/lib/audit", () => ({ logAudit: audit }));

import { advanceSigningOrFinalize, finalizeContractSigned } from "./signing";

const fullContract = {
  id: "c1",
  dealId: "d1",
  signerName: "Marko Petrović",
  template: { name: "Retainer" },
  deal: {
    workspaceId: "w1",
    client: { name: "Acme" },
    workspace: { name: "Agency", notifyOnSigned: true, senderDomainStatus: null, senderEmail: null, users: [{ email: "ana@agency.test" }] },
  },
};

describe("finishing a signed contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contract.findUniqueOrThrow.mockResolvedValue(fullContract);
  });

  it("claims it first, then runs every effect once", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    await finalizeContractSigned("c1");
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: { not: "signed" } }, data: { status: "signed" } });
    expect(deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "signed" } });
    expect(signedEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ["ana@agency.test"] }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(hubspot).toHaveBeenCalledTimes(1);
    expect(salesforce).toHaveBeenCalledTimes(1);
  });

  it("does nothing when another call already finalized it", async () => {
    contract.updateMany.mockResolvedValue({ count: 0 });
    await finalizeContractSigned("c1");
    expect(contract.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(deal.update).not.toHaveBeenCalled();
    expect(signedEmail).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
    expect(hubspot).not.toHaveBeenCalled();
    expect(extractRenewal).not.toHaveBeenCalled();
  });

  it("emails only active teammates", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    await finalizeContractSigned("c1");
    const { include } = contract.findUniqueOrThrow.mock.calls[0][0];
    expect(include.deal.include.workspace.include.users).toEqual({ where: { deactivatedAt: null } });
  });

  it("skips the email when nobody active is left, and still finishes", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    contract.findUniqueOrThrow.mockResolvedValue({ ...fullContract, deal: { ...fullContract.deal, workspace: { ...fullContract.deal.workspace, users: [] } } });
    await finalizeContractSigned("c1");
    expect(signedEmail).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("moving to the next signer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contract.updateMany.mockResolvedValue({ count: 1 });
  });

  it("finalizes once nobody is left and the client has signed", async () => {
    contractSigner.findFirst.mockResolvedValue(null);
    contract.findUniqueOrThrow.mockResolvedValueOnce({ signedAt: new Date() }).mockResolvedValue(fullContract);
    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: { not: "signed" } }, data: { status: "signed" } });
  });

  it("doesn't complete a contract the client hasn't signed yet", async () => {
    contractSigner.findFirst.mockResolvedValue(null);
    contract.findUniqueOrThrow.mockResolvedValue({ signedAt: null });
    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("asks the next signer only while the contract is still out for signing", async () => {
    contractSigner.findFirst.mockResolvedValue({ id: "s2", email: "cfo@acme.test", name: "CFO", token: "t2" });
    contract.findUniqueOrThrow.mockResolvedValue(fullContract);

    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: { in: ["sent", "partially_signed"] }, signedAt: { not: null } },
      data: { status: "partially_signed" },
    });
    expect(countersignEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "cfo@acme.test" }));

    vi.clearAllMocks();
    contract.updateMany.mockResolvedValue({ count: 0 });
    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "partially_signed" } }));
    expect(countersignEmail).not.toHaveBeenCalled();
  });
});
