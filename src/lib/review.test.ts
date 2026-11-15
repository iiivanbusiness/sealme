import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, sendContractEmail, sendChangesRequestedEmail, renderToBuffer, sendDocusignEnvelope, docusignEnvelopeStatus, voidDocusignEnvelope, finalizeContractSigned, reportError, logAudit, getOrMintPortalToken, dispatchWebhookEvent, notifySlack, syncDealToHubspot, syncDealToSalesforce, refreshLeadPipeline } = vi.hoisted(() => ({
  prisma: {
    deal: { findUnique: vi.fn(), update: vi.fn() },
    contract: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    contractSigner: { update: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    clauseComment: { updateMany: vi.fn() },
    reviewChain: { findMany: vi.fn() },
    reviewStep: { deleteMany: vi.fn(), create: vi.fn(), findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    // The writes are already made by the time they're handed over.
    $transaction: vi.fn(async (writes: unknown[]) => Promise.all(writes)),
  },
  sendContractEmail: vi.fn(),
  sendChangesRequestedEmail: vi.fn(),
  renderToBuffer: vi.fn(),
  sendDocusignEnvelope: vi.fn(),
  docusignEnvelopeStatus: vi.fn(),
  voidDocusignEnvelope: vi.fn(),
  finalizeContractSigned: vi.fn(),
  reportError: vi.fn(),
  logAudit: vi.fn(),
  getOrMintPortalToken: vi.fn(async () => "portal"),
  dispatchWebhookEvent: vi.fn(),
  notifySlack: vi.fn(),
  syncDealToHubspot: vi.fn(),
  syncDealToSalesforce: vi.fn(),
  refreshLeadPipeline: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/email", () => ({ sendContractEmail, sendReviewAssignedEmail: vi.fn(), sendChangesRequestedEmail }));
vi.mock("@react-pdf/renderer", () => ({ renderToBuffer }));
vi.mock("@/lib/contract-pdf", () => ({ ContractPdfDocument: () => null }));
// The real DocuSign check (docusign-sync), with DocuSign itself and the
// signing that follows stubbed out.
vi.mock("@/lib/docusign", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/docusign")>()),
  sendDocusignEnvelope,
  docusignEnvelopeStatus,
  voidDocusignEnvelope,
}));
vi.mock("@/lib/signing", () => ({ finalizeContractSigned }));
vi.mock("@/lib/error-report", () => ({ reportError }));
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/client-portal", () => ({ getOrMintPortalToken }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent }));
vi.mock("@/lib/slack", () => ({ notifySlack }));
vi.mock("@/lib/hubspot", () => ({ syncDealToHubspot }));
vi.mock("@/lib/salesforce", () => ({ syncDealToSalesforce }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline }));

import { DOCUSIGN_EXPIRED, DOCUSIGN_NOT_CONNECTED } from "@/lib/docusign";
import { canSendContract, canSendDocument, performActualSend, requestOrSendReview, type SendSetup } from "./review";

const CLAUSES = JSON.stringify([{ title: "Fees", body: "The fee is {fee}." }]);
const FEE = { fieldKey: "fee", label: "Fee", value: "$5,000 / month" };
const PENDING = { to: "client@x.test", subject: "Agreement", message: "Hi" };

const ana = { email: "ana@agency.test", role: { canManageWorkspace: false } };
const owner = { email: "owner@agency.test", role: { canManageWorkspace: false } };
const admin = { email: "admin@agency.test", role: { canManageWorkspace: true } };

function contract(overrides: Record<string, unknown> = {}) {
  return {
    id: "k1",
    status: "draft",
    deliveryMethod: "sealme",
    docusignEnvelopeId: null,
    reminderSentAt: null,
    ccEmails: null,
    pendingTo: null,
    pendingSubject: null,
    pendingMessage: null,
    template: { name: "Retainer", clauses: CLAUSES },
    signers: [],
    deal: {
      id: "d1",
      workspaceId: "w1",
      client: { id: "c1", name: "Priya Shah" },
      owner,
      fields: [FEE],
      workspace: { id: "w1", name: "Agency", users: [ana, owner, admin], senderDomainStatus: null, signingExpiryDays: null },
    },
    ...overrides,
  };
}

type Row = Record<string, unknown>;

// The contract's row as the database would keep it, for the sends that read
// it again after writing: updateMany only writes when every condition holds
// (a status list included), the way Postgres would, and every read sees the
// writes before it. Its signer rows too, as a send's setup replaces them.
function databaseRow(initial: Row): () => Row {
  let row: Row = { ...initial };
  const same = (a: unknown, b: unknown) => (a instanceof Date ? a.getTime() : a) === (b instanceof Date ? b.getTime() : b);
  prisma.contract.findUnique.mockImplementation(async () => ({ ...row }));
  prisma.contract.updateMany.mockImplementation(async ({ where, data }: { where: Row; data: Row }) => {
    for (const [key, wanted] of Object.entries(where)) {
      if (key === "id") continue;
      const list = (wanted as { in?: unknown[] } | null)?.in;
      if (list ? !list.includes(row[key]) : !same(wanted, row[key])) return { count: 0 };
    }
    row = { ...row, ...data };
    return { count: 1 };
  });
  prisma.contract.update.mockImplementation(async ({ data }: { data: Row }) => {
    row = { ...row, ...data };
    return row;
  });
  prisma.contractSigner.deleteMany.mockImplementation(async () => {
    const count = ((row.signers as Row[] | undefined) ?? []).length;
    row = { ...row, signers: [] };
    return { count };
  });
  prisma.contractSigner.createMany.mockImplementation(async ({ data }: { data: Row[] }) => {
    const created = data.map((s, i) => ({ id: `new-${i + 1}`, status: "pending", notifiedAt: null, ...s }));
    row = { ...row, signers: [...((row.signers as Row[] | undefined) ?? []), ...created] };
    return { count: created.length };
  });
  return () => row;
}

describe("When a contract can be sent", () => {
  it("only as a draft, after changes were asked for, or once it expired", () => {
    const at = (status: string, deliveryMethod = "sealme", expiresAt: Date | null = null) => canSendContract({ status, deliveryMethod, expiresAt });
    for (const status of ["draft", "changes_requested", "expired"]) expect(at(status)).toBe(true);
    // The rep marked it not signed: it can go out again, on either delivery.
    expect(at("not_signed")).toBe(true);
    expect(at("not_signed", "docusign")).toBe(true);
    for (const status of ["pending_approval", "sent", "partially_signed", "signed"]) expect(at(status)).toBe(false);
    expect(at("sent", "sealme", new Date(Date.now() - 1000))).toBe(true);
    expect(at("sent", "docusign", new Date(Date.now() - 1000))).toBe(false);
  });
});

describe("Sending a contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewChain.findMany.mockResolvedValue([]);
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.contract.update.mockResolvedValue({});
  });

  it("refuses one that already went out, before anything is sent", async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", fields: [FEE], contract: contract({ status: "sent", expiresAt: null }) });
    await expect(requestOrSendReview("d1", PENDING)).rejects.toThrow("already sent");
    expect(sendContractEmail).not.toHaveBeenCalled();
  });

  it("refuses one with a blank term", async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", fields: [{ ...FEE, value: null }], contract: contract({ expiresAt: null }) });
    await expect(requestOrSendReview("d1", PENDING)).rejects.toThrow("Fill in Fee");
    expect(sendContractEmail).not.toHaveBeenCalled();
  });

  it("sends client replies to whoever sent it, else the deal's owner, else an admin", async () => {
    prisma.contract.findUnique.mockResolvedValue(contract());
    await performActualSend("k1", PENDING, ana.email);
    expect(sendContractEmail.mock.calls[0][0].replyTo).toBe(ana.email);

    // An offboarded sender isn't in the active list.
    await performActualSend("k1", PENDING, "gone@agency.test");
    expect(sendContractEmail.mock.calls[1][0].replyTo).toBe(owner.email);

    // The last approval sends what's stored on the contract, with no sender.
    const approved = contract({ status: "pending_approval", pendingTo: PENDING.to, pendingSubject: PENDING.subject, pendingMessage: PENDING.message });
    approved.deal = { ...approved.deal, owner: null as unknown as typeof owner };
    prisma.contract.findUnique.mockResolvedValue(approved);
    await performActualSend("k1");
    expect(sendContractEmail.mock.calls[2][0].replyTo).toBe(admin.email);
  });

  it("freezes what goes out, and builds the DocuSign PDF from that same text", async () => {
    prisma.contract.findUnique.mockResolvedValue(contract());
    await performActualSend("k1", PENDING);
    const sent = prisma.contract.update.mock.calls[0][0].data.snapshot;
    expect(sent).toEqual({ templateName: "Retainer", agencyName: "Agency", clientName: "Priya Shah", clauses: [{ title: "Fees", body: "The fee is $5,000 / month." }] });

    prisma.contract.findUnique.mockResolvedValue(contract({ deliveryMethod: "docusign" }));
    await performActualSend("k1", PENDING);
    expect(renderToBuffer.mock.calls[0][0].props).toMatchObject({ templateName: sent.templateName, agencyName: sent.agencyName, clientName: sent.clientName, clauses: sent.clauses });
    expect(prisma.contract.update.mock.calls[1][0].data.snapshot).toEqual(sent);
  });

  it("starts a fresh signing round on a resend", async () => {
    prisma.contract.findUnique.mockResolvedValue(
      contract({
        status: "changes_requested",
        signers: [
          { id: "s1", status: "signed", notifiedAt: new Date() },
          { id: "s2", status: "declined", notifiedAt: new Date() },
          { id: "s3", status: "pending", notifiedAt: null },
        ],
      }),
    );
    await performActualSend("k1", PENDING);

    expect(prisma.contract.update.mock.calls[0][0].data).toMatchObject({ status: "sent", signedAt: null, signerName: null, signatureImage: null, signerIp: null, reminderSentAt: null });
    expect(prisma.contractSigner.update.mock.calls.map((c) => c[0].where.id)).toEqual(["s1", "s2"]);
    expect(prisma.contractSigner.update.mock.calls[0][0].data).toMatchObject({ status: "pending", signatureImage: null, signedAt: null, declinedReason: null, notifiedAt: null });
    expect(prisma.contractSigner.update.mock.calls[0][0].data.token).toMatch(/^[0-9a-f]{48}$/);
  });
});

describe("Sending a contract marked not signed again", () => {
  const unsigned = () => {
    const base = contract({ status: "not_signed", expiresAt: null, sentAt: new Date("2026-11-01") });
    return { ...base, deal: { ...base.deal, leadId: "lead1" } };
  };
  const dealRow = () => ({ id: "d1", workspaceId: "w1", kind: "contract", leadId: "lead1", teamId: null, feeDisplay: "$5,000", fields: [FEE], contract: unsigned() });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewChain.findMany.mockResolvedValue([]);
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.contract.update.mockResolvedValue({});
  });

  it("goes out as a new round and brings the lead back", async () => {
    prisma.deal.findUnique.mockResolvedValue(dealRow());
    prisma.contract.findUnique.mockResolvedValue(unsigned());

    expect(await requestOrSendReview("d1", PENDING)).toEqual({ status: "sent" });
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
    expect(prisma.contract.update.mock.calls[0][0].data).toMatchObject({ status: "sent", signedAt: null, signerName: null });
    expect(refreshLeadPipeline).toHaveBeenCalledWith("lead1", { sentNow: true });
  });

  it("brings the lead back as soon as the rep clicks Send, even while it waits on review", async () => {
    prisma.reviewChain.findMany.mockResolvedValue([{ name: "Legal", teamId: null, minDealValue: null, steps: [{ assigneeId: "u9", order: 1 }] }]);
    prisma.deal.findUnique.mockResolvedValue(dealRow());
    prisma.reviewStep.create.mockResolvedValue({ id: "rs1", order: 1 });
    prisma.user.findUnique.mockResolvedValue({ name: "Lee" });

    expect(await requestOrSendReview("d1", PENDING, ana.email)).toEqual({ status: "pending_approval", assigneeName: "Lee" });
    expect(prisma.contract.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "pending_approval" }) }));
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).toHaveBeenCalledWith("lead1", { sentNow: true });
  });
});

describe("Sending a contract that went out by DocuSign before", () => {
  // Out by DocuSign before as env-1, then marked not signed. Without a Send
  // page setup, the round goes out the way the contract is set to.
  const earlier = (overrides: Record<string, unknown> = {}) => {
    const base = contract({ status: "not_signed", deliveryMethod: "docusign", docusignEnvelopeId: "env-1", expiresAt: null, sentAt: new Date("2026-11-01"), ...overrides });
    return { ...base, deal: { ...base.deal, leadId: "lead1" } };
  };
  const dealRow = (c: Row) => ({ id: "d1", workspaceId: "w1", kind: "contract", leadId: "lead1", teamId: null, feeDisplay: "$5,000", fields: [FEE], contract: c });
  let row: () => Row;
  const send = (c: Row = earlier(), setup?: SendSetup) => {
    prisma.deal.findUnique.mockResolvedValue(dealRow(c));
    row = databaseRow(c);
    return requestOrSendReview("d1", PENDING, ana.email, setup);
  };
  const bySealme = () => earlier({ deliveryMethod: "sealme" });
  const withChain = () => {
    prisma.reviewChain.findMany.mockResolvedValue([{ name: "Legal", teamId: null, minDealValue: null, steps: [{ assigneeId: "u9", order: 1 }] }]);
    prisma.reviewStep.create.mockResolvedValue({ id: "rs1", order: 1 });
    prisma.user.findUnique.mockResolvedValue({ name: "Lee" });
  };
  const completed = { status: "completed", signers: [{ name: "Priya Shah", email: "client@x.test", routingOrder: "1", status: "completed", signedDateTime: "2026-11-02T09:00:00Z" }] };
  const stillOut = { status: "delivered", signers: [] };
  const REPLACED = "Replaced by a new version of the contract";
  // The contract letting go of env-1.
  const letGo = { where: { id: "k1", docusignEnvelopeId: "env-1" }, data: { docusignEnvelopeId: null } };
  // What the new round wrote over the contract, if anything went out.
  const sentRound = () => prisma.contract.update.mock.calls.map((c) => c[0].data).find((d) => d.status === "sent");

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewChain.findMany.mockResolvedValue([]);
    prisma.contractSigner.findMany.mockResolvedValue([]);
    sendDocusignEnvelope.mockResolvedValue("env-2");
    voidDocusignEnvelope.mockResolvedValue(undefined);
    docusignEnvelopeStatus.mockResolvedValue({ status: "voided", voidedReason: "Marked as not signed in SealMe", signers: [] });
  });

  it("finalizes it and sends nothing when the client already signed the old envelope", async () => {
    // The client signed env-1, but DocuSign's event never reached SealMe.
    docusignEnvelopeStatus.mockResolvedValue(completed);

    await expect(send()).rejects.toThrow("The client already signed this in DocuSign, so nothing was sent again. It's marked signed now");
    expect(docusignEnvelopeStatus).toHaveBeenCalledWith("w1", "env-1");
    expect(prisma.contract.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "k1", status: { in: ["sent", "expired", "changes_requested", "not_signed", "pending_approval"] } } }));
    expect(finalizeContractSigned).toHaveBeenCalledWith("k1");
    // No second envelope, and env-1 stays the contract's envelope.
    expect(voidDocusignEnvelope).not.toHaveBeenCalled();
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(renderToBuffer).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(row().docusignEnvelopeId).toBe("env-1");
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("finalizes it from whatever status it's resent from, and on a SealMe send too", async () => {
    docusignEnvelopeStatus.mockResolvedValue(completed);
    for (const c of [earlier({ status: "expired" }), earlier({ status: "changes_requested" }), bySealme()]) {
      await expect(send(c)).rejects.toThrow("already signed this in DocuSign");
    }
    expect(finalizeContractSigned).toHaveBeenCalledTimes(3);
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
  });

  it("says it's signed even when DocuSign's own event finalizes it first", async () => {
    docusignEnvelopeStatus.mockResolvedValue(completed);
    withChain();
    prisma.deal.findUnique.mockResolvedValue(dealRow(earlier()));
    // DocuSign's event claimed the contract a moment before.
    prisma.contract.updateMany.mockResolvedValue({ count: 0 });

    await expect(requestOrSendReview("d1", PENDING, ana.email)).rejects.toThrow("already signed this in DocuSign");
    // The event's check finalizes it, and nothing waits on review over a signed contract.
    expect(finalizeContractSigned).not.toHaveBeenCalled();
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });

  it("checks before it waits on review", async () => {
    docusignEnvelopeStatus.mockResolvedValue(completed);
    withChain();

    await expect(send()).rejects.toThrow("already signed this in DocuSign");
    expect(finalizeContractSigned).toHaveBeenCalledWith("k1");
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
  });

  it("voids an old envelope still out, lets go of it, then sends the new one", async () => {
    docusignEnvelopeStatus.mockResolvedValue(stillOut);

    expect(await send()).toEqual({ status: "sent" });
    expect(voidDocusignEnvelope).toHaveBeenCalledWith("w1", "env-1", REPLACED);
    expect(prisma.contract.updateMany).toHaveBeenCalledWith(letGo);
    expect(voidDocusignEnvelope.mock.invocationCallOrder[0]).toBeLessThan(sendDocusignEnvelope.mock.invocationCallOrder[0]);
    // Asked once: the send itself finds nothing left on the contract.
    expect(docusignEnvelopeStatus).toHaveBeenCalledTimes(1);
    expect(sentRound()).toMatchObject({ status: "sent", docusignEnvelopeId: "env-2" });
  });

  it("voids an old envelope still out before it waits on review", async () => {
    docusignEnvelopeStatus.mockResolvedValue(stillOut);
    withChain();

    expect(await send()).toEqual({ status: "pending_approval", assigneeName: "Lee" });
    expect(voidDocusignEnvelope).toHaveBeenCalledWith("w1", "env-1", REPLACED);
    expect(voidDocusignEnvelope.mock.invocationCallOrder[0]).toBeLessThan(prisma.reviewStep.create.mock.invocationCallOrder[0]);
    expect(row().docusignEnvelopeId).toBeNull();
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
  });

  it("sends a SealMe link with no envelope left on the contract", async () => {
    docusignEnvelopeStatus.mockResolvedValue(stillOut);

    expect(await send(bySealme())).toEqual({ status: "sent" });
    expect(voidDocusignEnvelope).toHaveBeenCalledWith("w1", "env-1", REPLACED);
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
    expect(sentRound()).toMatchObject({ status: "sent", docusignEnvelopeId: null });
  });

  it("sends nothing, by DocuSign or by SealMe link, when the old envelope can't be voided", async () => {
    docusignEnvelopeStatus.mockResolvedValue(stillOut);
    voidDocusignEnvelope.mockRejectedValue(new Error("DocuSign envelope void failed: 503"));

    // A SealMe link would leave env-1 signable, and its signature would land on the new terms.
    for (const c of [earlier(), bySealme()]) {
      await expect(send(c)).rejects.toThrow("Couldn't cancel the DocuSign envelope sent before, so nothing went out. Try again in a minute");
      expect(row().docusignEnvelopeId).toBe("env-1");
    }
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), expect.stringContaining("DocuSign"), { dealId: "d1", contractId: "k1" });
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("sends nothing, by DocuSign or by SealMe link, when DocuSign can't be reached", async () => {
    docusignEnvelopeStatus.mockRejectedValue(new Error("DocuSign envelope lookup failed: 503"));

    for (const c of [earlier(), bySealme()]) {
      await expect(send(c)).rejects.toThrow("Couldn't check the DocuSign envelope sent before, so nothing went out. Try again in a minute");
      expect(row().docusignEnvelopeId).toBe("env-1");
    }
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(2);
  });

  it("sends nothing, by DocuSign or by SealMe link, while the client is signing the old envelope", async () => {
    // Everyone signed it; DocuSign is still finishing the envelope.
    docusignEnvelopeStatus.mockResolvedValue({ status: "signed", signers: [] });
    withChain();

    for (const c of [earlier(), bySealme()]) {
      await expect(send(c)).rejects.toThrow("The client is signing this in DocuSign right now. Try again in a minute");
      expect(row().docusignEnvelopeId).toBe("env-1");
    }
    expect(voidDocusignEnvelope).not.toHaveBeenCalled();
    expect(finalizeContractSigned).not.toHaveBeenCalled();
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("sends by DocuSign when the old envelope isn't on the DocuSign account connected now", async () => {
    // An admin reconnected another DocuSign user since env-1 went out.
    docusignEnvelopeStatus.mockRejectedValue(new Error('DocuSign envelope lookup failed: 400 {"errorCode":"USER_NOT_ENVELOPE_SENDER_OR_RECIPIENT"}'));

    expect(await send()).toEqual({ status: "sent" });
    expect(prisma.contract.updateMany).toHaveBeenCalledWith(letGo);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
    expect(sentRound()).toMatchObject({ status: "sent", docusignEnvelopeId: "env-2" });
  });

  it("tells the rep to reconnect DocuSign, the way a first send does, and sends nothing by DocuSign", async () => {
    for (const message of [DOCUSIGN_EXPIRED, DOCUSIGN_NOT_CONNECTED]) {
      docusignEnvelopeStatus.mockRejectedValueOnce(new Error(message));
      await expect(send()).rejects.toThrow(message);
      expect(row().docusignEnvelopeId).toBe("env-1");
    }
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
    // The rep is told; nothing to alert anyone about.
    expect(reportError).not.toHaveBeenCalled();
  });

  it("sends a SealMe link with DocuSign disconnected, letting go of the old envelope and reporting it", async () => {
    docusignEnvelopeStatus.mockRejectedValue(new Error(DOCUSIGN_EXPIRED));

    expect(await send(bySealme())).toEqual({ status: "sent" });
    expect(prisma.contract.updateMany).toHaveBeenCalledWith(letGo);
    expect(prisma.contract.updateMany.mock.invocationCallOrder[0]).toBeLessThan(sendContractEmail.mock.invocationCallOrder[0]);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: DOCUSIGN_EXPIRED }), expect.stringContaining("SealMe link"), { dealId: "d1", contractId: "k1" });
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
    expect(sentRound()).toMatchObject({ status: "sent", docusignEnvelopeId: null });
  });

  it("goes on without a word about an old envelope declined two rounds back", async () => {
    // Declined on DocuSign, sent again by SealMe link, which expired; now by
    // DocuSign again. The team heard about the decline back then.
    docusignEnvelopeStatus.mockResolvedValue({ status: "declined", signers: [{ name: "Priya Shah", email: "client@x.test", routingOrder: "1", status: "declined", declinedReason: "Fee is wrong" }] });

    expect(await send(earlier({ status: "expired" }))).toEqual({ status: "sent" });
    expect(dispatchWebhookEvent).not.toHaveBeenCalledWith("w1", "contract.declined", expect.anything());
    expect(sendChangesRequestedEmail).not.toHaveBeenCalled();
    expect(prisma.contract.updateMany).toHaveBeenCalledWith(letGo);
    expect(prisma.contract.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: expect.anything() }) }));
    expect(voidDocusignEnvelope).not.toHaveBeenCalled();
    expect(sentRound()).toMatchObject({ status: "sent", docusignEnvelopeId: "env-2" });
  });

  it("asks DocuSign once and goes on when the old envelope was already voided", async () => {
    expect(await send()).toEqual({ status: "sent" });
    expect(docusignEnvelopeStatus).toHaveBeenCalledTimes(1);
    expect(voidDocusignEnvelope).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("doesn't ask DocuSign on a first send", async () => {
    expect(await send(earlier({ status: "draft", docusignEnvelopeId: null, sentAt: null }))).toEqual({ status: "sent" });
    expect(docusignEnvelopeStatus).not.toHaveBeenCalled();
    expect(voidDocusignEnvelope).not.toHaveBeenCalled();
    expect(sentRound()).toMatchObject({ docusignEnvelopeId: "env-2" });
  });

  describe("with the Send page's setup", () => {
    const setup: SendSetup = { deliveryMethod: "docusign", ccEmails: ["ops@x.test"], countersigners: [{ name: "Legal", email: "legal@x.test", role: "Legal" }] };

    it("sends with it once the old envelope is dealt with, and stores it with the send", async () => {
      docusignEnvelopeStatus.mockResolvedValue(stillOut);

      expect(await send(bySealme(), setup)).toEqual({ status: "sent" });
      // It goes by this send's delivery (DocuSign), not the one stored.
      expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
      expect(sendDocusignEnvelope.mock.calls[0][1].signers.map((s: { email: string }) => s.email)).toEqual([PENDING.to, "legal@x.test"]);
      expect(sendContractEmail).not.toHaveBeenCalled();
      // One write records the send and its setup.
      expect(prisma.contract.update).toHaveBeenCalledTimes(1);
      expect(sentRound()).toMatchObject({ deliveryMethod: "docusign", ccEmails: JSON.stringify(["ops@x.test"]), docusignEnvelopeId: "env-2" });
      expect(prisma.contractSigner.deleteMany).toHaveBeenCalledWith({ where: { contractId: "k1" } });
      expect(prisma.contractSigner.createMany.mock.calls[0][0].data).toMatchObject([{ contractId: "k1", name: "Legal", email: "legal@x.test", role: "Legal", order: 1 }]);
      expect(voidDocusignEnvelope.mock.invocationCallOrder[0]).toBeLessThan(sendDocusignEnvelope.mock.invocationCallOrder[0]);
      expect(sendDocusignEnvelope.mock.invocationCallOrder[0]).toBeLessThan(prisma.contract.update.mock.invocationCallOrder[0]);
      expect(sendDocusignEnvelope.mock.invocationCallOrder[0]).toBeLessThan(prisma.contractSigner.deleteMany.mock.invocationCallOrder[0]);
    });

    it("leaves the contract as it went out last time when the send is refused", async () => {
      voidDocusignEnvelope.mockRejectedValue(new Error("DocuSign envelope void failed: 503"));
      docusignEnvelopeStatus.mockResolvedValueOnce(stillOut).mockResolvedValueOnce(stillOut);
      await expect(send(bySealme(), setup)).rejects.toThrow("Couldn't cancel");

      // Signed on the old envelope: finalized against the signers it really
      // had, before anything of this send's setup is saved.
      docusignEnvelopeStatus.mockResolvedValueOnce(completed);
      await expect(send(bySealme(), setup)).rejects.toThrow("already signed this in DocuSign");
      expect(finalizeContractSigned).toHaveBeenCalledWith("k1");

      expect(prisma.contract.update).not.toHaveBeenCalled();
      expect(prisma.contractSigner.deleteMany).not.toHaveBeenCalled();
      expect(prisma.contractSigner.createMany).not.toHaveBeenCalled();
      expect(row().deliveryMethod).toBe("sealme");
    });

    it("stores it as a review starts holding the send, for the last approval to send with", async () => {
      withChain();
      expect(await send(earlier(), setup)).toEqual({ status: "pending_approval", assigneeName: "Lee" });
      // The review let go of the hold in the same write.
      expect(row()).toMatchObject({ deliveryMethod: "docusign", ccEmails: JSON.stringify(["ops@x.test"]), status: "pending_approval", reminderSentAt: null });
      expect(row().signers).toMatchObject([{ name: "Legal", email: "legal@x.test", order: 1 }]);
      expect(prisma.contractSigner.createMany).toHaveBeenCalledTimes(1);
    });

    it("stores nothing and lets go of the hold when the send fails, and the next try goes out", async () => {
      // A reminder went out in the round before, and Ana signed it as counter-signer.
      const reminded = new Date("2026-10-20T09:00:00Z");
      const before = bySealme();
      const c = { ...before, docusignEnvelopeId: null, reminderSentAt: reminded, ccEmails: JSON.stringify(["old@x.test"]), signers: [{ id: "s1", name: "Ana", email: "ana@x.test", status: "signed", notifiedAt: new Date() }] };
      sendDocusignEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope creation failed: 500"));

      await expect(send(c, setup)).rejects.toThrow("DocuSign envelope creation failed: 500");
      expect(row()).toMatchObject({ status: "not_signed", deliveryMethod: "sealme", ccEmails: JSON.stringify(["old@x.test"]), reminderSentAt: reminded });
      expect(row().signers).toMatchObject([{ id: "s1", name: "Ana", status: "signed" }]);
      expect(prisma.contract.update).not.toHaveBeenCalled();
      expect(prisma.contractSigner.deleteMany).not.toHaveBeenCalled();
      expect(prisma.contractSigner.createMany).not.toHaveBeenCalled();

      prisma.deal.findUnique.mockResolvedValue(dealRow(row()));
      expect(await requestOrSendReview("d1", PENDING, ana.email, setup)).toEqual({ status: "sent" });
      expect(row()).toMatchObject({ status: "sent", deliveryMethod: "docusign", ccEmails: JSON.stringify(["ops@x.test"]), docusignEnvelopeId: "env-2", reminderSentAt: null });
      expect(row().signers).toMatchObject([{ name: "Legal", email: "legal@x.test", status: "pending" }]);
    });

    it("starts no review and stores nothing when starting it fails, and the next try starts it", async () => {
      withChain();
      prisma.reviewStep.create.mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
      const c = { ...bySealme(), docusignEnvelopeId: null };

      await expect(send(c, setup)).rejects.toThrow("Couldn't start the review. Try again");
      expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "Connection terminated unexpectedly" }), "Start a review", { dealId: "d1" });
      expect(row()).toMatchObject({ status: "not_signed", deliveryMethod: "sealme", reminderSentAt: null });
      expect(prisma.contract.update).not.toHaveBeenCalled();
      expect(prisma.contractSigner.deleteMany).not.toHaveBeenCalled();
      expect(refreshLeadPipeline).not.toHaveBeenCalled();

      prisma.deal.findUnique.mockResolvedValue(dealRow(row()));
      expect(await requestOrSendReview("d1", PENDING, ana.email, setup)).toEqual({ status: "pending_approval", assigneeName: "Lee" });
      expect(row()).toMatchObject({ status: "pending_approval", deliveryMethod: "docusign", reminderSentAt: null });
    });
  });
});

describe("Sending again by DocuSign once a SealMe link ran out", () => {
  // Sent by SealMe link on Nov 1. The link ran out an hour ago and the daily
  // cron hasn't marked it expired yet, so it still reads "sent".
  const lapsed = () => {
    const base = contract({ status: "sent", deliveryMethod: "sealme", expiresAt: new Date(Date.now() - 3_600_000), sentAt: new Date("2026-11-01T09:00:00Z") });
    return { ...base, deal: { ...base.deal, leadId: "lead1" } };
  };
  const setup: SendSetup = { deliveryMethod: "docusign", ccEmails: ["ops@x.test"], countersigners: [{ name: "Legal", email: "legal@x.test", role: "Legal" }] };
  let row: () => Row;
  const send = () => {
    const c = lapsed();
    prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", kind: "contract", leadId: "lead1", teamId: null, feeDisplay: "$5,000", fields: [FEE], contract: c });
    row = databaseRow(c);
    return requestOrSendReview("d1", PENDING, ana.email, setup);
  };
  const envelopeSigners = () => sendDocusignEnvelope.mock.calls[0][1].signers.map((s: { name: string; email: string; routingOrder: number }) => [s.name, s.email, s.routingOrder]);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewChain.findMany.mockResolvedValue([]);
    sendDocusignEnvelope.mockResolvedValue("env-2");
  });

  it("goes out as a DocuSign envelope", async () => {
    expect(await send()).toEqual({ status: "sent" });
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
    expect(envelopeSigners()).toEqual([["Priya Shah", PENDING.to, 1], ["Legal", "legal@x.test", 2]]);
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "sent", deliveryMethod: "docusign", docusignEnvelopeId: "env-2", ccEmails: JSON.stringify(["ops@x.test"]), reminderSentAt: null });
    expect(row().signers).toMatchObject([{ name: "Legal", email: "legal@x.test", order: 1, status: "pending" }]);
    // Nothing went out by DocuSign before: nothing to ask it about.
    expect(docusignEnvelopeStatus).not.toHaveBeenCalled();
  });

  it("starts the review, and the last approval sends it by DocuSign", async () => {
    prisma.reviewChain.findMany.mockResolvedValue([{ name: "Legal", teamId: null, minDealValue: null, steps: [{ assigneeId: "u9", order: 1 }] }]);
    prisma.reviewStep.create.mockResolvedValue({ id: "rs1", order: 1 });
    prisma.user.findUnique.mockResolvedValue({ name: "Lee" });

    expect(await send()).toEqual({ status: "pending_approval", assigneeName: "Lee" });
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "pending_approval", deliveryMethod: "docusign", ccEmails: JSON.stringify(["ops@x.test"]), pendingTo: PENDING.to, reminderSentAt: null });

    await performActualSend("k1");
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
    expect(envelopeSigners()).toEqual([["Priya Shah", PENDING.to, 1], ["Legal", "legal@x.test", 2]]);
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "sent", deliveryMethod: "docusign", docusignEnvelopeId: "env-2", pendingTo: null });
  });
});

describe("Sending once per round", () => {
  // Ready to go out by DocuSign, read by two sends at the same moment: two
  // clicks, two tabs, or two approvers approving the last step together.
  const ready = (overrides: Record<string, unknown> = {}) => contract({ status: "pending_approval", deliveryMethod: "docusign", pendingTo: PENDING.to, pendingSubject: PENDING.subject, pendingMessage: PENDING.message, ...overrides });

  beforeEach(() => {
    vi.clearAllMocks();
    sendDocusignEnvelope.mockResolvedValue("env-2");
    sendContractEmail.mockResolvedValue(undefined);
    voidDocusignEnvelope.mockResolvedValue(undefined);
  });

  it("creates one envelope when two sends run at once", async () => {
    const row = databaseRow(ready());
    const results = await Promise.allSettled([performActualSend("k1"), performActualSend("k1")]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: "This contract is already being sent" }) });
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "sent", docusignEnvelopeId: "env-2", reminderSentAt: null });
  });

  it("sends once when the rep clicks Send twice", async () => {
    prisma.reviewChain.findMany.mockResolvedValue([]);
    const draft = ready({ status: "draft", pendingTo: null, pendingSubject: null, pendingMessage: null });
    prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", kind: "contract", leadId: null, teamId: null, feeDisplay: "$5,000", fields: [FEE], contract: draft });
    databaseRow(draft);

    const results = await Promise.allSettled([requestOrSendReview("d1", PENDING, ana.email), requestOrSendReview("d1", PENDING, ana.email)]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
    // A first send: nothing to ask DocuSign about.
    expect(docusignEnvelopeStatus).not.toHaveBeenCalled();
  });

  it("holds over the status, the mark and the send date it read, right before anything goes out", async () => {
    const sentAt = new Date("2026-11-01T09:00:00Z");
    databaseRow(ready({ sentAt }));
    const before = Date.now();
    await performActualSend("k1");
    const hold = prisma.contract.updateMany.mock.calls[0][0];
    expect(hold).toEqual({ where: { id: "k1", status: "pending_approval", reminderSentAt: null, sentAt }, data: { reminderSentAt: expect.any(Date) } });
    // The mark is when the hold runs out, so it's ahead of now, where a real reminder never is.
    expect(hold.data.reminderSentAt.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(prisma.contract.updateMany.mock.invocationCallOrder[0]).toBeLessThan(renderToBuffer.mock.invocationCallOrder[0]);
  });

  it("turns away a send that starts while another is still out", async () => {
    // Another send holds it for 4 more minutes and hasn't come back yet.
    databaseRow(ready({ reminderSentAt: new Date(Date.now() + 4 * 60_000) }));
    await expect(performActualSend("k1")).rejects.toThrow("This contract is already being sent");
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });

  it("lets the rep try again when a send failed", async () => {
    const row = databaseRow(ready());
    sendDocusignEnvelope.mockRejectedValueOnce(new Error("DocuSign envelope creation failed: 500"));

    await expect(performActualSend("k1")).rejects.toThrow("DocuSign envelope creation failed: 500");
    // Nothing went out, so the mark is undone.
    expect(row()).toMatchObject({ status: "pending_approval", reminderSentAt: null });

    await performActualSend("k1");
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(2);
    expect(row()).toMatchObject({ status: "sent", docusignEnvelopeId: "env-2" });
  });

  it("puts back a real reminder time when a send failed", async () => {
    const reminded = new Date("2026-10-20T09:00:00Z");
    const row = databaseRow(ready({ status: "not_signed", deliveryMethod: "sealme", reminderSentAt: reminded }));
    sendContractEmail.mockRejectedValueOnce(new Error("Resend is down"));
    await expect(performActualSend("k1", PENDING)).rejects.toThrow("Resend is down");
    expect(row().reminderSentAt).toEqual(reminded);
  });

  it("isn't blocked for good by a send that never came back", async () => {
    // Its server stopped mid-send 6 minutes ago, so its hold ran out a minute ago.
    const row = databaseRow(ready({ reminderSentAt: new Date(Date.now() - 60_000) }));
    await performActualSend("k1");
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "sent", reminderSentAt: null });
  });

  it("isn't held up by a reminder that went out a minute ago", async () => {
    // The client was nudged a minute ago; then the rep marked it not signed and sends a new version.
    const row = databaseRow(ready({ status: "not_signed", deliveryMethod: "sealme", reminderSentAt: new Date(Date.now() - 60_000) }));
    await performActualSend("k1", PENDING);
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "sent", reminderSentAt: null });
  });

  it("turns away a send that read the contract before another one went out", async () => {
    // The SealMe link ran out and no reminder went out (they're off by default).
    const lapsed = contract({ status: "sent", deliveryMethod: "sealme", expiresAt: new Date(Date.now() - 3_600_000), sentAt: new Date("2026-11-01T09:00:00Z") });
    const row = databaseRow(lapsed);
    const readEarlier = { ...row() };
    // A second send would create env-3.
    sendDocusignEnvelope.mockResolvedValueOnce("env-2").mockResolvedValue("env-3");

    await performActualSend("k1", PENDING, ana.email, { deliveryMethod: "docusign" });
    // It went out, leaving the status and the mark where they were before.
    expect(row()).toMatchObject({ status: "sent", reminderSentAt: null, deliveryMethod: "docusign", docusignEnvelopeId: "env-2" });

    // The other send read the contract before that, and only now gets to hold it.
    prisma.contract.findUnique.mockResolvedValueOnce(readEarlier);
    await expect(performActualSend("k1", PENDING, ana.email, { deliveryMethod: "docusign" })).rejects.toThrow("This contract is already being sent");
    expect(sendDocusignEnvelope).toHaveBeenCalledTimes(1);
    expect(row()).toMatchObject({ status: "sent", docusignEnvelopeId: "env-2" });
  });

  it("lets one of two sends with different setups go out, and the other changes nothing", async () => {
    prisma.reviewChain.findMany.mockResolvedValue([]);
    // A by DocuSign with Legal counter-signing, B by SealMe link with no one, or the other way round.
    const byDocusign: SendSetup = { deliveryMethod: "docusign", ccEmails: ["ops@x.test"], countersigners: [{ name: "Legal", email: "legal@x.test", role: "Legal" }] };
    const bySealme: SendSetup = { deliveryMethod: "sealme", ccEmails: [], countersigners: [] };
    for (const [first, second] of [[byDocusign, bySealme], [bySealme, byDocusign]]) {
      vi.clearAllMocks();
      const unsigned = ready({ status: "not_signed", deliveryMethod: "sealme", pendingTo: null, pendingSubject: null, pendingMessage: null, sentAt: new Date("2026-11-01T09:00:00Z") });
      prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", kind: "contract", leadId: null, teamId: null, feeDisplay: "$5,000", fields: [FEE], contract: unsigned });
      const row = databaseRow(unsigned);

      const results = await Promise.allSettled([requestOrSendReview("d1", PENDING, ana.email, first), requestOrSendReview("d1", PENDING, ana.email, second)]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.objectContaining({ message: "This contract is already being sent" }) });
      const winner = results[0].status === "fulfilled" ? first : second;

      expect(sendDocusignEnvelope.mock.calls.length + sendContractEmail.mock.calls.length).toBe(1);
      expect(row()).toMatchObject({
        status: "sent",
        deliveryMethod: winner.deliveryMethod,
        ccEmails: winner === byDocusign ? JSON.stringify(["ops@x.test"]) : null,
        docusignEnvelopeId: winner === byDocusign ? "env-2" : null,
        reminderSentAt: null,
      });
      expect(row().signers).toEqual((winner.countersigners ?? []).map((s) => expect.objectContaining({ name: s.name, email: s.email })));
      // The send that lost wrote nothing: one write of the send, one signer list.
      expect(prisma.contract.update).toHaveBeenCalledTimes(1);
      expect(prisma.contractSigner.deleteMany).toHaveBeenCalledTimes(1);
    }
  });

  it("never sends straight out past a review someone started meanwhile", async () => {
    // Read by a Send that found it not signed, then a review started before the send got to it.
    const row = databaseRow(ready({ deliveryMethod: "sealme" }));
    await expect(performActualSend("k1", PENDING, ana.email)).rejects.toThrow("This contract is already waiting on review");
    expect(sendContractEmail).not.toHaveBeenCalled();
    expect(row()).toMatchObject({ status: "pending_approval", reminderSentAt: null });
  });

  it("sends from a review's last approval only while it's still in review", async () => {
    databaseRow(ready({ status: "sent", docusignEnvelopeId: "env-2" }));
    await expect(performActualSend("k1")).rejects.toThrow("This contract isn't waiting on review anymore");
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
  });

  it("sends a SealMe link once too", async () => {
    databaseRow(ready({ deliveryMethod: "sealme" }));
    const results = await Promise.allSettled([performActualSend("k1"), performActualSend("k1")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
  });

  it("never holds a proposal", async () => {
    const proposal = contract({ status: "sent" });
    prisma.contract.findUnique.mockResolvedValue({ ...proposal, deal: { ...proposal.deal, kind: "proposal", leadId: null } });
    await performActualSend("k1", PENDING);
    expect(prisma.contract.updateMany).not.toHaveBeenCalled();
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
  });

  it("deals with an envelope left on a contract from a review that started before the check", async () => {
    databaseRow(ready({ docusignEnvelopeId: "env-1" }));
    docusignEnvelopeStatus.mockResolvedValue({ status: "delivered", signers: [] });

    await performActualSend("k1");
    expect(voidDocusignEnvelope).toHaveBeenCalledWith("w1", "env-1", "Replaced by a new version of the contract");
    expect(voidDocusignEnvelope.mock.invocationCallOrder[0]).toBeLessThan(sendDocusignEnvelope.mock.invocationCallOrder[0]);
    expect(prisma.contract.update.mock.calls[0][0].data).toMatchObject({ status: "sent", docusignEnvelopeId: "env-2" });
  });

  it("finalizes instead when the client signed that envelope during the review", async () => {
    const row = databaseRow(ready({ docusignEnvelopeId: "env-1" }));
    prisma.contractSigner.findMany.mockResolvedValue([]);
    docusignEnvelopeStatus.mockResolvedValue({ status: "completed", signers: [{ name: "Priya Shah", email: "client@x.test", routingOrder: "1", status: "completed" }] });

    await expect(performActualSend("k1")).rejects.toThrow("already signed this in DocuSign");
    // The contract's text in review is still the round that envelope carried.
    expect(finalizeContractSigned).toHaveBeenCalledWith("k1");
    expect(row()).toMatchObject({ status: "partially_signed", docusignEnvelopeId: "env-1" });
    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
  });
});

describe("Sending a proposal", () => {
  const proposal = (overrides: Record<string, unknown> = {}) => {
    const base = contract(overrides);
    // A workspace whose contracts expire still never expires a proposal.
    return { ...base, deal: { ...base.deal, kind: "proposal", leadId: "lead1", workspace: { ...base.deal.workspace, signingExpiryDays: 14 } } };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewChain.findMany.mockResolvedValue([]);
    prisma.contract.update.mockResolvedValue({});
  });

  it("emails a link to read it, with no portal link", async () => {
    prisma.contract.findUnique.mockResolvedValue(proposal());
    await performActualSend("k1", PENDING, ana.email);

    const email = sendContractEmail.mock.calls[0][0];
    expect(email.signLink).toMatch(/\/proposal\/k1$/);
    expect(email.signLink).not.toContain("/sign/");
    expect(email.actionLabel).toBe("View the proposal");
    expect(email.portalUrl).toBeUndefined();
    expect(getOrMintPortalToken).not.toHaveBeenCalled();
  });

  it("marks it sent with no expiry, a fresh view and no signature, and moves the lead", async () => {
    prisma.contract.findUnique.mockResolvedValue(proposal({ status: "changes_requested", signers: [{ id: "s1", status: "signed", notifiedAt: new Date() }] }));
    await performActualSend("k1", PENDING);

    const data = prisma.contract.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "sent", expiresAt: null, viewedAt: null, deliveryMethod: "sealme", signedAt: null, signerName: null, signatureImage: null, pendingTo: null });
    expect(data.sentAt).toBeInstanceOf(Date);
    expect(data.snapshot).toMatchObject({ templateName: "Retainer", clauses: [{ title: "Fees", body: "The fee is $5,000 / month." }] });
    expect(prisma.contractSigner.update).not.toHaveBeenCalled();
    expect(prisma.deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "sent" } });
    expect(refreshLeadPipeline).toHaveBeenCalledWith("lead1", { sentNow: true });
    expect(prisma.clauseComment.updateMany).toHaveBeenCalledWith({ where: { contractId: "k1", resolved: false }, data: { resolved: true } });
  });

  it("never goes through DocuSign and isn't announced", async () => {
    prisma.contract.findUnique.mockResolvedValue(proposal({ deliveryMethod: "docusign" }));
    await performActualSend("k1", PENDING);

    expect(sendDocusignEnvelope).not.toHaveBeenCalled();
    expect(renderToBuffer).not.toHaveBeenCalled();
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
    expect(prisma.contract.update.mock.calls[0][0].data.deliveryMethod).toBe("sealme");
    expect(dispatchWebhookEvent).not.toHaveBeenCalled();
    expect(notifySlack).not.toHaveBeenCalled();
    expect(syncDealToHubspot).not.toHaveBeenCalled();
    expect(syncDealToSalesforce).not.toHaveBeenCalled();
  });

  it("skips the review chain a contract would wait on", async () => {
    prisma.reviewChain.findMany.mockResolvedValue([{ name: "Legal", teamId: null, minDealValue: null, steps: [{ assigneeId: "u9", order: 1 }] }]);
    prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", kind: "proposal", teamId: null, feeDisplay: "$5,000", fields: [FEE], contract: proposal({ expiresAt: null }) });
    prisma.contract.findUnique.mockResolvedValue(proposal());

    expect(await requestOrSendReview("d1", PENDING)).toEqual({ status: "sent" });
    expect(prisma.reviewStep.create).not.toHaveBeenCalled();
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.sent" }));
  });

  it("goes out again after it was sent, the way a contract can't", async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", kind: "proposal", teamId: null, feeDisplay: "$5,000", fields: [FEE], contract: proposal({ status: "sent", expiresAt: null }) });
    prisma.contract.findUnique.mockResolvedValue(proposal({ status: "sent", expiresAt: null }));

    expect(await requestOrSendReview("d1", PENDING)).toEqual({ status: "sent" });
    expect(sendContractEmail).toHaveBeenCalledTimes(1);
    expect(prisma.contract.update.mock.calls[0][0].data).toMatchObject({ status: "sent", viewedAt: null });
    expect(canSendDocument({ status: "sent", deliveryMethod: "sealme", expiresAt: null }, "proposal")).toBe(true);
    expect(canSendDocument({ status: "sent", deliveryMethod: "sealme", expiresAt: null }, "contract")).toBe(false);
    expect(canSendDocument({ status: "pending_approval", deliveryMethod: "sealme", expiresAt: null }, "proposal")).toBe(false);
  });

  it("names the proposal when a term is still blank", async () => {
    prisma.deal.findUnique.mockResolvedValue({ id: "d1", workspaceId: "w1", kind: "proposal", fields: [{ ...FEE, value: null }], contract: proposal({ expiresAt: null }) });
    await expect(requestOrSendReview("d1", PENDING)).rejects.toThrow("Fill in Fee before sending. The proposal still has blanks");
    expect(sendContractEmail).not.toHaveBeenCalled();
  });
});

describe("Sending a contract still announces it", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.contract.updateMany.mockResolvedValue({ count: 1 });
    prisma.contract.update.mockResolvedValue({});
  });

  it("fires the webhook, Slack and the CRM, with the sign link and the portal", async () => {
    prisma.contract.findUnique.mockResolvedValue(contract());
    await performActualSend("k1", PENDING);
    expect(sendContractEmail.mock.calls[0][0].portalUrl).toMatch(/\/portal\/portal$/);
    expect(sendContractEmail.mock.calls[0][0].signLink).toMatch(/\/sign\/k1$/);
    expect(sendContractEmail.mock.calls[0][0].actionLabel).toBeUndefined();
    expect(dispatchWebhookEvent).toHaveBeenCalledWith("w1", "contract.sent", expect.anything());
    expect(notifySlack).toHaveBeenCalledTimes(1);
    expect(syncDealToHubspot).toHaveBeenCalledTimes(1);
  });
});
