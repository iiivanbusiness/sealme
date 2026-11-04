import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, contractSigner, deal, envelopeStatus, finalize, notifyChanges, dispatch } = vi.hoisted(() => ({
  contract: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  contractSigner: { updateMany: vi.fn() },
  deal: { update: vi.fn() },
  envelopeStatus: vi.fn(),
  finalize: vi.fn(),
  notifyChanges: vi.fn(),
  dispatch: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { contract, contractSigner, deal } }));
vi.mock("@/lib/docusign", () => ({ docusignEnvelopeStatus: envelopeStatus }));
vi.mock("@/lib/signing", () => ({ finalizeContractSigned: finalize }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/review", () => ({ notifyChangesRequested: notifyChanges }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: dispatch }));
vi.mock("@/lib/audit", () => ({ logAudit: async () => {} }));

import { syncDocusignContract } from "./docusign-sync";

describe("DocuSign contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "sent", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1" } });
    contract.updateMany.mockResolvedValue({ count: 1 });
  });

  it("stays unsigned until DocuSign itself says the envelope is completed", async () => {
    envelopeStatus.mockResolvedValue({ status: "sent", signers: [] });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(envelopeStatus).toHaveBeenCalledWith("w1", "env-1");
    expect(finalize).not.toHaveBeenCalled();
  });

  it("marks it signed with the client's name from DocuSign", async () => {
    envelopeStatus.mockResolvedValue({
      status: "completed",
      signers: [
        { name: "Second Signer", email: "b@x.test", routingOrder: "2", status: "completed" },
        { name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed", signedDateTime: "2026-10-06T15:00:00Z" },
      ],
    });
    expect(await syncDocusignContract("c1")).toBe(true);
    expect(contract.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: { in: ["sent", "expired", "changes_requested"] } },
      data: { status: "partially_signed", signerName: "Priya Shah", signedAt: new Date("2026-10-06T15:00:00Z") },
    });
    expect(finalize).toHaveBeenCalledWith("c1");
  });

  it("finalizes only once when the webhook and the daily check race", async () => {
    envelopeStatus.mockResolvedValue({ status: "completed", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed" }] });
    contract.updateMany.mockResolvedValue({ count: 0 });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
  });

  it("doesn't ask DocuSign about a contract that's already signed", async () => {
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "signed", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1" } });
    expect(await syncDocusignContract("c1")).toBe(true);
    expect(envelopeStatus).not.toHaveBeenCalled();
  });

  it("sends a declined envelope back to changes_requested and tells the team", async () => {
    envelopeStatus.mockResolvedValue({
      status: "declined",
      signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined", declinedReason: "Fee is wrong" }],
    });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: { in: ["sent", "expired"] } }, data: { status: "changes_requested" } });
    expect(deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "changes_requested" } });
    expect(notifyChanges).toHaveBeenCalledWith("d1", "Priya Shah", "Declined on DocuSign: Fee is wrong");
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.declined", expect.objectContaining({ contractId: "c1", signerName: "Priya Shah", reason: "Fee is wrong" }));
    expect(finalize).not.toHaveBeenCalled();
  });

  it("reopens a voided envelope without emailing the team", async () => {
    envelopeStatus.mockResolvedValue({ status: "voided", voidedReason: "Wrong client", signers: [] });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "changes_requested" } });
    expect(notifyChanges).not.toHaveBeenCalled();
  });

  it("leaves a contract the rep sent again through SealMe alone when its old envelope was declined", async () => {
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "sent", deliveryMethod: "sealme", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1" } });
    envelopeStatus.mockResolvedValue({ status: "declined", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined" }] });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(deal.update).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
  });

  it("announces a decline only once", async () => {
    envelopeStatus.mockResolvedValue({ status: "declined", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined" }] });
    contract.updateMany.mockResolvedValue({ count: 0 });
    await syncDocusignContract("c1");
    expect(deal.update).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
  });
});
