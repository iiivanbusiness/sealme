import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({ prisma: { deal: { findFirst: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1", requireWorkspace: async () => ({ name: "Northpeak", docusignEnabled: false, docusignAccountEmail: null }) }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: {} }) }));
vi.mock("@/lib/email", () => ({ isEmailConfigured: () => true }));
vi.mock("@/lib/review", () => ({ canSendDocument: (contract: { status: string }) => contract.status === "draft" }));
vi.mock("../actions", () => ({ sendContractEmail: vi.fn() }));
vi.mock("@/components/SendContractForm", () => ({ default: () => null }));

import SendContractPage from "./page";

const deal = (status: string, kind = "contract") => ({
  id: "d1",
  kind,
  client: { name: "Dana Ruiz", email: "dana@harbor.test" },
  template: { name: "Service Agreement" },
  contract: { status, ccEmails: null, deliveryMethod: "sealme", sentAt: null, signers: [] },
});
const page = () => SendContractPage({ params: Promise.resolve({ id: "d1" }), searchParams: Promise.resolve({}) });

describe("The Send page", () => {
  beforeEach(() => vi.clearAllMocks());

  it("goes back to the contract screen when the document can't go out", async () => {
    prisma.deal.findFirst.mockResolvedValue(deal("signed"));
    await expect(page()).rejects.toThrow(/^redirect \/deals\/d1$/);
  });

  it("links back to the contract screen", async () => {
    prisma.deal.findFirst.mockResolvedValue(deal("draft"));
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('href="/deals/d1"');
    expect(html).toContain("Back to the contract");
    expect(html).not.toContain("/contract\"");

    prisma.deal.findFirst.mockResolvedValue(deal("draft", "proposal"));
    expect(renderToStaticMarkup(await page())).toContain("Back to the proposal");
  });
});
