import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, requestOrSendReview } = vi.hoisted(() => ({
  prisma: {
    deal: { findFirst: vi.fn(), update: vi.fn() },
    dealField: { update: vi.fn(), count: vi.fn() },
    dealFieldChange: { create: vi.fn() },
    client: { update: vi.fn() },
    contract: { update: vi.fn() },
    contractSigner: { deleteMany: vi.fn(), createMany: vi.fn() },
  },
  requestOrSendReview: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: {}, userId: "u1" }) }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "ana@agency.test" } }) }));
vi.mock("@/lib/webhooks", () => ({ dispatchDealCreated: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/extract-deal", () => ({}));
// The real canSendContract, with sending itself stubbed out.
vi.mock("@react-pdf/renderer", () => ({}));
vi.mock("@/lib/contract-pdf", () => ({}));
vi.mock("@/lib/docusign", () => ({}));
vi.mock("@/lib/email", () => ({}));
vi.mock("@/lib/notifications", () => ({}));
vi.mock("@/lib/client-portal", () => ({}));
vi.mock("@/lib/slack", () => ({}));
vi.mock("@/lib/hubspot", () => ({}));
vi.mock("@/lib/salesforce", () => ({}));
vi.mock("@/lib/review", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/review")>()), requestOrSendReview }));

import { applyVoiceFieldCorrection, sendContractEmail, sendViaDocusignNow, updateFieldValues } from "./actions";

function form(entries: [string, string][]) {
  const fd = new FormData();
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

describe("Editing deal terms", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves a term the call missed and makes a cleared one missing again", async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: "d1",
      clientId: "c1",
      status: "ready",
      contract: { status: "draft" },
      fields: [
        { id: "f1", fieldKey: "fee", value: null, status: "missing" },
        { id: "f2", fieldKey: "paymentTerms", value: "Net 30", status: "extracted" },
      ],
    });
    prisma.dealField.count.mockResolvedValue(1);

    await expect(updateFieldValues("d1", form([["f1", "$4,000"], ["f2", ""]]))).rejects.toThrow("redirect /deals/d1");

    expect(prisma.dealField.update).toHaveBeenCalledWith({ where: { id: "f1" }, data: { value: "$4,000", status: "confirmed" } });
    expect(prisma.dealField.update).toHaveBeenCalledWith({ where: { id: "f2" }, data: { value: null, status: "missing" } });
    expect(prisma.deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "missing_info" } });
  });

  it("refuses once the contract is with a reviewer or the client", async () => {
    for (const status of ["pending_approval", "sent", "partially_signed", "signed"]) {
      prisma.deal.findFirst.mockResolvedValue({ id: "d1", clientId: "c1", status: "sent", contract: { status }, fields: [{ id: "f1", fieldKey: "fee", value: "$5,000", status: "extracted" }] });
      await expect(updateFieldValues("d1", form([["f1", "$8,000"]]))).rejects.toThrow("can't change");
    }
    expect(prisma.dealField.update).not.toHaveBeenCalled();
  });

  it("allows them again once the sign link expired, so the rep can send a new version", async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: "d1",
      clientId: "c1",
      status: "sent",
      contract: { status: "sent", deliveryMethod: "sealme", expiresAt: new Date(Date.now() - 1000) },
      fields: [{ id: "f1", fieldKey: "fee", value: "$5,000", status: "extracted" }],
    });
    prisma.dealField.count.mockResolvedValue(0);

    await expect(updateFieldValues("d1", form([["f1", "$6,000"]]))).rejects.toThrow("redirect /deals/d1");
    expect(prisma.dealField.update).toHaveBeenCalledWith({ where: { id: "f1" }, data: { value: "$6,000", status: "user_edited" } });
  });
});

describe("Voice corrections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("says why a correction is refused instead of throwing", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "d1", clientId: "c1", status: "pending_approval", contract: { status: "pending_approval" }, fields: [{ id: "f1", fieldKey: "fee", value: "$5,000", status: "extracted" }] });
    expect(await applyVoiceFieldCorrection("d1", "fee", "$8,000")).toEqual({ error: expect.stringContaining("can't change") });
    expect(prisma.dealField.update).not.toHaveBeenCalled();
  });

  it("applies one on a draft", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "d1", clientId: "c1", status: "ready", contract: { status: "draft" }, fields: [{ id: "f1", fieldKey: "fee", value: "$5,000", status: "extracted" }] });
    prisma.dealField.count.mockResolvedValue(0);
    expect(await applyVoiceFieldCorrection("d1", "fee", "$8,000")).toEqual({});
    expect(prisma.dealField.update).toHaveBeenCalledWith({ where: { id: "f1" }, data: { value: "$8,000", status: "user_edited" } });
  });
});

describe("Sending from the Send page", () => {
  beforeEach(() => vi.clearAllMocks());

  const sendForm = (signers: [string, string][] = []) =>
    form([["to", "client@x.test"], ["subject", "Agreement"], ["message", "Hi"], ...signers]);

  it("won't send a contract that already went out", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "d1", contract: { id: "k1", status: "signed", deliveryMethod: "sealme", expiresAt: null } });
    expect(await sendContractEmail("d1", sendForm())).toEqual({ status: "error", error: "This contract was already sent" });
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(requestOrSendReview).not.toHaveBeenCalled();
  });

  it("replaces every earlier signer, including one who declined", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "d1", contract: { id: "k1", status: "changes_requested", deliveryMethod: "sealme", expiresAt: null } });
    requestOrSendReview.mockResolvedValue({ status: "sent" });

    const result = await sendContractEmail("d1", sendForm([["signerName", "Legal"], ["signerEmail", "legal@x.test"], ["signerRole", "Legal"]]));

    expect(result).toEqual({ status: "sent" });
    expect(prisma.contractSigner.deleteMany).toHaveBeenCalledWith({ where: { contractId: "k1" } });
    expect(prisma.contractSigner.createMany.mock.calls[0][0].data).toMatchObject([{ name: "Legal", email: "legal@x.test", order: 1 }]);
  });

  it("takes every signer off when the rep removed them all", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "d1", contract: { id: "k1", status: "changes_requested", deliveryMethod: "sealme", expiresAt: null } });
    requestOrSendReview.mockResolvedValue({ status: "sent" });

    expect(await sendContractEmail("d1", sendForm())).toEqual({ status: "sent" });
    expect(prisma.contractSigner.deleteMany).toHaveBeenCalledWith({ where: { contractId: "k1" } });
    expect(prisma.contractSigner.createMany).not.toHaveBeenCalled();
  });

  it("won't drop a signer whose row is half filled in", async () => {
    prisma.deal.findFirst.mockResolvedValue({ id: "d1", contract: { id: "k1", status: "draft", deliveryMethod: "sealme", expiresAt: null } });

    const result = await sendContractEmail("d1", sendForm([["signerName", "Legal"], ["signerEmail", ""], ["signerRole", "Legal"]]));

    expect(result).toEqual({ status: "error", error: expect.stringContaining("name and an email") });
    expect(prisma.contractSigner.deleteMany).not.toHaveBeenCalled();
    expect(requestOrSendReview).not.toHaveBeenCalled();
  });
});

describe("Send via DocuSign now", () => {
  beforeEach(() => vi.clearAllMocks());

  it("says when a review chain held it instead of sending", async () => {
    prisma.deal.findFirst.mockResolvedValue({
      id: "d1",
      client: { name: "Priya Shah", email: "priya@x.test" },
      template: { name: "Retainer" },
      contract: { id: "k1", status: "draft" },
      workspace: { name: "Agency", docusignEnabled: true },
    });
    requestOrSendReview.mockResolvedValue({ status: "pending_approval", assigneeName: "Maria" });
    expect(await sendViaDocusignNow("d1")).toEqual({ heldForReviewBy: "Maria" });
  });
});
