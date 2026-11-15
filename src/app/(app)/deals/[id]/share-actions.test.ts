import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, logAudit, refreshLeadPipeline, sendContractEmail, revalidatePath } = vi.hoisted(() => ({
  prisma: {
    deal: { findFirst: vi.fn(), update: vi.fn() },
    contract: { update: vi.fn() },
    clauseComment: { updateMany: vi.fn() },
  },
  logAudit: vi.fn(),
  refreshLeadPipeline: vi.fn(),
  sendContractEmail: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: { ownerId: "u1" }, userId: "u1" }) }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "ana@agency.test" } }) }));
vi.mock("@/lib/audit", () => ({ logAudit }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline }));
// The real markProposalSent, with everything that could reach the client stubbed.
vi.mock("@/lib/email", () => ({ sendContractEmail, sendReviewAssignedEmail: vi.fn(), sendChangesRequestedEmail: vi.fn() }));
vi.mock("@react-pdf/renderer", () => ({ renderToBuffer: vi.fn() }));
vi.mock("@/lib/contract-pdf", () => ({ ContractPdfDocument: () => null }));
vi.mock("@/lib/docusign", () => ({ sendDocusignEnvelope: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotification: vi.fn() }));
vi.mock("@/lib/client-portal", () => ({ getOrMintPortalToken: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock("@/lib/slack", () => ({ notifySlack: vi.fn() }));
vi.mock("@/lib/hubspot", () => ({ syncDealToHubspot: vi.fn() }));
vi.mock("@/lib/salesforce", () => ({ syncDealToSalesforce: vi.fn() }));

import { shareProposalLink } from "./share-actions";

const CLAUSES = JSON.stringify([{ title: "Scope", body: "Monthly SEO for {fee}." }]);
const FEE = { fieldKey: "fee", label: "Fee", value: "$5,000 / month" };

function proposalDeal(contract: Record<string, unknown> | null, overrides: Record<string, unknown> = {}) {
  return {
    id: "d1",
    kind: "proposal",
    leadId: "lead1",
    trashedAt: null,
    client: { name: "Priya Shah", company: null },
    workspace: { name: "Agency" },
    fields: [FEE],
    contract: contract && { id: "k1", deliveryMethod: "sealme", expiresAt: null, template: { name: "SEO proposal", clauses: CLAUSES }, ...contract },
    ...overrides,
  };
}

describe("Copy link on a proposal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("looks the deal up with the rep's visibility", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    expect(await shareProposalLink("d1")).toEqual({ error: "Proposal not found" });
    expect(prisma.deal.findFirst.mock.calls[0][0].where).toEqual({ id: "d1", workspaceId: "w1", ownerId: "u1" });
  });

  it("marks a draft proposal sent, without emailing anyone", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "draft" }));

    expect(await shareProposalLink("d1")).toEqual({});

    const data = prisma.contract.update.mock.calls[0][0].data;
    expect(prisma.contract.update.mock.calls[0][0].where).toEqual({ id: "k1" });
    expect(data).toMatchObject({ status: "sent", expiresAt: null, viewedAt: null, deliveryMethod: "sealme" });
    expect(data.sentAt).toBeInstanceOf(Date);
    expect(data.snapshot).toEqual({ templateName: "SEO proposal", agencyName: "Agency", clientName: "Priya Shah", clauses: [{ title: "Scope", body: "Monthly SEO for $5,000 / month." }] });
    expect(prisma.deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { status: "sent" } });
    expect(refreshLeadPipeline).toHaveBeenCalledWith("lead1", { sentNow: true });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.link_shared", targetId: "d1" }));
    expect(revalidatePath).toHaveBeenCalledWith("/leads/lead1");
    expect(sendContractEmail).not.toHaveBeenCalled();
  });

  it("leaves one that already went out as it is", async () => {
    const viewedAt = new Date("2026-11-10T10:00:00Z");
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "sent", viewedAt }));

    expect(await shareProposalLink("d1")).toEqual({});
    expect(prisma.contract.update).not.toHaveBeenCalled();
    expect(prisma.deal.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("updates what the client sees when a sent proposal was changed since, and nothing else", async () => {
    const viewedAt = new Date("2026-11-10T10:00:00Z");
    const older = { templateName: "SEO proposal", agencyName: "Agency", clientName: "Priya Shah", clauses: [{ title: "Scope", body: "Monthly SEO for $4,000 / month." }] };
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "sent", viewedAt, snapshot: older }));

    expect(await shareProposalLink("d1")).toEqual({});

    expect(prisma.contract.update).toHaveBeenCalledTimes(1);
    expect(prisma.contract.update.mock.calls[0][0]).toEqual({
      where: { id: "k1" },
      data: { snapshot: { ...older, clauses: [{ title: "Scope", body: "Monthly SEO for $5,000 / month." }] } },
    });
    expect(prisma.deal.update).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "proposal.link_updated" }));
  });

  it("leaves a sent proposal alone when its text is what the client already has", async () => {
    const same = { templateName: "SEO proposal", agencyName: "Agency", clientName: "Priya Shah", clauses: [{ title: "Scope", body: "Monthly SEO for $5,000 / month." }] };
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "sent", snapshot: same }));
    expect(await shareProposalLink("d1")).toEqual({});
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });

  it("won't update a sent proposal to a version with a blank term", async () => {
    const older = { templateName: "SEO proposal", agencyName: "Agency", clientName: "Priya Shah", clauses: [{ title: "Scope", body: "Monthly SEO for $4,000 / month." }] };
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "sent", snapshot: older }, { fields: [{ ...FEE, value: null }] }));
    expect(await shareProposalLink("d1")).toEqual({ error: "Fill in Fee first" });
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });

  it("won't share one with a blank term", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "draft" }, { fields: [{ ...FEE, value: " " }] }));
    expect(await shareProposalLink("d1")).toEqual({ error: "Fill in Fee first" });
    expect(prisma.contract.update).not.toHaveBeenCalled();
  });

  it("refuses a contract, a proposal in the trash, one with nothing made yet, and one in review", async () => {
    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "draft" }, { kind: "contract" }));
    expect(await shareProposalLink("d1")).toEqual({ error: "Proposal not found" });

    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "draft" }, { trashedAt: new Date() }));
    expect((await shareProposalLink("d1")).error).toContain("trash");

    prisma.deal.findFirst.mockResolvedValue(proposalDeal(null));
    expect((await shareProposalLink("d1")).error).toBeTruthy();

    prisma.deal.findFirst.mockResolvedValue(proposalDeal({ status: "pending_approval" }));
    expect(await shareProposalLink("d1")).toEqual({ error: "This proposal is waiting on review" });

    expect(prisma.contract.update).not.toHaveBeenCalled();
  });
});
