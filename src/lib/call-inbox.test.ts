import { describe, expect, it, vi } from "vitest";

const { phoneCall, cold, sales, classify, notify, telnyx } = vi.hoisted(() => ({
  phoneCall: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  cold: vi.fn(),
  sales: vi.fn(),
  classify: vi.fn(),
  notify: vi.fn(),
  telnyx: { recordingDownload: vi.fn(), deleteRecording: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: { phoneCall } }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/crm-call-sync", () => ({ pushCallToCrm: async () => {} }));
vi.mock("@/lib/sales-call", () => ({ applySalesCall: sales }));
vi.mock("@/lib/cold-call", () => ({ applyColdCall: cold }));
vi.mock("@/lib/call-kind", () => ({ classifyCallKind: classify }));
vi.mock("@/lib/notifications", () => ({ createNotification: notify }));
vi.mock("@/lib/telnyx", () => telnyx);

import { callCostUsd, discardStaleCalls, failStuckCalls, runCallProcessing, skipReason, speakerCount } from "./call-inbox";

const twoVoices = "Speaker 1: Hi, is this Dana?\nSpeaker 2: Speaking, who's this?\nSpeaker 1: It's Sam from SealMe.";

describe("Calls inbox", () => {
  it("counts the people talking, whatever the labels look like", () => {
    expect(speakerCount(twoVoices)).toBe(2);
    expect(speakerCount("Client: Hello?\nYou: Hi, it's Sam.")).toBe(2);
    expect(speakerCount("Speaker 1: Hi, you've reached Dana. Leave a message.")).toBe(1);
    expect(speakerCount("just words without any labels")).toBe(0);
  });

  it("sets aside short calls and one-voice calls before any model call", () => {
    expect(skipReason({ durationSec: 12, transcript: twoVoices })).toBe("too_short");
    expect(skipReason({ durationSec: 45, transcript: "Speaker 1: Hi, you've reached Dana. Leave a message after the tone." })).toBe("one_speaker");
    // A long call heard as one voice is a failed speaker split, not voicemail.
    expect(skipReason({ durationSec: 103, transcript: "Speaker 1: Hi, is this Gordan? Mhmm. Great, do you have a minute?" })).toBeNull();
    expect(skipReason({ durationSec: 95, transcript: twoVoices })).toBeNull();
    // Unknown length and unlabeled text: nothing to go on, so it's processed.
    expect(skipReason({ durationSec: null, transcript: "no labels here" })).toBeNull();
  });

  it("prices a call from minutes transcribed and tokens used", () => {
    // 3 minutes at $0.0043 plus 2,000 in / 400 out at $1 / $5 per million.
    expect(callCostUsd({ sttSeconds: 180, aiInputTokens: 2000, aiOutputTokens: 400 })).toBeCloseTo(0.0129 + 0.002 + 0.002, 6);
    expect(callCostUsd({ sttSeconds: null, aiInputTokens: null, aiOutputTokens: null })).toBe(0);
    // Metered model cost and Telnyx's bill replace the Haiku guess and add on.
    expect(callCostUsd({ sttSeconds: 60, aiInputTokens: 5000, aiOutputTokens: 900, aiCostUsd: 0.02, telnyxCostUsd: 0.0144 })).toBeCloseTo(0.0043 + 0.02 + 0.0144, 6);
  });

  it("counts every channel of a two-channel recording, and every model call", async () => {
    phoneCall.findUnique.mockResolvedValue({ id: "call3", status: "processing", mode: null, workspaceId: "w1", userId: "u1", lead: { id: "l1", name: "Dana" }, transcript: null, telnyxRecordingId: "rec3", telnyxClientLegId: "leg2", durationSec: 44 });
    telnyx.recordingDownload.mockResolvedValue({ url: "https://telnyx.example/rec3.mp3", seconds: 44 });
    telnyx.deleteRecording.mockResolvedValue(undefined);
    const utterances = [{ channel: 0, start: 0, transcript: "Hello?" }, { channel: 1, start: 1, transcript: "Hi Dana, it's Sam." }];
    const channels = [{ alternatives: [{ transcript: "Hello?" }] }, { alternatives: [{ transcript: "Hi Dana, it's Sam." }] }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ metadata: { duration: 44 }, results: { utterances, channels } }))));
    const { recordAiUsage } = await import("@/lib/ai-usage");
    classify.mockImplementation(async () => {
      recordAiUsage({ model: "claude-haiku-4-5", usage: { input_tokens: 1000, output_tokens: 2 } });
      return { kind: "sales" };
    });
    sales.mockImplementation(async () => {
      recordAiUsage({ model: "claude-sonnet-5", usage: { input_tokens: 4000, output_tokens: 1000 } });
    });
    phoneCall.update.mockClear();

    await runCallProcessing("call3", "America/Chicago", { force: true });

    expect(phoneCall.update.mock.calls.find((c) => "sttSeconds" in c[0].data)?.[0].data.sttSeconds).toBe(88);
    const last = phoneCall.update.mock.calls.at(-1)?.[0].data;
    expect(last).toMatchObject({ aiInputTokens: 5000, aiOutputTokens: 1002 });
    expect(last.aiCostUsd).toBeCloseTo((1000 * 1 + 2 * 5) / 1e6 + (4000 * 2 + 1000 * 10) / 1e6, 9);
    vi.unstubAllGlobals();
  });

  it("writes out a phone recording only when it's processed, then drops the audio", async () => {
    phoneCall.findUnique.mockResolvedValue({ id: "call1", status: "processing", mode: "cold", workspaceId: "w1", userId: "u1", lead: { id: "l1" }, transcript: null, telnyxRecordingId: "rec1", durationSec: 95 });
    telnyx.recordingDownload.mockResolvedValue({ url: "https://telnyx.example/rec1.mp3", seconds: 95 });
    telnyx.deleteRecording.mockResolvedValue(undefined);
    const deepgram = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ metadata: { duration: 95 }, results: { utterances: [{ speaker: 0, transcript: "Hi, is this Dana?" }, { speaker: 1, transcript: "Speaking." }] } })),
    );
    vi.stubGlobal("fetch", deepgram);

    await runCallProcessing("call1", "America/Chicago");

    expect(JSON.parse(deepgram.mock.calls[0][1].body)).toEqual({ url: "https://telnyx.example/rec1.mp3" });
    expect(phoneCall.update).toHaveBeenCalledWith({
      where: { id: "call1" },
      data: { transcript: "Speaker 1: Hi, is this Dana?\nSpeaker 2: Speaking.", sttSeconds: 95, durationSec: 95, telnyxRecordingId: null },
    });
    expect(telnyx.deleteRecording).toHaveBeenCalledWith("rec1");
    expect(cold.mock.calls[0][0]).toMatchObject({ phoneCallId: "call1", transcript: "Speaker 1: Hi, is this Dana?\nSpeaker 2: Speaking." });
    vi.unstubAllGlobals();
  });

  it("keeps the recording for a day when nothing was heard", async () => {
    phoneCall.findUnique.mockResolvedValue({ id: "call2", status: "processing", mode: "cold", workspaceId: "w1", userId: "u1", lead: { id: "l1" }, transcript: null, telnyxRecordingId: "rec2", durationSec: 62 });
    phoneCall.update.mockClear();
    telnyx.deleteRecording.mockClear();
    telnyx.recordingDownload.mockResolvedValue({ url: "https://telnyx.example/rec2.mp3", seconds: 62 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ metadata: { duration: 62 }, results: { utterances: [] } }))));

    await runCallProcessing("call2", "America/Chicago");

    expect(phoneCall.update.mock.calls[0][0].data).toMatchObject({ transcript: "", telnyxRecordingId: "rec2" });
    expect(phoneCall.update.mock.calls[1][0].data).toMatchObject({ status: "skipped", extracted: { skipped: "no_speech" } });
    expect(telnyx.deleteRecording).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("works out cold or sales when nobody picked, and never auto-sends a contract it guessed", async () => {
    const call = { id: "call3", status: "processing", mode: "auto", workspaceId: "w1", userId: "u1", lead: { id: "l1", name: "Dana" }, transcript: "Speaker 1: Hi Dana.\nSpeaker 2: Hi.", telnyxRecordingId: null, durationSec: 120 };
    phoneCall.update.mockClear();
    notify.mockResolvedValue(undefined);
    // The notification points at the lead the call ended up on.
    cold.mockResolvedValue({ leadId: "l1", leadName: "Dana", matched: false });

    phoneCall.findUnique.mockResolvedValue(call);
    classify.mockResolvedValue({ kind: "cold", inputTokens: 900, outputTokens: 1 });
    await runCallProcessing("call3", "America/Chicago", { auto: true });
    expect(phoneCall.update).toHaveBeenCalledWith({ where: { id: "call3" }, data: { mode: "cold" } });
    expect(cold).toHaveBeenLastCalledWith(expect.objectContaining({ phoneCallId: "call3" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", linkUrl: "/leads/l1" }));

    phoneCall.findUnique.mockResolvedValue(call);
    classify.mockResolvedValue({ kind: "sales", inputTokens: 900, outputTokens: 1 });
    await runCallProcessing("call3", "America/Chicago", { auto: true });
    expect(sales).toHaveBeenCalledWith("call3", { draftOnly: true });

    // A rep who picked "Sales call" in the inbox keeps the workspace's auto-send.
    phoneCall.findUnique.mockResolvedValue({ ...call, mode: "sales" });
    classify.mockClear();
    await runCallProcessing("call3", "America/Chicago");
    expect(classify).not.toHaveBeenCalled();
    expect(sales).toHaveBeenLastCalledWith("call3", { draftOnly: false });
  });

  it("hands back a call whose processing was cut off as failed, so it can be tried again", async () => {
    const now = new Date("2026-11-04T12:00:00Z");
    phoneCall.updateMany.mockReset().mockResolvedValue({ count: 1 });
    phoneCall.findMany.mockReset().mockResolvedValue([]);

    expect(await failStuckCalls({ workspaceId: "w1", userId: "u1" }, now)).toBe(1);
    expect(phoneCall.updateMany).toHaveBeenLastCalledWith({
      where: { workspaceId: "w1", userId: "u1", status: "processing", updatedAt: { lt: new Date("2026-11-04T11:45:00Z") } },
      data: { status: "failed" },
    });

    // The daily cleanup does it across the board, before it drops what's a day old.
    await discardStaleCalls(now);
    expect(phoneCall.updateMany.mock.calls.at(-1)?.[0]).toEqual({ where: { status: "processing", updatedAt: { lt: new Date("2026-11-04T11:45:00Z") } }, data: { status: "failed" } });
  });
});
