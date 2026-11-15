import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, refreshLeadPipeline, stageAfterOutcome } = vi.hoisted(() => ({
  prisma: {
    task: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    phoneCall: { create: vi.fn() },
    lead: { update: vi.fn() },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops)),
  },
  refreshLeadPipeline: vi.fn(),
  stageAfterOutcome: vi.fn((): string | null => null),
}));
vi.mock("@/lib/db", () => ({ prisma }));
vi.mock("@/lib/webhook-events", () => ({
  dispatchLeadsUpdated: vi.fn(),
  dispatchCallCompleted: vi.fn(),
  dispatchTasksCompleted: vi.fn(),
  dispatchMeetingsBooked: vi.fn(),
  leadChanges: (leadId: string) => ({ leadId, changed: [], previousStage: null }),
}));
vi.mock("@/lib/task-notify", () => ({ notifyTasksAssigned: vi.fn() }));
vi.mock("@/lib/cold-call", () => ({ stageAfterOutcome }));
vi.mock("@/lib/webhooks", () => ({}));
vi.mock("@/lib/error-report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/lead-pipeline", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/lead-pipeline")>()), refreshLeadPipeline }));

import type { Lead } from "@/generated/prisma/client";
import { bookMeeting, logCallOutcome, parseCallInput, parseMeetingInput, parseTaskPatch, revived } from "./api-activity";

describe("parseCallInput", () => {
  it("takes an outcome on its own", () => {
    const r = parseCallInput({ outcome: "no_answer", externalId: 9912, durationSec: "41.6", toNumber: "+1 (202) 555-0161", startedAt: "2026-10-01T13:00:00Z" });
    expect("data" in r && r.data).toMatchObject({ outcome: "no_answer", externalId: "9912", durationSec: 42, toNumber: "+12025550161", kind: null });
    expect("data" in r && r.data.startedAt.toISOString()).toBe("2026-10-01T13:00:00.000Z");
  });

  it("takes a transcript or a recording link without an outcome", () => {
    expect("data" in parseCallInput({ transcript: "Rep: Hi\nSam: Hello" })).toBe(true);
    expect("data" in parseCallInput({ recordingUrl: "https://dialer.example.com/rec/1.mp3", kind: "sales" })).toBe(true);
  });

  it("explains what's wrong", () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{}, /outcome, or a transcript/],
      [{ outcome: "booked" }, /outcome/],
      [{ recordingUrl: "http://dialer.example.com/1.mp3" }, /https/],
      [{ outcome: "voicemail", startedAt: "yesterday" }, /startedAt/],
      [{ outcome: "voicemail", startedAt: "2099-01-01T00:00:00Z" }, /future/],
      [{ outcome: "voicemail", durationSec: -3 }, /durationSec/],
      [{ outcome: "voicemail", kind: "warm" }, /kind/],
    ];
    for (const [body, msg] of cases) {
      const r = parseCallInput(body);
      expect("error" in r && r.error, JSON.stringify(body)).toMatch(msg);
    }
  });
});

describe("parseMeetingInput", () => {
  it("needs a day, and checks time and zone", () => {
    expect(parseMeetingInput({ date: "2026-10-20", time: "14:30", timeZone: "America/Chicago", note: " Demo " })).toEqual({
      data: { date: "2026-10-20", time: "14:30", timeZone: "America/Chicago", note: "Demo", externalId: null },
    });
    expect("error" in parseMeetingInput({ time: "14:30" })).toBe(true);
    expect("error" in parseMeetingInput({ date: "2026-10-20", time: "2pm" })).toBe(true);
    expect("error" in parseMeetingInput({ date: "2026-10-20", timeZone: "Mars/Olympus" })).toBe(true);
  });
});

describe("parseTaskPatch", () => {
  it("only touches what was sent, and null clears time and note", () => {
    expect(parseTaskPatch({ time: null, note: null })).toEqual({ data: { dueTime: null, note: null } });
    const r = parseTaskPatch({ date: "2026-10-21", status: "skipped" });
    expect("data" in r && r.data.dueDate?.toISOString()).toBe("2026-10-21T00:00:00.000Z");
    expect("data" in r && r.data.status).toBe("skipped");
    expect("error" in parseTaskPatch({ status: "cancelled" })).toBe(true);
  });
});

describe("A call or meeting sent in through the API", () => {
  const lead = (over: Partial<Lead>) => ({ id: "l1", name: "Dana", stage: "contacted", ownerId: "u1", phone: null, lastContactedAt: null, lastActivityAt: new Date("2026-11-10T12:00:00Z"), pipelineStage: "lost", ...over }) as Lead;
  const input = (startedAt: string) => ({ externalId: null, outcome: "no_answer", summary: null, transcript: null, recordingUrl: null, startedAt: new Date(startedAt), durationSec: null, kind: null, toNumber: null });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.task.findFirst.mockResolvedValue(null);
    prisma.phoneCall.create.mockResolvedValue({ id: "c1" });
    prisma.task.create.mockResolvedValue({ id: "t1" });
  });

  it("brings a set-aside lead back only when it's the newest thing on it", () => {
    const at = new Date("2026-11-12T09:00:00Z");
    expect(revived(lead({}), at)).toEqual({ lastActivityAt: at, pipelineStage: "new" });
    expect(revived(lead({ pipelineStage: "not_signed" }), at)).toEqual({ lastActivityAt: at, pipelineStage: "new" });
    expect(revived(lead({ pipelineStage: "proposal_sent" }), at)).toEqual({ lastActivityAt: at });
    expect(revived(lead({ lastActivityAt: null }), at)).toEqual({ lastActivityAt: at, pipelineStage: "new" });
    // An older call sent in late: marked lost since, it stays lost.
    expect(revived(lead({}), new Date("2026-11-01T09:00:00Z"))).toEqual({});
  });

  it("works the stage out from the lead's documents after reviving it", async () => {
    await logCallOutcome({ workspaceId: "w1", lead: lead({}), repId: null, input: input("2026-11-12T09:00:00Z") });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: expect.objectContaining({ pipelineStage: "new" }) });
    // A proposal still out shows Proposal sent, not New.
    expect(refreshLeadPipeline).toHaveBeenCalledWith("l1");
  });

  it("leaves a lead marked lost since an older call alone", async () => {
    await logCallOutcome({ workspaceId: "w1", lead: lead({}), repId: null, input: input("2026-11-01T09:00:00Z") });
    expect(prisma.lead.update.mock.calls[0][0].data).not.toHaveProperty("pipelineStage");
    expect(prisma.lead.update.mock.calls[0][0].data).not.toHaveProperty("lastActivityAt");
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
  });

  it("takes a lead that's not interested off Active, like stage lost through PATCH", async () => {
    stageAfterOutcome.mockReturnValueOnce("lost");
    const notInterested = { ...input("2026-11-12T09:00:00Z"), outcome: "not_interested" };
    await logCallOutcome({ workspaceId: "w1", lead: lead({ pipelineStage: "proposal_sent" }), repId: null, input: notInterested });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ stage: "lost", pipelineStage: "lost" });

    // Lost already and set aside: the call doesn't bring it back.
    vi.clearAllMocks();
    prisma.phoneCall.create.mockResolvedValue({ id: "c2" });
    await logCallOutcome({ workspaceId: "w1", lead: lead({ stage: "lost", pipelineStage: "lost" }), repId: null, input: notInterested });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ pipelineStage: "lost" });
  });

  it("leaves a lead with newer activity on Active when an older not interested call comes in late", async () => {
    stageAfterOutcome.mockReturnValueOnce("lost");
    const late = { ...input("2026-11-01T09:00:00Z"), outcome: "not_interested" };
    await logCallOutcome({ workspaceId: "w1", lead: lead({ pipelineStage: "proposal_sent" }), repId: null, input: late });
    expect(prisma.lead.update.mock.calls[0][0].data).not.toHaveProperty("pipelineStage");
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
  });

  it("makes a lost lead a call brings back contacted for the API, unless the outcome moved it", async () => {
    await logCallOutcome({ workspaceId: "w1", lead: lead({ stage: "lost" }), repId: null, input: input("2026-11-12T09:00:00Z") });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ stage: "contacted", pipelineStage: "new" });

    vi.clearAllMocks();
    prisma.phoneCall.create.mockResolvedValue({ id: "c2" });
    stageAfterOutcome.mockReturnValueOnce("interested");
    await logCallOutcome({ workspaceId: "w1", lead: lead({ stage: "lost" }), repId: null, input: { ...input("2026-11-12T09:00:00Z"), outcome: "interested" } });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ stage: "interested", pipelineStage: "new" });

    // Not interested again: still lost.
    vi.clearAllMocks();
    prisma.phoneCall.create.mockResolvedValue({ id: "c3" });
    await logCallOutcome({ workspaceId: "w1", lead: lead({ stage: "lost" }), repId: null, input: { ...input("2026-11-12T09:00:00Z"), outcome: "not_interested" } });
    expect(prisma.lead.update.mock.calls[0][0].data).toMatchObject({ pipelineStage: "lost" });
    expect(prisma.lead.update.mock.calls[0][0].data).not.toHaveProperty("stage");
  });

  it("leaves a client on Clients when it's not interested", async () => {
    const notInterested = { ...input("2026-11-12T09:00:00Z"), outcome: "not_interested" };
    await logCallOutcome({ workspaceId: "w1", lead: lead({ stage: "converted", pipelineStage: "client", isClient: true }), repId: null, input: notInterested });
    expect(prisma.lead.update.mock.calls[0][0].data).not.toHaveProperty("pipelineStage");
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
  });

  it("revives a lead a meeting was booked with, then works its stage out", async () => {
    await bookMeeting({ workspaceId: "w1", lead: lead({}), rep: null, input: { date: "2026-11-20", time: null, timeZone: null, note: null, externalId: null }, actorName: "Dialer" });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: "l1" }, data: expect.objectContaining({ pipelineStage: "new" }) });
    expect(refreshLeadPipeline).toHaveBeenCalledWith("l1");

    vi.clearAllMocks();
    prisma.task.create.mockResolvedValue({ id: "t2" });
    await bookMeeting({ workspaceId: "w1", lead: lead({ pipelineStage: "contract_sent" }), rep: null, input: { date: "2026-11-20", time: null, timeZone: null, note: null, externalId: null }, actorName: "Dialer" });
    expect(refreshLeadPipeline).not.toHaveBeenCalled();
  });
});
