import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, envelopeStatus, voidEnvelope, finalize, notifyChanges, dispatch, audit, refreshLead, reportError, revalidatePath } = vi.hoisted(() => ({
  prisma: {
    deal: { findFirst: vi.fn(), update: vi.fn() },
    contract: { updateMany: vi.fn() },
    contractSigner: { findMany: vi.fn(), updateMany: vi.fn() },
  },
  envelopeStatus: vi.fn(),
  voidEnvelope: vi.fn(),
  finalize: vi.fn(),
  notifyChanges: vi.fn(),
  dispatch: vi.fn(),
  audit: vi.fn(),
  refreshLead: vi.fn(),
  reportError: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: { ownerId: "u1" }, userId: "u1" }) }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "ana@agency.test" } }) }));
vi.mock("@/lib/audit", () => ({ logAudit: audit }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: dispatch }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline: refreshLead }));
// The real DocuSign check (docusign-sync), with DocuSign itself and the
// signing that follows stubbed out.
vi.mock("@/lib/docusign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docusign")>()),
  docusignEnvelopeStatus: envelopeStatus,
  voidDocusignEnvelope: voidEnvelope,
}));
vi.mock("@/lib/signing", () => ({ finalizeContractSigned: finalize }));
vi.mock("@/lib/review", () => ({ notifyChangesRequested: notifyChanges }));
vi.mock("@/lib/error-report", () => ({ reportError }));

import { DOCUSIGN_EXPIRED } from "@/lib/docusign";
import { markContractNotSigned } from "./not-signed-actions";

const sentAt = new Date("2026-11-01T10:00:00Z");
function deal(contract: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    id: "d1",
    kind: "contract",
    trashedAt: null,
    leadId: "l1",
    contract: { id: "k1", status: "sent", deliveryMethod: "sealme", expiresAt: null, sentAt, docusignEnvelopeId: null, ...contract },
    ...over,
  };
}

describe("Marking a contract not signed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.contractSigner.findMany.mockResolvedValue([]);
  });

  it("closes a sent contract, announces it and moves the lead to Not signed", async () => {
    prisma.deal.findFirst.mockResolvedValue(deal());
    expect(await markContractNotSigned("d1")).toEqual({});

    // Only deals this rep can see, in this workspace.
    expect(prisma.deal.findFirst.mock.calls[0][0].where).toEqual({ id: "d1", workspaceId: "w1", ownerId: "u1" });
    // Claimed over the status it read; the send date and any signature stay.
    expect(prisma.contract.updateMany).toHaveBeenCalledWith({ where: { id: "k1", status: "sent" }, data: { status: "not_signed" } });
    expect(audit).toHaveBeenCalledWith({
      workspaceId: "w1",
      actorEmail: "ana@agency.test",
      action: "contract.marked_not_signed",
      targetType: "Contract",
      targetId: "k1",
      metadata: { previousStatus: "sent" },
    });
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.not_signed", {
      dealId: "d1",
      contractId: "k1",
      leadId: "l1",
      sentAt: sentAt.toISOString(),
      markedAt: expect.any(String),
      markedBy: "ana@agency.test",
    });
    expect(refreshLead).toHaveBeenCalledWith("l1", { unsignedNow: true });
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(["/deals/d1", "/deals/d1/contract", "/leads", "/leads/l1"]);
    // Nothing to void on SealMe's own link, nor anything to ask DocuSign.
    expect(envelopeStatus).not.toHaveBeenCalled();
    expect(voidEnvelope).not.toHaveBeenCalled();
  });

  it("works on a contract that's partly signed, expired, or that the client declined", async () => {
    const cases = [
      { status: "partially_signed" },
      { status: "expired" },
      // A SealMe link past its date the daily cron hasn't marked yet.
      { status: "sent", expiresAt: new Date(Date.now() - 60_000) },
      { status: "changes_requested", sentAt },
    ];
    for (const c of cases) {
      prisma.deal.findFirst.mockResolvedValueOnce(deal(c));
      expect(await markContractNotSigned("d1")).toEqual({});
      expect(prisma.contract.updateMany).toHaveBeenLastCalledWith({ where: { id: "k1", status: c.status }, data: { status: "not_signed" } });
    }
    expect(refreshLead).toHaveBeenCalledTimes(cases.length);
  });

  it("does nothing more for one already marked not signed", async () => {
    prisma.deal.findFirst.mockResolvedValue(deal({ status: "not_signed" }));
    expect(await markContractNotSigned("d1")).toEqual({});
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(refreshLead).not.toHaveBeenCalled();
  });

  it("refuses a contract that's signed, in review or never went out", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ status: "signed" }, /already signed/],
      [{ status: "pending_approval" }, /waiting on review/],
      [{ status: "draft", sentAt: null }, /hasn't gone to the client/],
      // A reviewer sent it back before it ever went out.
      [{ status: "changes_requested", sentAt: null }, /hasn't gone to the client/],
    ];
    for (const [contract, error] of cases) {
      prisma.deal.findFirst.mockResolvedValueOnce(deal(contract));
      expect((await markContractNotSigned("d1")).error).toMatch(error);
    }
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses a proposal, a deal in the trash and one it can't find", async () => {
    prisma.deal.findFirst.mockResolvedValueOnce(deal({}, { kind: "proposal" }));
    expect((await markContractNotSigned("d1")).error).toMatch(/proposal isn't signed/);
    prisma.deal.findFirst.mockResolvedValueOnce(deal({}, { trashedAt: new Date() }));
    expect((await markContractNotSigned("d1")).error).toMatch(/in the trash/);
    prisma.deal.findFirst.mockResolvedValueOnce(null);
    expect((await markContractNotSigned("d1")).error).toBe("Deal not found");
    prisma.deal.findFirst.mockResolvedValueOnce(deal({}, { contract: null }));
    expect((await markContractNotSigned("d1")).error).toBe("Deal not found");
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
  });

  it("asks the rep to refresh when the contract moved on meanwhile, like a signature landing", async () => {
    prisma.deal.findFirst.mockResolvedValue(deal());
    prisma.contract.updateMany.mockResolvedValue({ count: 0 });
    expect((await markContractNotSigned("d1")).error).toMatch(/Refresh the page/);
    expect(audit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(refreshLead).not.toHaveBeenCalled();
  });

  const byDocusign = (over: Record<string, unknown> = {}) => deal({ deliveryMethod: "docusign", docusignEnvelopeId: "env-1", ...over });
  const completed = { status: "completed", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "completed", signedDateTime: "2026-11-02T09:00:00Z" }] };

  // The contract stops pointing at env-1.
  const letGo = { where: { id: "k1", docusignEnvelopeId: "env-1" }, data: { docusignEnvelopeId: null } };

  it("voids the DocuSign envelope still out and lets go of it", async () => {
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockResolvedValue({ status: "delivered", signers: [] });
    expect(await markContractNotSigned("d1")).toEqual({});
    expect(envelopeStatus).toHaveBeenCalledWith("w1", "env-1");
    expect(voidEnvelope).toHaveBeenCalledWith("w1", "env-1", "Marked as not signed in SealMe");
    // The claim comes first, so a signature in between isn't overwritten and two clicks can't both run.
    expect(prisma.contract.updateMany.mock.invocationCallOrder[0]).toBeLessThan(envelopeStatus.mock.invocationCallOrder[0]);
    // Voided, so nothing can happen to it anymore: nobody asks about it again.
    expect(prisma.contract.updateMany).toHaveBeenLastCalledWith(letGo);
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.not_signed", expect.anything());
  });

  it("still marks it when the void fails, and reports the failure", async () => {
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockResolvedValue({ status: "delivered", signers: [] });
    voidEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope void failed: 500"));
    expect(await markContractNotSigned("d1")).toEqual({});
    // DocuSign was asked again, and the client hasn't signed it.
    expect(envelopeStatus).toHaveBeenCalledTimes(2);
    expect(finalize).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("DocuSign"), { dealId: "d1", contractId: "k1" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "contract.marked_not_signed" }));
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.not_signed", expect.anything());
    expect(refreshLead).toHaveBeenCalledWith("l1", { unsignedNow: true });
    // Still the contract's envelope, so the daily check finalizes it if the client signs.
    expect(prisma.contract.updateMany).not.toHaveBeenCalledWith(letGo);
  });

  it("finalizes it instead when the client already signed in DocuSign", async () => {
    // Signed at 09:00, but DocuSign's event never reached SealMe.
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockResolvedValue(completed);

    expect(await markContractNotSigned("d1")).toEqual({ error: "The client already signed this in DocuSign. It's marked signed now" });
    // Claimed first, so a second click can't run alongside; then finalized from not_signed.
    expect(prisma.contract.updateMany.mock.calls[0][0]).toEqual({ where: { id: "k1", status: "sent" }, data: { status: "not_signed" } });
    expect(prisma.contract.updateMany.mock.calls[1][0].where.status.in).toContain("not_signed");
    expect(finalize).toHaveBeenCalledWith("k1");
    // A finished envelope can't be voided.
    expect(voidEnvelope).not.toHaveBeenCalled();
    // Nothing says Not signed: no webhook, no audit entry, and the lead isn't moved.
    expect(dispatch).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(refreshLead).not.toHaveBeenCalled();
    // Not a failure worth an alert, and the page stays put so the rep reads why.
    expect(reportError).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("says it's signed, not Not signed, while DocuSign's own event finalizes it alongside", async () => {
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockResolvedValue(completed);
    // The rep's claim wins, then the webhook's check claims the contract first.
    prisma.contract.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect(await markContractNotSigned("d1")).toEqual({ error: "The client already signed this in DocuSign. It's marked signed now" });
    // The webhook's check finalizes it, not this one.
    expect(finalize).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalledWith("w1", "contract.not_signed", expect.anything());
    expect(audit).not.toHaveBeenCalled();
    expect(refreshLead).not.toHaveBeenCalled();
  });

  it("says it's signed even when finalizing fails, and reports that", async () => {
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockResolvedValue(completed);
    finalize.mockRejectedValueOnce(new Error("db down"));

    expect((await markContractNotSigned("d1")).error).toMatch(/already signed this in DocuSign/);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it("finalizes it when the void fails because the client finished it a moment ago", async () => {
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockResolvedValueOnce({ status: "delivered", signers: [] }).mockResolvedValueOnce(completed);
    voidEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope void failed: 400 ENVELOPE_CANNOT_VOID_INVALID_STATE"));

    expect((await markContractNotSigned("d1")).error).toMatch(/already signed this in DocuSign/);
    expect(finalize).toHaveBeenCalledWith("k1");
    expect(dispatch).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("still marks it when DocuSign can't be reached, or is disconnected", async () => {
    for (const err of [new Error("fetch failed"), new Error(DOCUSIGN_EXPIRED)]) {
      prisma.deal.findFirst.mockResolvedValueOnce(byDocusign());
      envelopeStatus.mockRejectedValueOnce(err);
      expect(await markContractNotSigned("d1")).toEqual({});
    }
    // Both reported, and the contract keeps the envelope: the daily DocuSign
    // check still looks at not_signed contracts.
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenLastCalledWith(expect.objectContaining({ message: DOCUSIGN_EXPIRED }), expect.stringContaining("DocuSign"), { dealId: "d1", contractId: "k1" });
    expect(voidEnvelope).not.toHaveBeenCalled();
    expect(prisma.contract.updateMany).not.toHaveBeenCalledWith(letGo);
    expect(dispatch.mock.calls.map((c) => c[1])).toEqual(["contract.not_signed", "contract.not_signed"]);
    expect(refreshLead).toHaveBeenCalledWith("l1", { unsignedNow: true });
  });

  it("puts it back and says so while the client is signing in DocuSign right now", async () => {
    // Everyone signed; DocuSign is still finishing the envelope.
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockResolvedValue({ status: "signed", signers: [] });

    expect(await markContractNotSigned("d1")).toEqual({ error: "The client is signing this in DocuSign right now. Try again in a minute" });
    // Claimed, then back to where it was, unless the signature already moved it on.
    expect(prisma.contract.updateMany.mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "k1", status: "sent" }, data: { status: "not_signed" } },
      { where: { id: "k1", status: "not_signed" }, data: { status: "sent" } },
    ]);
    expect(voidEnvelope).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(refreshLead).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("marks it and lets go of an envelope the DocuSign account connected now can't see", async () => {
    prisma.deal.findFirst.mockResolvedValue(byDocusign());
    envelopeStatus.mockRejectedValueOnce(new Error('DocuSign envelope lookup failed: 400 {"errorCode":"USER_NOT_ENVELOPE_SENDER_OR_RECIPIENT"}'));

    expect(await markContractNotSigned("d1")).toEqual({});
    expect(prisma.contract.updateMany).toHaveBeenLastCalledWith(letGo);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith("w1", "contract.not_signed", expect.anything());
  });

  it("leaves an envelope DocuSign already closed, without announcing its decline again", async () => {
    // DocuSign voided it when it expired, a signer declined there, or the rep
    // sent the next version through SealMe after that.
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ status: "expired" }, { status: "voided", voidedReason: "Envelope has expired.", signers: [] }],
      [{ status: "changes_requested" }, { status: "declined", signers: [{ name: "Priya Shah", email: "a@x.test", routingOrder: "1", status: "declined" }] }],
      [{ deliveryMethod: "sealme" }, { status: "declined", signers: [] }],
    ];
    for (const [contract, envelope] of cases) {
      prisma.deal.findFirst.mockResolvedValueOnce(byDocusign(contract));
      envelopeStatus.mockResolvedValueOnce(envelope);
      expect(await markContractNotSigned("d1")).toEqual({});
    }
    expect(voidEnvelope).not.toHaveBeenCalled();
    expect(notifyChanges).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.map((c) => c[1])).toEqual(["contract.not_signed", "contract.not_signed", "contract.not_signed"]);
    // Nothing more can happen to those envelopes, so the contracts let go of them.
    expect(prisma.contract.updateMany.mock.calls.filter((c) => "docusignEnvelopeId" in c[0].data)).toHaveLength(3);
  });

  it("marks a contract with no lead without moving any lead page", async () => {
    prisma.deal.findFirst.mockResolvedValue(deal({}, { leadId: null }));
    expect(await markContractNotSigned("d1")).toEqual({});
    expect(refreshLead).toHaveBeenCalledWith(null, { unsignedNow: true });
    expect(revalidatePath.mock.calls.map((c) => c[0])).toEqual(["/deals/d1", "/deals/d1/contract", "/leads"]);
  });
});
