import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, leadForClient, refreshLeadPipeline } = vi.hoisted(() => ({
  prisma: {
    client: { findFirst: vi.fn(), create: vi.fn() },
    deal: { findFirst: vi.fn(), create: vi.fn() },
    lead: { updateMany: vi.fn() },
  },
  leadForClient: vi.fn(),
  refreshLeadPipeline: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { email: "admin@example.com" } }) }));
vi.mock("@/lib/permissions", () => ({
  requirePermission: async () => ({ workspaceId: "w1" }),
  currentUserWithRole: async () => ({ id: "u1", teamId: null }),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/client-lead", () => ({ leadForClient }));
vi.mock("@/lib/lead-pipeline", () => ({ refreshLeadPipeline }));

import { importClientsAndDeals } from "./import-actions";

const csv = (...rows: string[]) => {
  const form = new FormData();
  form.set("csv", ["client_name,client_company,client_email,service,fee,status,signed_date", ...rows].join("\n"));
  return form;
};
const client = { id: "c1", name: "Sam Rivera", company: "Acme", email: "sam@acme.com" };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.client.findFirst.mockResolvedValue(null);
  prisma.client.create.mockResolvedValue(client);
  prisma.deal.findFirst.mockResolvedValue(null);
  prisma.deal.create.mockResolvedValue({ id: "d1" });
  leadForClient.mockResolvedValue("l1");
});

describe("importClientsAndDeals", () => {
  it("finds the client by email whatever the case, and keeps new emails in lowercase", async () => {
    await importClientsAndDeals(csv("Sam Rivera,Acme,Sam@Acme.com,SEO,$2000,ready,"));
    expect(prisma.client.findFirst).toHaveBeenCalledWith({ where: { workspaceId: "w1", email: { equals: "sam@acme.com", mode: "insensitive" } } });
    expect(prisma.client.create.mock.calls[0][0].data.email).toBe("sam@acme.com");
  });

  it("skips a row imported before instead of making the deal twice", async () => {
    prisma.client.findFirst.mockResolvedValue(client);
    prisma.deal.findFirst.mockResolvedValue({ id: "d0" });
    const r = await importClientsAndDeals(csv("Sam Rivera,Acme,sam@acme.com,SEO,$2000,signed,2026-03-01"));
    expect(r).toMatchObject({ created: 0, skipped: 1, errors: [{ row: 2, message: expect.stringContaining("Already imported") }] });
    expect(prisma.deal.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "w1",
        clientId: "c1",
        kind: "contract",
        trashedAt: null,
        service: "SEO",
        feeDisplay: "$2000",
        contract: { signedAt: { gte: new Date("2026-03-01T00:00:00Z"), lt: new Date("2026-03-02T00:00:00Z") } },
      },
      select: { id: true },
    });
    expect(prisma.deal.create).not.toHaveBeenCalled();
    expect(leadForClient).not.toHaveBeenCalled();
  });

  it("matches a row without a date on service and fee alone", async () => {
    prisma.client.findFirst.mockResolvedValue(client);
    await importClientsAndDeals(csv("Sam Rivera,Acme,sam@acme.com,SEO,$2000,ready,"));
    expect(prisma.deal.findFirst.mock.calls[0][0].where).not.toHaveProperty("contract");
    expect(prisma.deal.create).toHaveBeenCalledTimes(1);
  });

  it("doesn't look for a duplicate deal on a client it just made", async () => {
    const r = await importClientsAndDeals(csv("Sam Rivera,Acme,sam@acme.com,SEO,$2000,sent,"));
    expect(r).toMatchObject({ created: 1, skipped: 0 });
    expect(prisma.deal.findFirst).not.toHaveBeenCalled();
    expect(refreshLeadPipeline).toHaveBeenCalledWith("l1");
  });
});
