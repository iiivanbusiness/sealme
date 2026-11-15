import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, refreshLeadPipeline, syncLeadClient, leadForClient } = vi.hoisted(() => ({
  prisma: { deal: { findFirst: vi.fn(), update: vi.fn() } },
  refreshLeadPipeline: vi.fn(),
  syncLeadClient: vi.fn(),
  leadForClient: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: {}, userId: "u1" }) }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "ana@agency.test" } }) }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline, syncLeadClient }));
vi.mock("@/lib/client-lead", () => ({ leadForClient }));

import { restoreDeal } from "./bulk-actions";

describe("Putting a deal back from the trash", () => {
  const trashed = (over: object) => ({ id: "d1", leadId: null, ownerId: "u1", kind: "contract", client: { id: "c1", name: "Dana", company: null, email: null, phone: null }, contract: { status: "signed" }, ...over });

  beforeEach(() => {
    vi.clearAllMocks();
    leadForClient.mockResolvedValue("l9");
  });

  it("makes the lead a signed contract lands on a client again", async () => {
    prisma.deal.findFirst.mockResolvedValue(trashed({}));
    await restoreDeal("d1");
    expect(prisma.deal.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { trashedAt: null, leadId: "l9" } });
    expect(syncLeadClient).toHaveBeenCalledWith("l9");
    // After the deal is out of the trash, so the lead's signed contract counts.
    expect(prisma.deal.update.mock.invocationCallOrder[0]).toBeLessThan(syncLeadClient.mock.invocationCallOrder[0]);
    expect(refreshLeadPipeline).toHaveBeenCalledWith("l9");
  });

  it("leaves who's a client alone for anything else", async () => {
    prisma.deal.findFirst.mockResolvedValue(trashed({ leadId: "l1", contract: { status: "draft" } }));
    await restoreDeal("d1");
    prisma.deal.findFirst.mockResolvedValue(trashed({ leadId: "l1", kind: "proposal" }));
    await restoreDeal("d1");
    expect(syncLeadClient).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).toHaveBeenCalledTimes(2);
  });
});
