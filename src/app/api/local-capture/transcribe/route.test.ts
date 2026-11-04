import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, transcribeWav, applyExtraction, autoSend, highlights, notify } = vi.hoisted(() => ({
  db: {
    localCaptureToken: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    call: { findUnique: vi.fn(), updateMany: vi.fn() },
    deal: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  transcribeWav: vi.fn(),
  applyExtraction: vi.fn(),
  autoSend: vi.fn(),
  highlights: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/deepgram", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/deepgram")>()), transcribeWav, isDeepgramConfigured: () => true }));
vi.mock("@/lib/deal-live", () => ({ applyExtractionToDeal: applyExtraction }));
vi.mock("@/lib/contract", () => ({ extractPlaceholderKeys: () => ["fee"] }));
vi.mock("@/lib/auto-send", () => ({ autoGenerateAndSendContract: autoSend }));
vi.mock("@/lib/extract-action-items", () => ({ extractActionItems: async () => {} }));
vi.mock("@/lib/extract-call-highlights", () => ({ extractCallHighlights: highlights }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/audit", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/notifications", () => ({ createNotification: notify }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { POST } from "./route";
import { DeepgramError } from "@/lib/deepgram";

const later = new Date(Date.now() + 60 * 60 * 1000);
const token = (over: object = {}) => ({ id: "t1", dealId: "d1", callId: "c1", usedAt: null, expiresAt: later, call: { endedAt: null }, ...over });
const deal = { id: "d1", workspaceId: "w1", ownerId: "u1", status: "processing", template: { clauses: "" }, workspace: { name: "Acme", requireApproval: false }, client: { name: "Dana" } };

function upload(final: boolean) {
  return POST(new Request(`https://app.test/api/local-capture/transcribe?final=${final}`, { method: "POST", headers: { authorization: "Bearer tok" }, body: new Uint8Array([1, 2, 3]) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  db.deal.findUnique.mockResolvedValue({ ...deal, liveTranscript: "\nYou: Hi\nClient: Five thousand works." });
  db.localCaptureToken.updateMany.mockResolvedValue({ count: 1 });
  db.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
  transcribeWav.mockResolvedValue("Client: Five thousand works.");
  applyExtraction.mockResolvedValue({ hasMissing: true });
  highlights.mockResolvedValue(undefined);
  notify.mockResolvedValue(undefined);
});

describe("Local capture upload", () => {
  it("lets go of a final that failed, so the same audio can be sent again without being heard twice", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nYou: Hi" });
    applyExtraction.mockRejectedValueOnce(new Error("Anthropic 529"));

    const first = await upload(true);
    expect(first.status).toBe(500);
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    const claimedAt = db.localCaptureToken.updateMany.mock.calls[0][0].data.usedAt;
    expect(db.localCaptureToken.updateMany).toHaveBeenLastCalledWith({ where: { id: "t1", usedAt: claimedAt }, data: { usedAt: null } });
    expect(db.deal.updateMany).toHaveBeenCalledWith({ where: { id: "d1", status: { notIn: ["sent", "signed", "pending_approval"] } }, data: { status: "extraction_failed" } });
    expect(db.localCaptureToken.update).not.toHaveBeenCalled();

    // The desktop sends the same final again: its words are already in.
    db.$executeRaw.mockClear();
    db.localCaptureToken.findUnique.mockResolvedValue(token({ call: { endedAt: claimedAt } }));
    db.call.findUnique.mockResolvedValue({ transcript: "\nYou: Hi\nClient: Five thousand works." });

    const again = await upload(true);
    expect(again.status).toBe(200);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    const spentAt = db.localCaptureToken.updateMany.mock.calls.at(-1)?.[0].data.usedAt;
    expect(db.localCaptureToken.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { expiresAt: spentAt } });
  });

  it("tells a final sent again after the call finished that it's in, and turns away late live pings", async () => {
    const at = new Date(Date.now() - 60 * 1000);
    db.localCaptureToken.findUnique.mockResolvedValue(token({ usedAt: at, expiresAt: at, call: { endedAt: at } }));
    expect((await upload(true)).status).toBe(200);
    expect((await upload(false)).status).toBe(401);
    expect(db.localCaptureToken.updateMany).not.toHaveBeenCalled();
    expect(transcribeWav).not.toHaveBeenCalled();

    // Live pings also stop once a final has come in, finished or not.
    db.localCaptureToken.findUnique.mockResolvedValue(token({ call: { endedAt: at } }));
    expect((await upload(false)).status).toBe(401);
  });

  it("doesn't run two final passes at once", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token({ usedAt: new Date() }));
    db.localCaptureToken.updateMany.mockResolvedValue({ count: 0 });
    expect((await upload(true)).status).toBe(409);
    expect(transcribeWav).not.toHaveBeenCalled();
  });

  it("keeps a first final's words even when they match the end of the last ping", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nYou: Hi\nClient: Five thousand works." });

    expect((await upload(true)).status).toBe(200);
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("reads highlights from this call only, and a contract that couldn't go out isn't a failed call", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nClient: Five thousand works." });
    applyExtraction.mockResolvedValue({ hasMissing: false });
    autoSend.mockRejectedValue(new Error("Invalid `to` field"));

    const res = await upload(true);
    expect(res.status).toBe(200);
    expect(highlights).toHaveBeenCalledWith("d1", "\nClient: Five thousand works.", "c1");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", type: "contract.send_failed", title: "Contract for Dana couldn't be sent" }));
    expect(db.deal.updateMany).not.toHaveBeenCalled();
    expect(db.localCaptureToken.update).toHaveBeenCalled();
  });

  it("answers a live chunk Deepgram couldn't read with an error, so the desktop sends it again", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nYou: Hi" });
    transcribeWav.mockRejectedValueOnce(new DeepgramError(503, "Service Unavailable"));

    const failed = await upload(false);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(db.$executeRaw).not.toHaveBeenCalled();

    const again = await upload(false);
    expect(again.status).toBe(200);
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("keeps a live chunk whose words went in when only reading the terms failed", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nYou: Hi" });
    applyExtraction.mockRejectedValueOnce(new Error("Anthropic 529"));

    const res = await upload(false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it("doesn't add a live chunk sent again after its words went in", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nYou: Hi\nClient: Five thousand works." });

    const res = await upload(false);
    expect(res.status).toBe(200);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(applyExtraction).not.toHaveBeenCalled();
  });

  it("passes over audio Deepgram will never take instead of holding up the rest of the call", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nYou: Hi" });
    transcribeWav.mockRejectedValue(new DeepgramError(400, "corrupt or unsupported data"));

    expect((await upload(false)).status).toBe(200);
    const final = await upload(true);
    expect(final.status).toBe(200);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(applyExtraction).toHaveBeenCalledTimes(1);
    expect(db.localCaptureToken.update).toHaveBeenCalled();
  });
});
