import { describe, expect, it, vi } from "vitest";

const { phoneCall, executeRaw, deal, cold, build, buildFailed, classify, notify, telnyx } = vi.hoisted(() => ({
  phoneCall: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  executeRaw: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 1),
  // No proposal or contract was made on these calls while they recorded,
  // unless a test says so.
  deal: { findFirst: vi.fn<(args?: unknown) => Promise<{ id: string } | null>>(async () => null) },
  cold: vi.fn(),
  build: vi.fn(),
  buildFailed: vi.fn(),
  classify: vi.fn(),
  notify: vi.fn(),
  telnyx: { recordingDownload: vi.fn(), deleteRecording: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ prisma: { phoneCall, deal, $executeRaw: executeRaw } }));
vi.mock("@/lib/error-report", () => ({ reportError: async () => {} }));
vi.mock("@/lib/crm-call-sync", () => ({ pushCallToCrm: async () => {} }));
vi.mock("@/lib/call-deal", () => ({ buildDealFromCall: build, tellRepDealFailed: buildFailed }));
vi.mock("@/lib/cold-call", () => ({ applyColdCall: cold }));
vi.mock("@/lib/call-kind", () => ({ classifyCallKind: classify }));
vi.mock("@/lib/notifications", () => ({ createNotification: notify }));
vi.mock("@/lib/telnyx", () => telnyx);

import { addCallAiUsage, callCostUsd, discardStaleCalls, failStuckCalls, runCallProcessing, skipReason, speakerCount } from "./call-inbox";

// What each model-use write added to a call: tokens in, tokens out, cost.
function usageAdded() {
  return executeRaw.mock.calls
    .filter(([sql]) => (sql as string[]).join("?").includes('"aiInputTokens" = COALESCE("aiInputTokens", 0) +'))
    .map(([, inputTokens, outputTokens, costUsd, callId]) => ({ inputTokens, outputTokens, costUsd: costUsd as number, callId }));
}

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
    build.mockImplementation(async () => {
      recordAiUsage({ model: "claude-sonnet-5", usage: { input_tokens: 4000, output_tokens: 1000 } });
      return { dealId: "d1" };
    });
    phoneCall.update.mockClear();
    executeRaw.mockClear();

    await runCallProcessing("call3", "America/Chicago", { force: true });

    expect(phoneCall.update.mock.calls.find((c) => "sttSeconds" in c[0].data)?.[0].data.sttSeconds).toBe(88);
    // The notes (sorting included) are added when they're saved, and the
    // contract adds its own on top once it's made. Added, never set: a live
    // call's readings while it recorded are already on it.
    const costs = usageAdded();
    expect(costs).toHaveLength(2);
    expect(costs[0]).toMatchObject({ inputTokens: 1000, outputTokens: 2, callId: "call3" });
    expect(costs[0].costUsd).toBeCloseTo((1000 * 1 + 2 * 5) / 1e6, 9);
    expect(costs[1]).toMatchObject({ inputTokens: 4000, outputTokens: 1000, callId: "call3" });
    expect(costs[1].costUsd).toBeCloseTo((4000 * 2 + 1000 * 10) / 1e6, 9);
    expect(phoneCall.update.mock.calls.some((c) => "aiInputTokens" in c[0].data)).toBe(false);
    vi.unstubAllGlobals();
  });

  it("adds a pass's model use to the call's, even while it's still empty, and skips a pass that used none", async () => {
    executeRaw.mockClear();
    await addCallAiUsage("pc1", { inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(executeRaw).not.toHaveBeenCalled();
    await addCallAiUsage("pc1", { inputTokens: 1200, outputTokens: 300, costUsd: 0.0054 });
    const [sql] = executeRaw.mock.calls[0] as [string[]];
    // COALESCE: Prisma's increment leaves a null column null.
    expect(sql.join("?")).toContain('"aiCostUsd" = COALESCE("aiCostUsd", 0) +');
    expect(usageAdded()).toEqual([{ inputTokens: 1200, outputTokens: 300, costUsd: 0.0054, callId: "pc1" }]);
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
    expect(cold.mock.calls.at(-1)?.[0]).toMatchObject({ phoneCallId: "call1", transcript: "Speaker 1: Hi, is this Dana?\nSpeaker 2: Speaking." });
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
    const call = { id: "call3", status: "processing", mode: "auto", wantsProposal: false, wantsContract: false, workspaceId: "w1", userId: "u1", lead: { id: "l1", name: "Dana" }, transcript: "Speaker 1: Hi Dana.\nSpeaker 2: Hi.", telnyxRecordingId: null, durationSec: 120 };
    phoneCall.update.mockClear();
    notify.mockResolvedValue(undefined);
    build.mockReset().mockResolvedValue({ dealId: "d1" });
    // The notification points at the lead the call ended up on.
    cold.mockResolvedValue({ leadId: "l1", leadName: "Dana", matched: false });

    phoneCall.findUnique.mockResolvedValue(call);
    classify.mockResolvedValue({ kind: "cold", inputTokens: 900, outputTokens: 1 });
    await runCallProcessing("call3", "America/Chicago", { auto: true });
    expect(phoneCall.update).toHaveBeenCalledWith({ where: { id: "call3" }, data: { mode: "cold" } });
    expect(cold).toHaveBeenLastCalledWith(expect.objectContaining({ phoneCallId: "call3", mode: "cold", closesMeeting: false }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", linkUrl: "/leads/l1" }));
    expect(build).not.toHaveBeenCalled();

    // A sales call still gets its notes, then a contract the rep has to send.
    phoneCall.findUnique.mockResolvedValue(call);
    classify.mockResolvedValue({ kind: "sales", inputTokens: 900, outputTokens: 1 });
    await runCallProcessing("call3", "America/Chicago", { auto: true });
    expect(cold).toHaveBeenLastCalledWith(expect.objectContaining({ phoneCallId: "call3", mode: "sales", closesMeeting: true }));
    expect(build).toHaveBeenCalledWith("call3", "contract");

    // A rep who picked "Sales call" in the inbox gets the same draft to send.
    phoneCall.findUnique.mockResolvedValue({ ...call, mode: "sales" });
    classify.mockClear();
    await runCallProcessing("call3", "America/Chicago");
    expect(classify).not.toHaveBeenCalled();
    expect(build).toHaveBeenLastCalledWith("call3", "contract");
  });

  it("makes the proposal and contract the call asked for, after its notes, on the lead it landed on", async () => {
    const call = { id: "call4", status: "processing", mode: "notes", wantsProposal: true, wantsContract: true, workspaceId: "w1", userId: "u1", lead: { id: "l9", name: "New lead from a call" }, transcript: "Speaker 1: Hi.\nSpeaker 2: Hi.", telnyxRecordingId: null, durationSec: 300 };
    const order: string[] = [];
    phoneCall.findUnique.mockResolvedValue(call);
    classify.mockClear();
    cold.mockReset().mockImplementation(async () => {
      order.push("notes");
      return { leadId: "l2", leadName: "Dana", matched: true };
    });
    build.mockReset().mockImplementation(async (_id: string, kind: string) => {
      order.push(kind);
      if (kind === "proposal") throw new Error("This workspace has no proposal templates yet");
      return { dealId: "d2" };
    });
    phoneCall.update.mockClear();

    await runCallProcessing("call4", "America/Chicago", { force: true });

    expect(classify).not.toHaveBeenCalled();
    expect(order).toEqual(["notes", "proposal", "contract"]);
    expect(build).toHaveBeenLastCalledWith("call4", "contract");
    // The proposal that couldn't be made is the rep's to hear about; the call
    // itself is processed, not failed.
    expect(buildFailed).toHaveBeenCalledWith(expect.objectContaining({ leadId: "l2", kind: "proposal", reason: "This workspace has no proposal templates yet" }));
    expect(phoneCall.update.mock.calls.some((c) => c[0].data.status === "failed")).toBe(false);

    // The proposal that couldn't be made is marked on the call, next to
    // what the notes found.
    expect(phoneCall.update).toHaveBeenCalledWith({ where: { id: "call4" }, data: { extracted: { docFailed: { proposal: true } } } });

    // A contract made while the call recorded isn't made again at the end.
    order.length = 0;
    deal.findFirst.mockImplementation(async (args: unknown) => ((args as { where: { kind: string } }).where.kind === "contract" ? { id: "d-live" } : null));
    await runCallProcessing("call4", "America/Chicago", { force: true });
    expect(order).toEqual(["notes", "proposal"]);
    deal.findFirst.mockImplementation(async () => null);
  });

  it("writes up a live call that made a contract mid-call as the sales call it was, without making the contract again", async () => {
    // Create contract on the recording panel asks for one on the call (see startLiveDeal).
    const call = { id: "call6", status: "processing", mode: "notes", wantsProposal: false, wantsContract: true, workspaceId: "w1", userId: "u1", lead: { id: "l1", name: "Dana" }, transcript: "Client: Hi.\nYou: Hi.", telnyxRecordingId: null, durationSec: 600 };
    phoneCall.findUnique.mockReset().mockResolvedValue(call);
    cold.mockReset().mockResolvedValue({ leadId: "l1", leadName: "Dana", matched: false });
    build.mockReset();
    classify.mockClear();
    deal.findFirst.mockImplementation(async () => ({ id: "d-live" }));

    await runCallProcessing("call6", "America/Chicago", { force: true });

    expect(classify).not.toHaveBeenCalled();
    expect(cold).toHaveBeenCalledWith(expect.objectContaining({ mode: "sales", closesMeeting: true, deferCompleted: true }));
    expect(build).not.toHaveBeenCalled();
    deal.findFirst.mockImplementation(async () => null);

    // One that has to be made at the end (trashed mid-call) is a draft for the
    // rep: nothing from a live call is sent on its own.
    phoneCall.findUnique.mockResolvedValue({ ...call, source: "desktop" });
    build.mockResolvedValue({ dealId: "d-new" });
    await runCallProcessing("call6", "America/Chicago", { force: true });
    expect(build).toHaveBeenCalledWith("call6", "contract");
  });

  it("marks a document it couldn't make on the call, keeping what the notes found and any other one marked", async () => {
    const call = { id: "call5", status: "processing", mode: "notes", wantsProposal: false, wantsContract: true, workspaceId: "w1", userId: "u1", lead: { id: "l1", name: "Dana" }, transcript: "Speaker 1: Hi.\nSpeaker 2: Hi.", telnyxRecordingId: null, durationSec: 300 };
    phoneCall.findUnique.mockReset().mockResolvedValueOnce(call).mockResolvedValueOnce({ extracted: { outcome: "interested", summary: "Wants 5 seats", docFailed: { proposal: true } } });
    phoneCall.update.mockClear();
    cold.mockReset().mockResolvedValue({ leadId: "l1", leadName: "Dana", matched: false });
    build.mockReset().mockRejectedValue(new Error("Anthropic 529"));
    buildFailed.mockClear();

    await runCallProcessing("call5", "America/Chicago", { force: true });

    expect(phoneCall.update).toHaveBeenCalledWith({
      where: { id: "call5" },
      data: { extracted: { outcome: "interested", summary: "Wants 5 seats", docFailed: { proposal: true, contract: true } } },
    });
    expect(buildFailed).toHaveBeenCalledWith(expect.objectContaining({ kind: "contract", reason: "Something went wrong reading the terms" }));
    expect(phoneCall.update.mock.calls.some((c) => c[0].data.status === "failed")).toBe(false);
  });

  it("gives a failed call a full day from when it failed before it's thrown away", async () => {
    const now = new Date("2026-11-04T12:00:00Z");
    phoneCall.updateMany.mockReset().mockResolvedValue({ count: 1 });
    phoneCall.findMany.mockReset().mockResolvedValue([]);

    await discardStaleCalls(now);
    const dayAgo = new Date("2026-11-03T12:00:00Z");
    // Waiting, ringing or recording calls go a day after they started; a
    // failed one a day after it failed (an abandoned live call finished and
    // failed in this same cron run isn't dropped with it).
    expect(phoneCall.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ status: { in: ["pending", "recording", "dialing"] }, startedAt: { lt: dayAgo } }, { status: "failed", updatedAt: { lt: dayAgo } }],
      NOT: { source: "desktop", status: "recording" },
    });
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
    // A call the desktop app was recording live is never thrown away here:
    // it's finished from what it heard (see finishAbandonedLiveCalls).
    expect(phoneCall.findMany.mock.calls[0][0].where).toMatchObject({ NOT: { source: "desktop", status: "recording" } });
  });
});
