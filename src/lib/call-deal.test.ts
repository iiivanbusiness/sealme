import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, createDealFromTranscriptText, finishTranscriptDealInBackground, createNotification, sendContractReadyEmail, requestOrSendReview } = vi.hoisted(() => ({
  prisma: {
    phoneCall: { findUniqueOrThrow: vi.fn(), update: vi.fn() },
    lead: { update: vi.fn() },
    user: { findFirst: vi.fn() },
    contractTemplate: { findMany: vi.fn() },
    client: { findFirst: vi.fn() },
    contract: { upsert: vi.fn() },
    $transaction: vi.fn(),
  },
  createDealFromTranscriptText: vi.fn(),
  finishTranscriptDealInBackground: vi.fn(),
  createNotification: vi.fn(),
  sendContractReadyEmail: vi.fn(),
  requestOrSendReview: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/transcript-deal", () => ({ createDealFromTranscriptText, finishTranscriptDealInBackground }));
vi.mock("@/lib/notifications", () => ({ createNotification }));
vi.mock("@/lib/email", () => ({ sendContractReadyEmail }));
// Where a rep's Send goes: nothing made from a call gets there on its own.
vi.mock("@/lib/review", () => ({ requestOrSendReview }));
vi.mock("@/lib/webhooks", () => ({}));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));

import { buildDealFromCall, suggestTemplateId } from "./call-deal";

const templates = [
  { id: "a", name: "Social Media Retainer", description: "Monthly content" },
  { id: "b", name: "Website Build", description: "One-off project" },
];

describe("Template for a sales call", () => {
  it("doesn't ask the model when there's only one template", async () => {
    expect(await suggestTemplateId("anything", [templates[0]])).toBe("a");
    expect(create).not.toHaveBeenCalled();
  });

  it("uses the model's pick, and falls back to the first on a bad answer", async () => {
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "2" }] });
    expect(await suggestTemplateId("we'll build your website", templates)).toBe("b");
    create.mockResolvedValueOnce({ content: [{ type: "text", text: "none of these" }] });
    expect(await suggestTemplateId("unclear", templates)).toBe("a");
    create.mockRejectedValueOnce(new Error("overloaded"));
    expect(await suggestTemplateId("unclear", templates)).toBe("a");
  });
});

describe("A proposal or contract from a call", () => {
  const lead = { id: "l1", name: "Dana Lee", company: "Acme", title: null, email: "dana@acme.com", phone: null, ownerId: "u1", convertedClientId: null, hubspotContactId: null, salesforceRecordId: null, salesforceRecordType: null };
  const made = { dealId: "d1", callId: "c1", clientId: "cl1", clientName: "Dana Lee", service: "Monthly retainer", summary: null, hasMissing: false };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.phoneCall.findUniqueOrThrow.mockResolvedValue({
      id: "call1",
      source: "upload",
      transcript: "Rep: Five thousand a month, starting June?\nDana: Deal, send it over.",
      templateId: "t1",
      dealId: null,
      lead,
      user: { id: "u1", name: "Sam", email: "sam@example.com", teamId: null, deactivatedAt: null },
      // A workspace that turned "Require manual approval" off before it went away.
      workspace: { id: "w1", requireApproval: false },
    });
    prisma.contractTemplate.findMany.mockResolvedValue([{ id: "t1", name: "Retainer", description: "" }]);
    prisma.$transaction.mockResolvedValue([]);
    createDealFromTranscriptText.mockResolvedValue(made);
    finishTranscriptDealInBackground.mockResolvedValue(undefined);
    createNotification.mockResolvedValue(undefined);
    sendContractReadyEmail.mockResolvedValue(undefined);
  });

  it("leaves a contract with every term filled in as a draft for the rep, and never sends it", async () => {
    expect(await buildDealFromCall("call1", "contract")).toEqual({ dealId: "d1" });

    expect(prisma.contract.upsert).toHaveBeenCalledWith({ where: { dealId: "d1" }, create: { dealId: "d1", templateId: "t1", status: "draft" }, update: {} });
    expect(requestOrSendReview).not.toHaveBeenCalled();
    // The rep hears it's ready to review and send, not that it went out.
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", title: "Contract for Dana Lee is ready", body: "Review it and send it.", linkUrl: "/deals/d1/contract" }));
    expect(sendContractReadyEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "sam@example.com", subject: "Contract for Dana Lee is ready" }));
  });

  it("waits on the details a call missed, and tells nobody when the rep asked for it on the lead", async () => {
    createDealFromTranscriptText.mockResolvedValue({ ...made, hasMissing: true });

    await buildDealFromCall("call1", "contract", { quiet: true });

    expect(prisma.contract.upsert).not.toHaveBeenCalled();
    expect(requestOrSendReview).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendContractReadyEmail).not.toHaveBeenCalled();
  });
});
