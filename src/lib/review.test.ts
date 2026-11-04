import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, sendContractEmail } = vi.hoisted(() => ({
  prisma: {
    deal: { findUnique: vi.fn(), update: vi.fn() },
    contract: { findUnique: vi.fn(), update: vi.fn() },
    contractSigner: { update: vi.fn() },
    clauseComment: { updateMany: vi.fn() },
    reviewChain: { findMany: vi.fn() },
  },
  sendContractEmail: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/email", () => ({ sendContractEmail, sendReviewAssignedEmail: vi.fn(), sendChangesRequestedEmail: vi.fn() }));
vi.mock("@react-pdf/renderer", () => ({ renderToBuffer: vi.fn() }));
vi.mock("@/lib/contract-pdf", () => ({ ContractPdfDocument: () => null }));
vi.mock("@/lib/docusign", () => ({ sendDocusignEnvelope: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/client-portal", () => ({ getOrMintPortalToken: async () => "portal" }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock("@/lib/slack", () => ({ notifySlack: vi.fn() }));
vi.mock("@/lib/hubspot", () => ({ syncDealToHubspot: vi.fn() }));
vi.mock("@/lib/salesforce", () => ({ syncDealToSalesforce: vi.fn() }));

import { canSendContract, performActualSend, requestOrSendReview } from "./review";

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
    ccEmails: null,
    pendingTo: null,
    pendingSubject: null,
    pendingMessage: null,
    template: { name: "Retainer", clauses: CLAUSES },
    signers: [],
    deal: {
      id: "d1",
      client: { id: "c1", name: "Priya Shah" },
      owner,
      fields: [FEE],
      workspace: { id: "w1", name: "Agency", users: [ana, owner, admin], senderDomainStatus: null, signingExpiryDays: null },
    },
    ...overrides,
  };
}

describe("When a contract can be sent", () => {
  it("only as a draft, after changes were asked for, or once it expired", () => {
    const at = (status: string, deliveryMethod = "sealme", expiresAt: Date | null = null) => canSendContract({ status, deliveryMethod, expiresAt });
    for (const status of ["draft", "changes_requested", "expired"]) expect(at(status)).toBe(true);
    for (const status of ["pending_approval", "sent", "partially_signed", "signed"]) expect(at(status)).toBe(false);
    expect(at("sent", "sealme", new Date(Date.now() - 1000))).toBe(true);
    expect(at("sent", "docusign", new Date(Date.now() - 1000))).toBe(false);
  });
});

describe("Sending a contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.reviewChain.findMany.mockResolvedValue([]);
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
