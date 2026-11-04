import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, visibility } = vi.hoisted(() => ({
  prisma: {
    localCaptureToken: { findFirst: vi.fn(), update: vi.fn() },
    deal: { findFirst: vi.fn(), updateMany: vi.fn() },
    call: { updateMany: vi.fn() },
    dealField: { count: vi.fn() },
  },
  visibility: { where: { OR: [{ ownerId: "u1" }, { ownerId: null }] }, canViewAll: false, userId: "u1" },
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/workspace", () => ({ requireWorkspace: async () => ({ id: "w1" }) }));
vi.mock("@/lib/deal-visibility", () => ({ dealVisibilityFilter: async () => visibility }));
vi.mock("@/lib/permissions", () => ({ currentUserWithRole: vi.fn() }));
vi.mock("@/lib/webhooks", () => ({ dispatchDealCreated: vi.fn() }));
vi.mock("@/lib/slack", () => ({ notifySlack: vi.fn() }));
vi.mock("@/lib/hubspot", () => ({ syncDealToHubspot: vi.fn() }));
vi.mock("@/lib/salesforce", () => ({ syncDealToSalesforce: vi.fn() }));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/transcript-deal", () => ({}));
vi.mock("@/lib/contract", () => ({ extractPlaceholderKeys: () => [] }));
vi.mock("@/lib/extract-deal", () => ({}));
vi.mock("@/lib/prospecting", () => ({ requireProspecting: vi.fn() }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: vi.fn() }));
vi.mock("@/lib/call-inbox", () => ({ PENDING_TTL_MS: 0, runCallProcessing: vi.fn() }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead" }));
vi.mock("@/lib/viewer-time", () => ({ cookieTimeZone: async () => "UTC" }));

import { discardLocalCapture } from "./actions";

const tokenHash = crypto.createHash("sha256").update("tok").digest("hex");

beforeEach(() => {
  vi.clearAllMocks();
  prisma.localCaptureToken.findFirst.mockResolvedValue({ id: "t1", callId: "c1" });
  prisma.deal.findFirst.mockResolvedValue({ id: "d1" });
  prisma.dealField.count.mockResolvedValue(2);
});

describe("Discarding a call recorded in the desktop app", () => {
  it("ends the call, spends its token and takes the deal off processing", async () => {
    await discardLocalCapture("d1", "tok");

    expect(prisma.localCaptureToken.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { tokenHash, dealId: "d1", workspaceId: "w1" } }));
    expect(prisma.deal.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "d1", workspaceId: "w1", ...visibility.where } }));
    const endedAt = prisma.call.updateMany.mock.calls[0][0].data.endedAt;
    expect(prisma.call.updateMany).toHaveBeenCalledWith({ where: { id: "c1", endedAt: null }, data: { endedAt } });
    expect(prisma.localCaptureToken.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { usedAt: endedAt, expiresAt: endedAt } });
    expect(prisma.deal.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "processing" }, data: { status: "missing_info" } });
  });

  it("marks a deal with every term heard ready", async () => {
    prisma.dealField.count.mockResolvedValue(0);
    await discardLocalCapture("d1", "tok");
    expect(prisma.deal.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: "processing" }, data: { status: "ready" } });
  });

  it("leaves alone a call on a deal this person can't see, or a token that isn't this deal's", async () => {
    prisma.deal.findFirst.mockResolvedValue(null);
    await discardLocalCapture("d1", "tok");
    prisma.deal.findFirst.mockResolvedValue({ id: "d1" });
    prisma.localCaptureToken.findFirst.mockResolvedValue(null);
    await discardLocalCapture("d1", "other");

    expect(prisma.call.updateMany).not.toHaveBeenCalled();
    expect(prisma.localCaptureToken.update).not.toHaveBeenCalled();
    expect(prisma.deal.updateMany).not.toHaveBeenCalled();
  });
});
