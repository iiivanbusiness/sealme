import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, contractSigner, deal, client, workspace, signedEmail, countersignEmail, extractRenewal, dispatch, slack, hubspot, salesforce, ghlWon, audit, markLeadClient, after, afterQueue } = vi.hoisted(() => ({
  contract: { updateMany: vi.fn(), findUniqueOrThrow: vi.fn() },
  contractSigner: { findFirst: vi.fn(), update: vi.fn() },
  deal: { update: vi.fn(), findUnique: vi.fn() },
  client: { updateMany: vi.fn() },
  workspace: { findUnique: vi.fn() },
  signedEmail: vi.fn(),
  countersignEmail: vi.fn(),
  extractRenewal: vi.fn(),
  dispatch: vi.fn(),
  slack: vi.fn(),
  hubspot: vi.fn(),
  salesforce: vi.fn(),
  ghlWon: vi.fn(),
  audit: vi.fn(),
  markLeadClient: vi.fn(),
  after: vi.fn(),
  afterQueue: [] as (() => Promise<void>)[],
}));
vi.mock("@/lib/db", () => ({ prisma: { contract, contractSigner, deal, client, workspace } }));
vi.mock("next/server", () => ({ after }));
vi.mock("@/lib/email", () => ({ sendSignedNotificationEmail: signedEmail, sendCountersignRequestEmail: countersignEmail }));
vi.mock("@/lib/extract-renewal", () => ({ extractRenewalTerms: extractRenewal }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: dispatch }));
vi.mock("@/lib/slack", () => ({ notifySlack: slack }));
vi.mock("@/lib/hubspot", () => ({ syncDealToHubspot: hubspot }));
vi.mock("@/lib/salesforce", () => ({ syncDealToSalesforce: salesforce }));
vi.mock("@/lib/gohighlevel", () => ({ markGhlOpportunityWon: ghlWon }));
vi.mock("@/lib/audit", () => ({ logAudit: audit }));
vi.mock("@/lib/lead-pipeline", () => ({ markLeadClient }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));

import { advanceSigningOrFinalize, finalizeContractSigned } from "./signing";

const fullContract = {
  id: "c1",
  dealId: "d1",
  signerName: "Marko Petrović",
  template: { name: "Retainer" },
  deal: {
    workspaceId: "w1",
    sourceDealId: "p1",
    client: { id: "cl1", name: "Acme", hubspotContactId: null, salesforceContactId: null },
    workspace: { name: "Agency", notifyOnSigned: true, senderDomainStatus: null, senderEmail: null, users: [{ email: "ana@agency.test" }] },
  },
};
const noCrm = { hubspotContactId: null, salesforceRecordId: null, salesforceRecordType: null, ghlOpportunityId: null };

// What after() was handed runs once the signer has their answer.
async function afterResponse() {
  while (afterQueue.length > 0) await afterQueue.shift()!();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterQueue.length = 0;
  after.mockImplementation((fn: () => Promise<void>) => afterQueue.push(fn));
  deal.findUnique.mockResolvedValue({ lead: { id: "l1", ...noCrm } });
});

describe("finishing a signed contract", () => {
  beforeEach(() => {
    contract.findUniqueOrThrow.mockResolvedValue(fullContract);
  });

  it("claims it first, then runs every effect once", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    await finalizeContractSigned("c1");
    await afterResponse();
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: { not: "signed" }, deal: { kind: { not: "proposal" } } }, data: { status: "signed" } });
    expect(deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "signed" } });
    expect(markLeadClient).toHaveBeenCalledWith("d1");
    expect(signedEmail).toHaveBeenCalledWith(expect.objectContaining({ to: ["ana@agency.test"] }));
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(hubspot).toHaveBeenCalledTimes(1);
    expect(salesforce).toHaveBeenCalledTimes(1);
  });

  it("does nothing when another call already finalized it", async () => {
    contract.updateMany.mockResolvedValue({ count: 0 });
    await finalizeContractSigned("c1");
    await afterResponse();
    expect(contract.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(deal.update).not.toHaveBeenCalled();
    expect(markLeadClient).not.toHaveBeenCalled();
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

  it("says which lead signed, and the proposal the contract came from", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    await finalizeContractSigned("c1");
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.signed", expect.objectContaining({ dealId: "d1", contractId: "c1", leadId: "l1", sourceDealId: "p1" }));

    // The lead is read after markLeadClient, which links one to a deal that had none.
    expect(markLeadClient.mock.invocationCallOrder[0]).toBeLessThan(deal.findUnique.mock.invocationCallOrder[0]);
  });

  it("doesn't keep the signer waiting on renewal terms, Slack or the CRMs", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    deal.findUnique.mockResolvedValue({ lead: { id: "l1", ...noCrm, ghlOpportunityId: "o1" } });
    workspace.findUnique.mockResolvedValue({ ghlEnabled: true, ghlAccessToken: "pit" });
    await finalizeContractSigned("c1");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(extractRenewal).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
    expect(hubspot).not.toHaveBeenCalled();
    expect(ghlWon).not.toHaveBeenCalled();

    await afterResponse();
    expect(extractRenewal).toHaveBeenCalledWith("c1");
    expect(slack).toHaveBeenCalledWith("w1", expect.objectContaining({ type: "contract.signed", dealId: "d1" }));
    expect(hubspot).toHaveBeenCalledWith("w1", "d1");
    expect(salesforce).toHaveBeenCalledWith("w1", "d1");
    expect(ghlWon).toHaveBeenCalledWith("pit", "o1");
  });

  it("runs it all right away with no request to wait for, and one failing leaves the rest", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    after.mockImplementation(() => {
      throw new Error("after() was called outside a request scope");
    });
    extractRenewal.mockRejectedValueOnce(new Error("AI down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await finalizeContractSigned("c1");
    expect(slack).toHaveBeenCalledTimes(1);
    expect(hubspot).toHaveBeenCalledTimes(1);
    expect(salesforce).toHaveBeenCalledTimes(1);
  });

  it("gives the client the lead's CRM record before the CRM push, so no second contact is made", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    deal.findUnique.mockResolvedValue({ lead: { id: "l1", ...noCrm, hubspotContactId: "HC9", salesforceRecordId: "003000000000009AAA", salesforceRecordType: "Contact" } });
    await finalizeContractSigned("c1");
    expect(client.updateMany).toHaveBeenCalledWith({
      where: { id: "cl1", hubspotContactId: null, salesforceContactId: null },
      data: { hubspotContactId: "HC9", salesforceContactId: "003000000000009AAA" },
    });
    await afterResponse();
    expect(client.updateMany.mock.invocationCallOrder[0]).toBeLessThan(hubspot.mock.invocationCallOrder[0]);
  });

  it("keeps the client's own CRM record, and a Salesforce Lead isn't a contact to reuse", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    contract.findUniqueOrThrow.mockResolvedValue({ ...fullContract, deal: { ...fullContract.deal, client: { ...fullContract.deal.client, hubspotContactId: "HC1" } } });
    deal.findUnique.mockResolvedValue({ lead: { id: "l1", ...noCrm, hubspotContactId: "HC9", salesforceRecordId: "00Q000000000009AAA", salesforceRecordType: "Lead" } });
    await finalizeContractSigned("c1");
    expect(client.updateMany).not.toHaveBeenCalled();
  });

  it("leaves GoHighLevel alone when it isn't connected", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    deal.findUnique.mockResolvedValue({ lead: { id: "l1", ...noCrm, ghlOpportunityId: "o1" } });
    workspace.findUnique.mockResolvedValue({ ghlEnabled: false, ghlAccessToken: null });
    await finalizeContractSigned("c1");
    await afterResponse();
    expect(ghlWon).not.toHaveBeenCalled();
  });

  it("finishes a contract marked not signed when a real signature comes in after all", async () => {
    contract.updateMany.mockResolvedValue({ count: 1 });
    await finalizeContractSigned("c1");
    // Only a contract already signed is skipped: not_signed and expired are claimed.
    expect(contract.updateMany.mock.calls[0][0].where.status).toEqual({ not: "signed" });
    expect(deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "signed" } });
    expect(markLeadClient).toHaveBeenCalledWith("d1");
  });
});

describe("moving to the next signer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contract.updateMany.mockResolvedValue({ count: 1 });
  });

  it("finalizes once nobody is left and the client has signed, making the lead a client", async () => {
    contractSigner.findFirst.mockResolvedValue(null);
    contract.findUniqueOrThrow.mockResolvedValueOnce({ signedAt: new Date() }).mockResolvedValue(fullContract);
    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: { not: "signed" }, deal: { kind: { not: "proposal" } } }, data: { status: "signed" } });
    expect(markLeadClient).toHaveBeenCalledWith("d1");
  });

  it("doesn't complete a contract the client hasn't signed yet", async () => {
    contractSigner.findFirst.mockResolvedValue(null);
    contract.findUniqueOrThrow.mockResolvedValue({ signedAt: null });
    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(markLeadClient).not.toHaveBeenCalled();
  });

  it("asks the next signer only while the contract is still out for signing", async () => {
    contractSigner.findFirst.mockResolvedValue({ id: "s2", email: "cfo@acme.test", name: "CFO", token: "t2" });
    contract.findUniqueOrThrow.mockResolvedValue(fullContract);

    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: { in: ["sent", "partially_signed"] }, signedAt: { not: null }, deal: { kind: { not: "proposal" } } },
      data: { status: "partially_signed" },
    });
    expect(countersignEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "cfo@acme.test" }));
    // Someone still has to sign: the lead isn't a client yet.
    expect(markLeadClient).not.toHaveBeenCalled();

    vi.clearAllMocks();
    contract.updateMany.mockResolvedValue({ count: 0 });
    await advanceSigningOrFinalize("c1");
    expect(contract.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "partially_signed" } }));
    expect(countersignEmail).not.toHaveBeenCalled();
  });
});
