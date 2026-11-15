import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { deal: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/workspace", () => ({ requireWorkspaceId: async () => "w1" }));
// A rep who only sees their own deals.
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => ({ where: { ownerId: "rep" } }) }));

import { documentViewState } from "./view-actions";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Watching for a proposal's first open", () => {
  it("only looks at deals this rep can see, in their workspace", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    await documentViewState("d1");
    expect(prisma.deal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1", workspaceId: "w1", ownerId: "rep" } }));
  });

  it("returns nothing for a deal that isn't there or isn't theirs", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    expect(await documentViewState("d1")).toBeNull();
  });

  it("says when it went out and when it was first opened", async () => {
    prisma.deal.findFirst.mockResolvedValue({
      contract: { status: "sent", sentAt: new Date("2026-11-14T10:00:00Z"), viewedAt: new Date("2026-11-14T10:05:00Z") },
    });
    expect(await documentViewState("d1")).toEqual({
      contractStatus: "sent",
      sentAt: "2026-11-14T10:00:00.000Z",
      viewedAt: "2026-11-14T10:05:00.000Z",
    });
  });

  it("reads empty before it's sent or before there's a document", async () => {
    prisma.deal.findFirst.mockResolvedValue({ contract: { status: "draft", sentAt: null, viewedAt: null } });
    expect(await documentViewState("d1")).toEqual({ contractStatus: "draft", sentAt: null, viewedAt: null });
    prisma.deal.findFirst.mockResolvedValue({ contract: null });
    expect(await documentViewState("d1")).toEqual({ contractStatus: null, sentAt: null, viewedAt: null });
  });
});
