import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, contractSigner, deal, auditLog, envelopeStatus, voidEnvelope, finalize, notifyChanges, dispatch, audit, leadStage, reportError } = vi.hoisted(() => ({
  contract: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
  contractSigner: { updateMany: vi.fn(), findMany: vi.fn() },
  deal: { update: vi.fn() },
  auditLog: { findFirst: vi.fn() },
  envelopeStatus: vi.fn(),
  voidEnvelope: vi.fn(),
  finalize: vi.fn(),
  notifyChanges: vi.fn(),
  dispatch: vi.fn(),
  audit: vi.fn(),
  leadStage: vi.fn(),
  reportError: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { contract, contractSigner, deal, auditLog } }));
// DocuSign's own messages are the real ones; asking DocuSign is stubbed out.
vi.mock("@/lib/docusign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docusign")>()),
  docusignEnvelopeStatus: envelopeStatus,
  voidDocusignEnvelope: voidEnvelope,
}));
vi.mock("@/lib/signing", () => ({ finalizeContractSigned: finalize }));
vi.mock("@/lib/error-report", () => ({ reportError }));
vi.mock("@/lib/review", () => ({ notifyChangesRequested: notifyChanges }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: dispatch }));
vi.mock("@/lib/audit", () => ({ logAudit: audit }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline: leadStage }));

import { DOCUSIGN_EXPIRED, DOCUSIGN_NOT_CONNECTED } from "@/lib/docusign";
import { docusignEnvelopeExpired, docusignVoid, retireEarlierEnvelope, syncDocusignContract, syncPendingDocusignContracts } from "./docusign-sync";

describe("DocuSign contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "sent", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1", leadId: "l1" } });
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
      where: { id: "c1", status: { in: ["sent", "expired", "changes_requested", "not_signed", "pending_approval"] } },
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

  it("still finalizes a contract the rep marked not signed when the envelope was completed anyway", async () => {
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "not_signed", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1", leadId: "l1" } });
    envelopeStatus.mockResolvedValue({ status: "completed", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed" }] });
    expect(await syncDocusignContract("c1")).toBe(true);
    expect(contract.updateMany.mock.calls[0][0].where.status.in).toContain("not_signed");
    expect(finalize).toHaveBeenCalledWith("c1");
  });

  it("leaves a contract marked not signed alone when the void SealMe sent comes back", async () => {
    contract.findUnique.mockResolvedValue({ id: "c1", dealId: "d1", status: "not_signed", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", deal: { workspaceId: "w1", leadId: "l1" } });
    envelopeStatus.mockResolvedValue({ status: "voided", voidedReason: "Marked as not signed in SealMe", signers: [] });
    // The turned-down guard doesn't include not_signed, so nothing moves.
    contract.updateMany.mockResolvedValue({ count: 0 });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: { in: ["sent", "expired"] } }, data: { status: "changes_requested" } });
    expect(deal.update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
  });

  it("keeps checking contracts marked not signed in the daily sweep", async () => {
    contract.findMany.mockResolvedValue([]);
    await syncPendingDocusignContracts();
    expect(contract.findMany.mock.calls[0][0].where.status).toEqual({ in: ["sent", "expired", "not_signed"] });
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
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.expired", expect.objectContaining({ contractId: "c1", dealId: "d1", leadId: "l1" }));
    // The lead it was for reads "Not signed" now.
    expect(leadStage).toHaveBeenCalledWith("l1");
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

  // The round out now went out on Nov 10. An envelope an older send left on
  // the contract may have been declined or voided before that.
  const thisRound = (over: Record<string, unknown> = {}) => ({ id: "c1", dealId: "d1", status: "expired", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", sentAt: new Date("2026-11-10T09:00:00Z"), deal: { workspaceId: "w1", leadId: "l1" }, ...over });

  it("ignores a decline from before the round out now: no webhook, no email, nothing moves", async () => {
    contract.findUnique.mockResolvedValue(thisRound());
    envelopeStatus.mockResolvedValue({
      status: "declined",
      declinedDateTime: "2026-10-20T12:00:00Z",
      statusChangedDateTime: "2026-10-20T12:00:00Z",
      signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined", declinedReason: "Fee is wrong" }],
    });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(deal.update).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("goes by the signer's decline time, or when the status changed, when the envelope gives none", async () => {
    contract.findUnique.mockResolvedValue(thisRound());
    envelopeStatus.mockResolvedValueOnce({ status: "declined", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined", declinedDateTime: "2026-10-20T12:00:00Z" }] });
    await syncDocusignContract("c1");
    envelopeStatus.mockResolvedValueOnce({ status: "declined", statusChangedDateTime: "2026-10-20T12:00:00Z", signers: [] });
    await syncDocusignContract("c1");
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
  });

  it("acts on a decline in the round out now when that round went out by DocuSign", async () => {
    contract.findUnique.mockResolvedValue(thisRound({ status: "sent" }));
    envelopeStatus.mockResolvedValue({
      status: "declined",
      declinedDateTime: "2026-11-11T08:00:00Z",
      signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined", declinedReason: "Fee is wrong" }],
    });
    expect(await syncDocusignContract("c1")).toBe(false);
    expect(contract.updateMany).toHaveBeenCalledWith({ where: { id: "c1", status: { in: ["sent", "expired"] } }, data: { status: "changes_requested" } });
    expect(deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "changes_requested" } });
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.declined", expect.objectContaining({ contractId: "c1", reason: "Fee is wrong" }));
    expect(notifyChanges).toHaveBeenCalledWith("d1", "Priya Shah", "Declined on DocuSign: Fee is wrong");
  });

  it("leaves a round out by SealMe link alone when the old envelope it still points at closes later", async () => {
    // Sent by DocuSign as env-1, then by SealMe link on Nov 10 by a send from
    // before new rounds let go of the old envelope. env-1 stayed live, and
    // after the link went out it ran out, was voided in DocuSign, or the
    // client declined it there.
    contract.findUnique.mockResolvedValue(thisRound({ status: "sent", deliveryMethod: "sealme" }));
    const closedLater = [
      { status: "voided", voidedReason: "Envelope has expired.", voidedDateTime: "2026-11-12T00:00:00Z", signers: [] },
      { status: "voided", voidedReason: "Cleaning up", voidedDateTime: "2026-11-12T00:00:00Z", signers: [] },
      {
        status: "declined",
        declinedDateTime: "2026-11-11T08:00:00Z",
        signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined", declinedReason: "Fee is wrong" }],
      },
    ];
    for (const envelope of closedLater) {
      envelopeStatus.mockResolvedValueOnce(envelope);
      expect(await syncDocusignContract("c1")).toBe(false);
    }
    // The link the client has stays open: no expiry, no changes_requested, nobody emailed.
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(deal.update).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(leadStage).not.toHaveBeenCalled();
  });

  it("still finalizes a round out by SealMe link when the old envelope it points at was completed", async () => {
    // A real signature wins, whichever way the round out now went.
    contract.findUnique.mockResolvedValue(thisRound({ status: "sent", deliveryMethod: "sealme" }));
    envelopeStatus.mockResolvedValue({ status: "completed", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed", signedDateTime: "2026-11-11T08:00:00Z" }] });
    expect(await syncDocusignContract("c1")).toBe(true);
    expect(finalize).toHaveBeenCalledWith("c1");
  });

  it("ignores a void from before the round out now, an expiry included", async () => {
    contract.findUnique.mockResolvedValue(thisRound({ status: "sent" }));
    envelopeStatus.mockResolvedValueOnce({ status: "voided", voidedReason: "Envelope has expired.", voidedDateTime: "2026-10-25T00:00:00Z", signers: [] });
    await syncDocusignContract("c1");
    envelopeStatus.mockResolvedValueOnce({ status: "voided", voidedReason: "Wrong client", voidedDateTime: "2026-10-25T00:00:00Z", signers: [] });
    await syncDocusignContract("c1");
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("announces a decline only once", async () => {
    envelopeStatus.mockResolvedValue({ status: "declined", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined" }] });
    contract.updateMany.mockResolvedValue({ count: 0 });
    await syncDocusignContract("c1");
    expect(deal.update).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
  });
});

describe("The envelope from before a new round", () => {
  const target: Parameters<typeof retireEarlierEnvelope>[0] = { contractId: "c1", dealId: "d1", workspaceId: "w1", envelopeId: "env-1" };
  const retire = (over: Partial<typeof target> = {}) => retireEarlierEnvelope({ ...target, ...over }, "Replaced by a new version of the contract");
  const completed = { status: "completed", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed", signedDateTime: "2026-11-02T09:00:00Z" }] };
  // The contract stops pointing at env-1, unless a newer send replaced it.
  const letGo = { where: { id: "c1", docusignEnvelopeId: "env-1" }, data: { docusignEnvelopeId: null } };
  const lookupFailed = (status: number, errorCode: string) =>
    new Error(`DocuSign envelope lookup failed: ${status} {"errorCode":"${errorCode}","message":"The envelope specified either does not exist or you have no rights to it."}`);

  beforeEach(() => {
    vi.clearAllMocks();
    contract.updateMany.mockResolvedValue({ count: 1 });
    contractSigner.findMany.mockResolvedValue([]);
  });

  it("is gone without asking DocuSign when there never was one", async () => {
    expect(await retire({ envelopeId: null })).toEqual({ outcome: "gone" });
    expect(envelopeStatus).not.toHaveBeenCalled();
    expect(contract.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes the contract when the client finished it, from any status it can be resent from", async () => {
    envelopeStatus.mockResolvedValue(completed);
    expect(await retire()).toEqual({ outcome: "signed" });
    expect(envelopeStatus).toHaveBeenCalledWith("w1", "env-1");
    expect(contract.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", status: { in: ["sent", "expired", "changes_requested", "not_signed", "pending_approval"] } },
      data: { status: "partially_signed", signerName: "Priya Shah", signedAt: new Date("2026-11-02T09:00:00Z") },
    });
    expect(finalize).toHaveBeenCalledWith("c1");
    expect(voidEnvelope).not.toHaveBeenCalled();
    // A signed envelope stays the contract's.
    expect(contract.updateMany).not.toHaveBeenCalledWith(letGo);
  });

  it("is still signed when DocuSign's own event finalizes it first", async () => {
    envelopeStatus.mockResolvedValue(completed);
    contract.updateMany.mockResolvedValue({ count: 0 });
    expect(await retire()).toEqual({ outcome: "signed" });
    expect(finalize).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("is still signed when finalizing fails, and reports it", async () => {
    envelopeStatus.mockResolvedValue(completed);
    finalize.mockRejectedValueOnce(new Error("db down"));
    expect(await retire()).toEqual({ outcome: "signed" });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("DocuSign"), { dealId: "d1", contractId: "c1" });
  });

  it("voids one still out and lets go of it, so it can't be signed next to the new round", async () => {
    for (const status of ["sent", "delivered"]) {
      envelopeStatus.mockResolvedValueOnce({ status, signers: [] });
      expect(await retire()).toEqual({ outcome: "gone" });
    }
    expect(voidEnvelope).toHaveBeenCalledTimes(2);
    expect(voidEnvelope).toHaveBeenCalledWith("w1", "env-1", "Replaced by a new version of the contract");
    expect(contract.updateMany.mock.calls.map((c) => c[0])).toEqual([letGo, letGo]);
    expect(voidEnvelope.mock.invocationCallOrder[0]).toBeLessThan(contract.updateMany.mock.invocationCallOrder[0]);
  });

  it("says it's still out when the void fails, keeps it, and reports it", async () => {
    envelopeStatus.mockResolvedValue({ status: "delivered", signers: [] });
    voidEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope void failed: 503"));
    expect(await retire()).toEqual({ outcome: "still_out" });
    // Asked once more, in case the client just finished it.
    expect(envelopeStatus).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("Voiding"), { dealId: "d1", contractId: "c1" });
    expect(finalize).not.toHaveBeenCalled();
    expect(contract.updateMany).not.toHaveBeenCalled();
  });

  it("finalizes instead when the void fails because the client just finished it", async () => {
    envelopeStatus.mockResolvedValueOnce({ status: "delivered", signers: [] }).mockResolvedValueOnce(completed);
    voidEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope void failed: 400 ENVELOPE_CANNOT_VOID_INVALID_STATE"));
    expect(await retire()).toEqual({ outcome: "signed" });
    expect(finalize).toHaveBeenCalledWith("c1");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("lets go of a declined, voided or deleted one, without announcing the old decline again", async () => {
    // Declined two rounds back: the team heard about it then.
    envelopeStatus.mockResolvedValueOnce({ status: "declined", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined", declinedReason: "Fee is wrong" }] });
    expect(await retire()).toEqual({ outcome: "gone" });
    envelopeStatus.mockResolvedValueOnce({ status: "voided", voidedReason: "Marked as not signed in SealMe", signers: [] });
    expect(await retire()).toEqual({ outcome: "gone" });
    envelopeStatus.mockResolvedValueOnce({ status: "deleted", signers: [] });
    expect(await retire()).toEqual({ outcome: "gone" });

    expect(voidEnvelope).not.toHaveBeenCalled();
    // Only letting go of it: nothing else about the contract changes.
    expect(contract.updateMany.mock.calls.map((c) => c[0])).toEqual([letGo, letGo, letGo]);
    expect(deal.update).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("is busy while everyone signed and DocuSign is still finishing it, or in a state it doesn't know", async () => {
    for (const status of ["signed", "correct", "processing", "unknown"]) {
      envelopeStatus.mockResolvedValueOnce({ status, signers: [] });
      expect(await retire()).toEqual({ outcome: "busy" });
    }
    // Not voided, not finalized yet, and still the contract's envelope.
    expect(voidEnvelope).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("lets go of one the DocuSign account connected now can't see, and reports it", async () => {
    // Someone reconnected another DocuSign account or user since it went out.
    const cases = [
      new Error('DocuSign envelope lookup failed: 404 {"message":"Not found"}'),
      lookupFailed(400, "ENVELOPE_DOES_NOT_EXIST"),
      lookupFailed(400, "USER_NOT_ENVELOPE_SENDER_OR_RECIPIENT"),
    ];
    for (const err of cases) {
      envelopeStatus.mockRejectedValueOnce(err);
      expect(await retire()).toEqual({ outcome: "gone" });
    }
    expect(contract.updateMany.mock.calls.map((c) => c[0])).toEqual([letGo, letGo, letGo]);
    expect(reportError).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledWith(cases[1], expect.stringContaining("connected account"), { dealId: "d1", contractId: "c1" });
    expect(voidEnvelope).not.toHaveBeenCalled();
  });

  it("says DocuSign is disconnected, with the words the rep sees, without reporting it or letting go", async () => {
    for (const message of [DOCUSIGN_EXPIRED, DOCUSIGN_NOT_CONNECTED]) {
      const err = new Error(message);
      envelopeStatus.mockRejectedValueOnce(err);
      expect(await retire()).toEqual({ outcome: "disconnected", error: err });
    }
    expect(reportError).not.toHaveBeenCalled();
    expect(contract.updateMany).not.toHaveBeenCalled();
    expect(voidEnvelope).not.toHaveBeenCalled();
  });

  it("says it couldn't check when DocuSign can't be reached, and reports it", async () => {
    for (const err of [new Error("fetch failed"), new Error("DocuSign envelope lookup failed: 503 Service Unavailable"), new Error("DocuSign token request failed: 500 ")]) {
      envelopeStatus.mockRejectedValueOnce(err);
      expect(await retire()).toEqual({ outcome: "unchecked" });
    }
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("Checking"), { dealId: "d1", contractId: "c1" });
    expect(voidEnvelope).not.toHaveBeenCalled();
    expect(contract.updateMany).not.toHaveBeenCalled();
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
