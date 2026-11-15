import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, transcribeWav, applyExtraction, highlights, notify, live, callCompleted, afterFns } = vi.hoisted(() => ({
  db: {
    localCaptureToken: { findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    call: { findUnique: vi.fn(), updateMany: vi.fn() },
    phoneCall: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    deal: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  },
  transcribeWav: vi.fn(),
  applyExtraction: vi.fn(),
  highlights: vi.fn(),
  notify: vi.fn(),
  live: { refreshLiveDeals: vi.fn(), finishLiveCall: vi.fn() },
  callCompleted: vi.fn(),
  afterFns: [] as (() => unknown)[],
}));
vi.mock("@/lib/db", () => ({ prisma: db }));
vi.mock("@/lib/live-call", () => live);
// Work left for after the answer runs when the test says so.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), after: (fn: () => unknown) => void afterFns.push(fn) }));
vi.mock("@/lib/deepgram", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/deepgram")>()), transcribeWav, isDeepgramConfigured: () => true }));
vi.mock("@/lib/deal-live", () => ({ applyExtractionToDeal: applyExtraction }));
vi.mock("@/lib/contract", () => ({ extractPlaceholderKeys: () => ["fee"] }));
vi.mock("@/lib/extract-action-items", () => ({ extractActionItems: async () => {} }));
vi.mock("@/lib/extract-call-highlights", () => ({ extractCallHighlights: highlights }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => true }));
vi.mock("@/lib/audit", () => ({ logAudit: async () => {} }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/notifications", () => ({ createNotification: notify }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/webhook-events", () => ({ dispatchCallCompleted: callCompleted }));

import { POST } from "./route";
import { DeepgramError } from "@/lib/deepgram";

const later = new Date(Date.now() + 60 * 60 * 1000);
const token = (over: object = {}) => ({ id: "t1", dealId: "d1", callId: "c1", usedAt: null, expiresAt: later, call: { endedAt: null }, ...over });
const deal = { id: "d1", workspaceId: "w1", ownerId: "u1", status: "processing", template: { clauses: "" }, workspace: { name: "Acme" } };

function upload(final: boolean, body: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])) {
  return POST(new Request(`https://app.test/api/local-capture/transcribe?final=${final}`, { method: "POST", headers: { authorization: "Bearer tok" }, body }));
}

// A chunk laid out the way the desktop app writes it: a 44-byte header,
// then 16 kHz stereo 16-bit PCM (64,000 bytes a second).
function stereoWav(seconds: number): Uint8Array<ArrayBuffer> {
  const data = 64_000 * seconds;
  const bytes = new Uint8Array(44 + data);
  const wav = Buffer.from(bytes.buffer);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(64_000, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(data, 40);
  return bytes;
}

// The seconds each transcription-count write added to a call.
function sttAdded() {
  return db.$executeRaw.mock.calls.filter(([sql]) => (sql as string[]).join("?").includes('"sttSeconds" = COALESCE("sttSeconds", 0) +')).map(([, seconds, id]) => ({ seconds, id }));
}

beforeEach(() => {
  vi.clearAllMocks();
  afterFns.length = 0;
  live.refreshLiveDeals.mockResolvedValue(undefined);
  live.finishLiveCall.mockResolvedValue(undefined);
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

  it("reads highlights from this call only, and leaves a complete contract for the rep to send", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(token());
    db.call.findUnique.mockResolvedValue({ transcript: "\nClient: Five thousand works." });
    applyExtraction.mockResolvedValue({ hasMissing: false });

    const res = await upload(true);
    expect(res.status).toBe(200);
    expect(highlights).toHaveBeenCalledWith("d1", "\nClient: Five thousand works.", "c1");
    // Nothing went out, so there's no send to fail and nothing to tell the rep.
    expect(notify).not.toHaveBeenCalled();
    expect(db.deal.update).not.toHaveBeenCalled();
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

describe("Live call upload (a call on a lead)", () => {
  const callToken = (over: object = {}) => ({ id: "t2", dealId: null, callId: null, phoneCallId: "pc1", usedAt: null, expiresAt: later, call: null, ...over });
  const startedAt = new Date(Date.now() - 5 * 60 * 1000);
  const recording = { id: "pc1", status: "recording", startedAt, endedAt: null, workspaceId: "w1" };

  it("adds each chunk's words to the call and reads the terms after answering", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(callToken());
    db.phoneCall.findUnique.mockResolvedValueOnce(recording).mockResolvedValueOnce({ transcript: "\nYou: Hi" }).mockResolvedValue({ transcript: "\nYou: Hi\nClient: Five thousand works." });

    const res = await upload(false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, final: false });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.localCaptureToken.updateMany).not.toHaveBeenCalled();
    expect(live.refreshLiveDeals).not.toHaveBeenCalled();
    // The old, deal-based path never runs for a call on a lead.
    expect(db.deal.findUnique).not.toHaveBeenCalled();

    await Promise.all(afterFns.map((fn) => fn()));
    expect(live.refreshLiveDeals).toHaveBeenCalledWith("pc1", "\nYou: Hi\nClient: Five thousand works.");
  });

  it("ends the call on the final and writes it up afterwards; nothing is sent", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(callToken());
    db.phoneCall.findUnique.mockResolvedValueOnce(recording).mockResolvedValue({ transcript: "\nYou: Hi\nClient: Five thousand works." });

    const res = await upload(true);
    expect(res.status).toBe(200);
    expect(db.phoneCall.updateMany).toHaveBeenCalledWith({ where: { id: "pc1", endedAt: null }, data: { endedAt: expect.any(Date) } });
    const done = db.phoneCall.update.mock.calls[0][0];
    expect(done).toMatchObject({ where: { id: "pc1" }, data: { status: "processing" } });
    expect(done.data.durationSec).toBeGreaterThanOrEqual(299);
    expect(db.localCaptureToken.update).toHaveBeenCalledWith({ where: { id: "t2" }, data: { expiresAt: expect.any(Date) } });

    await Promise.all(afterFns.map((fn) => fn()));
    expect(live.finishLiveCall).toHaveBeenCalledWith("pc1");
  });

  it("sets aside a call that never heard a word, leaving its documents waiting on the rep", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(callToken());
    transcribeWav.mockResolvedValue("");
    db.phoneCall.findUnique.mockResolvedValueOnce(recording).mockResolvedValue({ transcript: null });

    expect((await upload(true)).status).toBe(200);
    expect(db.phoneCall.update.mock.calls[0][0].data).toMatchObject({ status: "skipped", extracted: { skipped: "no_speech" } });
    expect(db.deal.updateMany).toHaveBeenCalledWith({ where: { phoneCallId: "pc1", status: "processing" }, data: { status: "missing_info" } });
    expect(afterFns).toHaveLength(0);
    // SealMe is done with it, like any call nothing was heard on.
    expect(callCompleted).toHaveBeenCalledWith("w1", "pc1");
  });

  it("counts every chunk Deepgram transcribed toward the call's cost, once per channel, words or not", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(callToken());
    db.phoneCall.findUnique.mockResolvedValueOnce(recording).mockResolvedValue({ transcript: "\nYou: Hi" });

    expect((await upload(false, stereoWav(3))).status).toBe(200);
    // 3 seconds of two channels: 6 billed seconds.
    expect(sttAdded()).toEqual([{ seconds: 6, id: "pc1" }]);

    // Silence is billed too, even though nothing goes on the call.
    db.$executeRaw.mockClear();
    transcribeWav.mockResolvedValueOnce("");
    db.phoneCall.findUnique.mockResolvedValueOnce(recording);
    expect((await upload(false, stereoWav(2))).status).toBe(200);
    expect(sttAdded()).toEqual([{ seconds: 4, id: "pc1" }]);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);

    // Audio Deepgram turned away isn't billed, and a body that isn't a WAV
    // counts as nothing.
    db.$executeRaw.mockClear();
    transcribeWav.mockRejectedValueOnce(new DeepgramError(400, "corrupt or unsupported data"));
    db.phoneCall.findUnique.mockResolvedValueOnce(recording);
    expect((await upload(false, stereoWav(2))).status).toBe(200);
    db.phoneCall.findUnique.mockResolvedValueOnce(recording);
    expect((await upload(false)).status).toBe(200);
    expect(sttAdded()).toEqual([]);
  });

  it("turns away a live ping once the call has ended", async () => {
    db.localCaptureToken.findUnique.mockResolvedValue(callToken());
    db.phoneCall.findUnique.mockResolvedValue({ ...recording, status: "processing" });
    expect((await upload(false)).status).toBe(401);
    expect(transcribeWav).not.toHaveBeenCalled();
  });
});
