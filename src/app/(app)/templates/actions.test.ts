import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, redirect } = vi.hoisted(() => ({
  prisma: {
    contractTemplate: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    workspace: { findUnique: vi.fn() },
    deal: { count: vi.fn() },
  },
  // Like Next's, it ends the action.
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/navigation", () => ({ redirect }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/permissions", () => ({ requirePermission: async () => ({ id: "u1", email: "rep@example.com", workspaceId: "w1", role: { canApproveTemplates: true } }) }));

import { createSampleProposalTemplate, createTemplate, deleteTemplate, updateTemplate } from "./actions";

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}
const clausesJson = JSON.stringify([{ title: "Scope", body: "We will provide {service} for {clientName}." }]);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.contractTemplate.create.mockResolvedValue({ id: "t1" });
});

describe("Making a template", () => {
  it("saves the kind it was made as", async () => {
    await expect(createTemplate(form({ name: "Web Proposal", clausesJson, kind: "proposal" }))).rejects.toThrow("redirect:/templates/t1");
    expect(prisma.contractTemplate.create.mock.calls[0][0].data).toMatchObject({ workspaceId: "w1", name: "Web Proposal", kind: "proposal", requiredFieldCount: 2 });
  });

  it("makes anything that isn't a proposal a contract", async () => {
    await expect(createTemplate(form({ name: "Retainer", clausesJson, kind: "invoice" }))).rejects.toThrow("redirect:");
    expect(prisma.contractTemplate.create.mock.calls[0][0].data.kind).toBe("contract");
    await expect(createTemplate(form({ name: "Retainer", clausesJson }))).rejects.toThrow("redirect:");
    expect(prisma.contractTemplate.create.mock.calls[1][0].data.kind).toBe("contract");
  });

  it("never changes the kind on an edit", async () => {
    prisma.contractTemplate.findFirst.mockResolvedValue({ id: "t1", kind: "proposal", locked: false });
    await expect(updateTemplate("t1", form({ name: "Renamed", clausesJson, kind: "contract" }))).rejects.toThrow("redirect:/templates/t1");
    expect(prisma.contractTemplate.updateMany.mock.calls[0][0].data).not.toHaveProperty("kind");
  });
});

describe("Starting from the sample proposal", () => {
  it("makes a proposal template named for the workspace and opens it", async () => {
    prisma.workspace.findUnique.mockResolvedValue({ name: "Northwind Studio" });
    await expect(createSampleProposalTemplate()).rejects.toThrow("redirect:/templates/t1");
    const data = prisma.contractTemplate.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ workspaceId: "w1", name: "Proposal", kind: "proposal" });
    expect(data.clauses).toContain("Northwind Studio");
  });
});

describe("Deleting a template", () => {
  it("goes back to the list of its kind", async () => {
    prisma.contractTemplate.findFirst.mockResolvedValue({ id: "t1", kind: "proposal", locked: false });
    prisma.deal.count.mockResolvedValue(0);
    await expect(deleteTemplate("t1")).rejects.toThrow("redirect:/templates?kind=proposal");
  });
});
