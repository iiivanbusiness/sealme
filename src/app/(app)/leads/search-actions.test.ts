import { beforeEach, describe, expect, it, vi } from "vitest";

const { lead, visible } = vi.hoisted(() => ({ lead: { findMany: vi.fn() }, visible: { OR: [{ ownerId: "u1" }] } }));
vi.mock("@/lib/db", () => ({ prisma: { lead } }));
vi.mock("@/lib/prospecting", () => ({ requireProspecting: async () => ({ id: "w1" }) }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => ({ where: visible, userId: "u1" }) }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead from a call" }));

import { searchCallLeads } from "./search-actions";

beforeEach(() => {
  vi.clearAllMocks();
  lead.findMany.mockResolvedValue([{ id: "l1", name: "Kim Park", company: "Acme", email: "kim@acme.com", isClient: false, _count: { phoneCalls: 2 } }]);
});

describe("Who's on the call? suggestions", () => {
  it("leaves out the leads a call made for itself that have no name yet", async () => {
    expect(await searchCallLeads("new")).toEqual([{ id: "l1", name: "Kim Park", company: "Acme", email: "kim@acme.com", isClient: false, calls: 2 }]);
    const where = lead.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe("w1");
    expect(where.AND).toContainEqual(visible);
    expect(where.AND).toContainEqual({ name: { not: "New lead from a call" } });
  });

  it("doesn't look anything up for less than two letters", async () => {
    expect(await searchCallLeads(" k ")).toEqual([]);
    expect(lead.findMany).not.toHaveBeenCalled();
  });
});
