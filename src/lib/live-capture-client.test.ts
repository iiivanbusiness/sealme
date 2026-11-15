import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, discardLocalCapture, discardLiveCall } = vi.hoisted(() => ({
  invoke: vi.fn(),
  discardLocalCapture: vi.fn(),
  discardLiveCall: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/app/(app)/deals/new/actions", () => ({ discardLocalCapture }));
vi.mock("@/app/(app)/deals/new/live-actions", () => ({ discardLiveCall, liveCallState: vi.fn() }));

import {
  stopCapture,
  discardCapture,
  readCaptureSession,
  captureEndedAs,
  LOCAL_CAPTURE_STORAGE_KEY,
  LOCAL_CAPTURE_ENDED_KEY,
  LOCAL_CAPTURE_EVENT,
  type CaptureSession,
} from "./live-capture-client";

// The browser bits these use, in a node test: one window's localStorage and
// the events it dispatches.
const store = new Map<string, string>();
const dispatched: string[] = [];
vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
});
vi.stubGlobal("window", {
  dispatchEvent: (e: Event) => {
    dispatched.push(e.type);
    return true;
  },
});

const call1: CaptureSession = { phoneCallId: "call-1", leadId: "lead-1", token: "token-1", startedAt: 1 };
const call2: CaptureSession = { phoneCallId: "call-2", leadId: "lead-2", token: "token-2", startedAt: 2 };
const dealCall: CaptureSession = { dealId: "deal-1", token: "token-d", startedAt: 3 };
const save = (session: CaptureSession) => store.set(LOCAL_CAPTURE_STORAGE_KEY, JSON.stringify(session));

beforeEach(() => {
  store.clear();
  dispatched.length = 0;
  invoke.mockReset();
  discardLocalCapture.mockReset();
  discardLiveCall.mockReset();
});

describe("stopCapture", () => {
  it("stops the call this window shows and forgets it as finished", async () => {
    save(call1);
    invoke.mockResolvedValue({ ok: true });
    expect(await stopCapture(call1)).toEqual({});
    expect(invoke).toHaveBeenCalledWith("stop_local_capture_and_upload", { token: "token-1" });
    expect(readCaptureSession()).toBeNull();
    expect(captureEndedAs(call1)).toBe("finished");
    expect(dispatched).toEqual([LOCAL_CAPTURE_EVENT]);
  });

  it("leaves the next call alone when the one shown already ended elsewhere", async () => {
    // Call 1 was finished in the main window and call 2 started; the panel
    // still shows call 1.
    save(call2);
    expect(await stopCapture(call1)).toEqual({ error: "That call already ended", stale: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(readCaptureSession()).toEqual(call2);
    expect(dispatched).toEqual([]);
  });

  it("does nothing when no call is recording any more", async () => {
    expect(await stopCapture(call1)).toEqual({ error: "That call already ended", stale: true });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the session when the upload fails, so Stop can be tried again", async () => {
    save(call1);
    invoke.mockResolvedValue({ ok: false, error: "Upload failed" });
    expect(await stopCapture(call1)).toEqual({ error: "Upload failed" });
    expect(readCaptureSession()).toEqual(call1);
    expect(dispatched).toEqual([]);
  });

  it("never forgets a session that took over while the upload ran", async () => {
    save(call1);
    invoke.mockImplementation(async () => {
      save(call2);
      return { ok: true };
    });
    expect(await stopCapture(call1)).toEqual({});
    expect(readCaptureSession()).toEqual(call2);
  });
});

describe("discardCapture", () => {
  it("leaves the recording and the server alone for a call that already ended", async () => {
    save(call2);
    expect(await discardCapture(call1)).toEqual({ error: "That call already ended", stale: true });
    expect(invoke).not.toHaveBeenCalled();
    expect(discardLiveCall).not.toHaveBeenCalled();
    expect(readCaptureSession()).toEqual(call2);
  });

  it("stops the recording, throws the call away and forgets it as discarded", async () => {
    save(call1);
    invoke.mockResolvedValue(undefined);
    expect(await discardCapture(call1)).toEqual({});
    expect(invoke).toHaveBeenCalledWith("discard_local_capture");
    expect(discardLiveCall).toHaveBeenCalledWith("call-1", "token-1");
    expect(readCaptureSession()).toBeNull();
    expect(captureEndedAs(call1)).toBe("discarded");
  });

  it("closes a deal's call through the deal", async () => {
    save(dealCall);
    invoke.mockResolvedValue(undefined);
    expect(await discardCapture(dealCall)).toEqual({});
    expect(discardLocalCapture).toHaveBeenCalledWith("deal-1", "token-d");
    expect(discardLiveCall).not.toHaveBeenCalled();
  });

  it("keeps the session when SealMe couldn't close the call", async () => {
    save(call1);
    invoke.mockResolvedValue(undefined);
    discardLiveCall.mockRejectedValue(new Error("offline"));
    const result = await discardCapture(call1);
    expect(result.error).toMatch(/couldn't close the call/);
    expect(result.stale).toBeUndefined();
    expect(readCaptureSession()).toEqual(call1);
  });
});

describe("captureEndedAs", () => {
  it("only answers for the call that ended, and never keeps its token", async () => {
    save(call1);
    invoke.mockResolvedValue({ ok: true });
    await stopCapture(call1);
    expect(captureEndedAs(call2)).toBeNull();
    expect(store.get(LOCAL_CAPTURE_ENDED_KEY)).not.toContain("token-1");
  });
});
