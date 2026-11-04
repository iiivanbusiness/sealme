import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, runCallProcessing } = vi.hoisted(() => ({
  prisma: {
    lead: { findFirst: vi.fn(), create: vi.fn() },
    phoneCall: { findFirst: vi.fn(), updateMany: vi.fn() },
    contractTemplate: { findFirst: vi.fn() },
  },
  runCallProcessing: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prospecting", () => ({ requireProspecting: async () => ({ id: "w1" }) }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => ({ userId: "u1", canViewAll: false, canAssign: false, where: {} }) }));
vi.mock("@/lib/extract-deal", () => ({ isExtractionConfigured: () => true }));
vi.mock("@/lib/call-inbox", () => ({ runCallProcessing, dropRecording: vi.fn() }));
vi.mock("@/lib/viewer-time", () => ({ cookieTimeZone: async () => "UTC" }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead" }));

import { processCall } from "./actions";

beforeEach(() => {
  vi.clearAllMocks();
  prisma.lead.findFirst.mockResolvedValue({ id: "l1", stage: "new" });
  prisma.phoneCall.updateMany.mockResolvedValue({ count: 1 });
});

describe("Processing a call from the inbox", () => {
  it("writes up notes that failed whatever their voices when they're processed again as notes", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue({ status: "failed", mode: "notes", source: "paste" });
    await processCall("p1", { leadId: "l1", mode: "notes" });
    expect(runCallProcessing).toHaveBeenCalledWith("p1", "UTC", { force: true });
  });

  it("still checks a failed phone call for a voicemail when it's processed again as notes", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue({ status: "failed", mode: "notes", source: "phone" });
    await processCall("p1", { leadId: "l1", mode: "notes" });
    expect(runCallProcessing).toHaveBeenCalledWith("p1", "UTC", { force: false });
  });

  it("still sets aside a voicemail on a first Process", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue({ status: "pending", mode: null, source: "upload" });
    await processCall("p1", { leadId: "l1", mode: "notes" });
    expect(runCallProcessing).toHaveBeenCalledWith("p1", "UTC", { force: false });
  });

  it("doesn't force a failed sales call", async () => {
    prisma.phoneCall.findFirst.mockResolvedValue({ status: "failed", mode: "sales", source: "upload" });
    await processCall("p1", { leadId: "l1", mode: "sales" });
    expect(runCallProcessing).toHaveBeenCalledWith("p1", "UTC", { force: false });
  });
});
