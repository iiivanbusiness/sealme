import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, contractSigner, deal, auditLog, envelopeStatus, finalize, notifyChanges, dispatch, audit } = vi.hoisted(() => ({
  contract: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  contractSigner: { updateMany: vi.fn(), findMany: vi.fn() },
  deal: { update: vi.fn() },
  auditLog: { findFirst: vi.fn() },
  envelopeStatus: vi.fn(),
  finalize: vi.fn(),
  notifyChanges: vi.fn(),
  dispatch: vi.fn(),
  audit: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { contract, contractSigner, deal, auditLog } }));
vi.mock("@/lib/docusign", () => ({ docusignEnvelopeStatus: envelopeStatus }));
vi.mock("@/lib/signing", () => ({ finalizeContractSigned: finalize }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/review", () => ({ notifyChangesRequested: notifyChanges }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: dispatch }));
vi.mock("@/lib/audit", () => ({ logAudit: audit }));

import { docusignEnvelopeExpired, docusignVoid, syncDocusignContract } from "./docusign-sync";

describe("DocuSign contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "sent", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1" } });
    contract.updateMany.mockResolvedValue({ count: 1 });
    contractSigner.findMany.mockResolvedValue([]);
    contractSigner.updateMany.mockResolvedValue({ count: 1 });
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

  it("gives each counter-signer the time they really signed on DocuSign", async () => {
    envelopeStatus.mockResolvedValue({
      status: "completed",
      signers: [
        { name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed", signedDateTime: "2026-10-06T15:00:00Z" },
        { name: "Our CEO", email: "ceo@agency.test", routingOrder: "2", status: "completed", signedDateTime: "2026-10-07T09:30:00Z" },
        { name: "Their Legal", email: "LEGAL@x.test", routingOrder: "3", status: "completed", signedDateTime: "2026-10-08T11:00:00Z" },
      ],
    });
    contractSigner.findMany.mockResolvedValue([
      { id: "s1", email: "ceo@agency.test", status: "pending" },
      { id: "s2", email: "legal@x.test", status: "pending" },
    ]);
    expect(await syncDocusignContract("c1")).toBe(true);
    expect(contractSigner.updateMany).toHaveBeenCalledWith({ where: { id: "s1", status: "pending" }, data: { status: "signed", signedAt: new Date("2026-10-07T09:30:00Z") } });
    expect(contractSigner.updateMany).toHaveBeenCalledWith({ where: { id: "s2", status: "pending" }, data: { status: "signed", signedAt: new Date("2026-10-08T11:00:00Z") } });
  });

  it("falls back to now for a counter-signer DocuSign gives no time for", async () => {
    envelopeStatus.mockResolvedValue({ status: "completed", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed" }] });
    contractSigner.findMany.mockResolvedValue([{ id: "s1", email: "ceo@agency.test", status: "pending" }]);
    const before = Date.now();
    await syncDocusignContract("c1");
    const signedAt = contractSigner.updateMany.mock.calls[0][0].data.signedAt as Date;
    expect(signedAt.getTime()).toBeGreaterThanOrEqual(before);
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
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contract.docusign_voided", metadata: expect.objectContaining({ reason: "Wrong client" }) }));
  });

  it("marks an envelope DocuSign voided because it expired as expired, not changes requested", async () => {
    envelopeStatus.mockResolvedValue({ status: "voided", voidedReason: "Envelope has expired.", signers: [] });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: "sent" }, data: { status: "expired", expiresAt: expect.any(Date) } });
    expect(deal.update).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contract.expired", targetId: "c1" }));
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.expired", expect.objectContaining({ contractId: "c1", dealId: "d1" }));
  });

  it("announces a DocuSign expiry only once", async () => {
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "expired", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1" } });
    envelopeStatus.mockResolvedValue({ status: "voided", voidedReason: "Envelope has expired.", signers: [] });
    contract.updateMany.mockResolvedValue({ count: 0 });
    await syncDocusignContract("c1");
    expect(audit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deal.update).not.toHaveBeenCalled();
  });

  it("tells an expiry void apart from the sender's own", () => {
    expect(docusignEnvelopeExpired({ status: "voided", voidedReason: "Envelope has expired." })).toBe(true);
    expect(docusignEnvelopeExpired({ status: "voided", voidedReason: "Wrong client" })).toBe(false);
    expect(docusignEnvelopeExpired({ status: "voided" })).toBe(false);
    expect(docusignEnvelopeExpired({ status: "declined", voidedReason: "expired" })).toBe(false);
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

describe("why a DocuSign contract is in changes_requested", () => {
  const voided = { id: "c1", dealId: "d1", status: "changes_requested", deliveryMethod: "docusign" };

  beforeEach(() => vi.clearAllMocks());

  it("is a void when the envelope's void is the latest thing that sent it back", async () => {
    auditLog.findFirst.mockResolvedValue({ action: "contract.docusign_voided", metadata: JSON.stringify({ reason: "Wrong client" }) });
    expect(await docusignVoid(voided, "w1")).toEqual({ reason: "Wrong client" });
    expect(auditLog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ workspaceId: "w1", OR: [{ targetType: "Contract", targetId: "c1" }, { targetType: "Deal", targetId: "d1" }] }),
        orderBy: { createdAt: "desc" },
      })
    );
  });

  it("keeps a void without a reason", async () => {
    auditLog.findFirst.mockResolvedValue({ action: "contract.docusign_voided", metadata: JSON.stringify({ reason: null }) });
    expect(await docusignVoid(voided, "w1")).toEqual({ reason: null });
  });

  it("isn't a void when someone asked for changes after it", async () => {
    auditLog.findFirst.mockResolvedValue({ action: "contract.approval_rejected", metadata: null });
    expect(await docusignVoid(voided, "w1")).toBeUndefined();
  });

  it("doesn't look anything up for a SealMe contract or one not sent back", async () => {
    expect(await docusignVoid({ ...voided, deliveryMethod: "sealme" }, "w1")).toBeUndefined();
    expect(await docusignVoid({ ...voided, status: "sent" }, "w1")).toBeUndefined();
    expect(auditLog.findFirst).not.toHaveBeenCalled();
  });
});
