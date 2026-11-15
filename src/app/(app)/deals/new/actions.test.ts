import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, visibility, leadForCall } = vi.hoisted(() => ({
  prisma: {
    localCaptureToken: { findFirst: vi.fn(), update: vi.fn() },
    deal: { findFirst: vi.fn(), updateMany: vi.fn() },
    call: { updateMany: vi.fn() },
    dealField: { count: vi.fn() },
    phoneCall: { findFirst: vi.fn(), create: vi.fn() },
    lead: { update: vi.fn() },
    contractTemplate: { findFirst: vi.fn() },
  },
  visibility: { where: { OR: [{ ownerId: "u1" }, { ownerId: null }] }, canViewAll: false, userId: "u1" },
  leadForCall: vi.fn(),
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
vi.mock("@/lib/prospecting", () => ({ requireProspecting: async () => ({ id: "w1" }) }));
vi.mock("@/lib/lead-visibility", () => ({ leadAccess: async () => visibility }));
vi.mock("@/lib/call-lead", () => ({ leadForCall }));
vi.mock("@/lib/call-inbox", () => ({ PENDING_TTL_MS: 0, runCallProcessing: vi.fn() }));
vi.mock("@/lib/cold-call", () => ({ NEW_LEAD_NAME: "New lead" }));
vi.mock("@/lib/viewer-time", () => ({ cookieTimeZone: async () => "UTC" }));

import { redirect } from "next/navigation";
import { discardLocalCapture, saveRecordedMeeting, startCallFromTranscript } from "./actions";

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

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
};

describe("Saving a call from Start a call", () => {
  beforeEach(() => {
    leadForCall.mockResolvedValue({ id: "l1", fresh: false });
    prisma.phoneCall.create.mockResolvedValue({ id: "pc1" });
    prisma.contractTemplate.findFirst.mockResolvedValue(null);
  });

  it("opens the lead with the call it just saved", async () => {
    await startCallFromTranscript(null, form({ transcript: "Rep: Hi", leadId: "l1", source: "text" }));
    expect(redirect).toHaveBeenCalledWith("/leads/l1?call=pc1&added=1");
  });

  it("opens a lead the call still has to name the same way", async () => {
    leadForCall.mockResolvedValue({ id: "l-new", fresh: true });
    await startCallFromTranscript(null, form({ transcript: "Rep: Hi", source: "text" }));
    expect(redirect).toHaveBeenCalledWith("/leads/l-new?call=pc1&added=1");
  });

  it("hands back what to fix instead of throwing, and saves nothing", async () => {
    expect(await startCallFromTranscript(null, form({ transcript: "  ", source: "text" }))).toEqual({ error: "Add the recording or paste the transcript first" });
    expect(await startCallFromTranscript(null, form({ transcript: "x".repeat(400_001), source: "text" }))).toEqual({ error: "That transcript is too long. Use one call at a time" });
    expect(await startCallFromTranscript(null, form({ transcript: "Rep: Hi", wantsContract: "1", contractTemplateId: "t-other" }))).toEqual({ error: "That template isn't in this workspace" });
    leadForCall.mockResolvedValue(null);
    expect(await startCallFromTranscript(null, form({ transcript: "Rep: Hi", leadId: "l-hidden" }))).toEqual({ error: "That lead isn't available" });

    expect(prisma.phoneCall.create).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("keeps a transcribed recording a recording, with its length", async () => {
    await startCallFromTranscript(null, form({ transcript: "Rep: Hi", source: "recording", seconds: "61.4" }));
    expect(prisma.phoneCall.create.mock.calls[0][0].data).toMatchObject({ source: "upload", durationSec: 61, sttSeconds: 61 });
  });

  it("still throws for the iPhone app, which deletes the recording once the save returns", async () => {
    await expect(saveRecordedMeeting(form({ transcript: "" }))).rejects.toThrow("Add the recording or paste the transcript first");
    // It hands back where the call landed, so the app can open that call on the lead.
    await expect(saveRecordedMeeting(form({ transcript: "Rep: Hi", seconds: "90" }))).resolves.toMatchObject({ leadId: expect.any(String), callId: expect.any(String) });
    expect(prisma.phoneCall.create.mock.calls[0][0].data).toMatchObject({ source: "app", wantsProposal: false, wantsContract: false });
  });
});
