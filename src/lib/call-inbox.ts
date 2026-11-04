import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { applyColdCall } from "@/lib/cold-call";
import { INPUT_USD_PER_MTOK, OUTPUT_USD_PER_MTOK } from "@/lib/extract-cold-call";
import { meterAiUsage } from "@/lib/ai-usage";
import { reportError } from "@/lib/error-report";
import { pushCallToCrm } from "@/lib/crm-call-sync";
import { applySalesCall } from "@/lib/sales-call";
import { deleteRecording, isTelnyxConfigured, recordingDownload, telnyxCallCost } from "@/lib/telnyx";
import { DUAL_CHANNEL_LISTEN_PARAMS, RECORDING_LISTEN_PARAMS, transcriptFromChannels, transcriptFromListenResponse } from "@/lib/recording-transcript";
import { classifyCallKind } from "@/lib/call-kind";
import { createNotification } from "@/lib/notifications";
import { isValidTimeZone } from "@/lib/tasks";
import { dispatchCallCompleted } from "@/lib/webhook-events";

// Calls shorter than this aren't worth a model call: nobody picked up, or
// the line dropped.
export const MIN_PROCESS_SECONDS = 30;
// Calls nobody acts on are dropped after a day, so a transcript doesn't sit
// around unasked for (see the daily cron).
export const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
// Processing runs in after(), which a timeout, a deploy or a crash can cut
// off before it marks the call either way. Nothing runs anywhere near this
// long, so a call still processing this long after it last changed isn't
// being worked on anymore.
export const PROCESSING_STUCK_MS = 15 * 60 * 1000;
// Deepgram Nova-3, prerecorded, pay as you go. Checked against the Deepgram
// dashboard when call costs were first compared (Phase 3.4).
export const STT_USD_PER_MINUTE = 0.0043;

export const SKIP_LABEL: Record<string, string> = {
  too_short: "Under 30 seconds",
  one_speaker: "Only one voice (likely voicemail)",
  no_speech: "Nothing was said",
  not_recorded: "Not recorded (recording rules for the lead's state)",
  no_pickup: "They didn't pick up",
  rep_missed: "You didn't answer SealMe's call",
  cancelled: "Cancelled before they picked up",
  dial_failed: "SealMe couldn't place the call",
  record_failed: "SealMe couldn't start recording",
};

// Channels of SealMe's own two-channel recordings, recorded on the client's
// leg: what came from the client, then what went to them (the rep).
const DUAL_CHANNEL_LABELS = ["Client", "Rep"];

// How many different people talk in a transcript. Diarized recordings
// label turns "Speaker 1:", the desktop recorder "Client:" / "You:".
// 0 when the transcript has no labels at all, which says nothing.
export function speakerCount(transcript: string): number {
  const speakers = new Set<string>();
  for (const line of transcript.split("\n")) {
    const label = line.match(/^([^:\n]{1,40}):\s/)?.[1]?.trim();
    if (label) speakers.add(label.toLowerCase());
  }
  return speakers.size;
}

// A voicemail is a greeting and maybe a short message. Past this, one
// voice in the transcript more likely means the speaker split failed (it
// does on merged phone lines) than that nobody picked up.
const VOICEMAIL_MAX_SECONDS = 75;

// Why a call shouldn't go to the model, if it shouldn't.
export function skipReason(call: { durationSec: number | null; transcript: string | null }): "too_short" | "one_speaker" | null {
  if (call.durationSec !== null && call.durationSec < MIN_PROCESS_SECONDS) return "too_short";
  if (call.transcript && speakerCount(call.transcript) === 1 && (call.durationSec === null || call.durationSec < VOICEMAIL_MAX_SECONDS)) return "one_speaker";
  return null;
}

// What a call cost us: transcription by the billed minute, the models it
// took, and Telnyx once its records are in. Calls from before the models
// were metered were Haiku only, so their tokens are priced as Haiku.
export function callCostUsd(call: {
  sttSeconds: number | null;
  aiInputTokens: number | null;
  aiOutputTokens: number | null;
  aiCostUsd?: number | null;
  telnyxCostUsd?: number | null;
}): number {
  const stt = ((call.sttSeconds ?? 0) / 60) * STT_USD_PER_MINUTE;
  const ai = call.aiCostUsd ?? ((call.aiInputTokens ?? 0) * INPUT_USD_PER_MTOK + (call.aiOutputTokens ?? 0) * OUTPUT_USD_PER_MTOK) / 1_000_000;
  return stt + ai + (call.telnyxCostUsd ?? 0);
}

// Runs in the background after someone clicks Process, or by itself once a
// phone call's recording is in (auto): the call is already marked
// processing with its lead. Short calls and one-voice calls are set aside
// without a model call; anything that throws is marked failed so it can be
// retried from the inbox. force runs the model even on a call that would be
// set aside ("Process anyway", when the speaker split was wrong). A call
// whose kind nobody picked is sorted into cold or sales from what was said.
export async function runCallProcessing(callId: string, timeZone: string, options: { force?: boolean; auto?: boolean } = {}): Promise<void> {
  let call = await prisma.phoneCall.findUnique({ where: { id: callId }, include: { lead: true } });
  if (!call || call.status !== "processing") return;
  try {
    if (!call.transcript && (call.telnyxRecordingId || call.recordingUrl)) {
      const heard = call.telnyxRecordingId
        ? await transcribePhoneRecording(call.id, call.telnyxRecordingId, call.durationSec, Boolean(call.telnyxClientLegId))
        : await transcribeRecordingUrl(call.id, call.recordingUrl!, call.durationSec);
      call = { ...call, ...heard };
      if (!call.transcript) {
        await prisma.phoneCall.update({ where: { id: callId }, data: { status: "skipped", connected: false, extracted: { skipped: "no_speech" }, processedAt: new Date() } });
        await dispatchCallCompleted(call.workspaceId, callId);
        return;
      }
    }
    const skip = options.force ? null : skipReason(call);
    if (skip) {
      await prisma.phoneCall.update({
        where: { id: callId },
        data: { status: "skipped", connected: false, extracted: { skipped: skip }, processedAt: new Date() },
      });
      await dispatchCallCompleted(call.workspaceId, callId);
      return;
    }
    const { lead, userId, transcript } = call;
    if (!lead || !transcript) throw new Error("This call has no lead or transcript");
    const { workspaceId, mode: picked } = call;
    // Every model call below counts toward this call's cost: sorting it,
    // the notes, and for a sales call the template pick, the deal and the
    // highlights.
    const { usage } = await meterAiUsage(async () => {
      let mode = picked;
      // "notes" is notes only, never a contract: no sorting needed.
      const sorted = mode !== "cold" && mode !== "sales" && mode !== "notes";
      if (sorted) {
        const { kind } = await classifyCallKind(transcript);
        await prisma.phoneCall.update({ where: { id: callId }, data: { mode: kind } });
        mode = kind;
      }
      if (mode === "sales") {
        // SealMe decided this was a sales call: the contract waits for the rep.
        await applySalesCall(callId, { draftOnly: sorted });
      } else {
        // The call can land on a lead already on file instead of the one it came with.
        const saved = await applyColdCall({ workspaceId, userId, lead, transcript, timeZone, phoneCallId: callId });
        if (options.auto && userId) {
          await createNotification({
            workspaceId,
            userId,
            type: "call.saved",
            title: `Notes from your call with ${saved.leadName} are saved`,
            body: "Check them, and fix anything SealMe heard wrong.",
            linkUrl: `/leads/${saved.leadId}`,
          }).catch((err) => reportError(err, "Call saved notification", { callId }));
        }
      }
    });
    await prisma.phoneCall.update({
      where: { id: callId },
      data: { aiInputTokens: usage.inputTokens, aiOutputTokens: usage.outputTokens, aiCostUsd: usage.costUsd },
    });
  } catch (err) {
    await prisma.phoneCall.update({ where: { id: callId }, data: { status: "failed" } }).catch(() => {});
    await reportError(err, "Call processing", { callId, workspaceId: call.workspaceId });
    return;
  }
  // Outside the try: a CRM hiccup must never mark a processed call failed.
  await pushCallToCrm(callId);
}

// A phone call's notes are written as soon as its recording is in: no
// Process click. Runs after the Telnyx webhook has answered.
export async function processPhoneCallAutomatically(callId: string): Promise<void> {
  const call = await prisma.phoneCall.findUnique({ where: { id: callId }, select: { leadId: true, user: { select: { timezone: true } } } });
  if (!call?.leadId) return;
  const { count } = await prisma.phoneCall.updateMany({ where: { id: callId, status: "pending" }, data: { status: "processing" } });
  if (count === 0) return;
  const tz = call.user?.timezone && isValidTimeZone(call.user.timezone) ? call.user.timezone : "America/New_York";
  await runCallProcessing(callId, tz, { auto: true });
}

// A phone call's recording is transcribed only once it's processed
// (Process), and then dropped at Telnyx: SealMe keeps the transcript, not
// the audio.
async function transcribePhoneRecording(
  callId: string,
  recordingId: string,
  durationSec: number | null,
  dualChannel: boolean,
): Promise<{ transcript: string; sttSeconds: number; durationSec: number | null; telnyxRecordingId: string | null }> {
  const { url, seconds } = await recordingDownload(recordingId);
  const language = process.env.DEEPGRAM_LANGUAGE || "en";
  const res = await fetch(`https://api.deepgram.com/v1/listen?${dualChannel ? DUAL_CHANNEL_LISTEN_PARAMS : RECORDING_LISTEN_PARAMS}&language=${language}`, {
    method: "POST",
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const heard = dualChannel ? transcriptFromChannels(json, DUAL_CHANNEL_LABELS) : transcriptFromListenResponse(json);
  // Deepgram bills every channel of a multichannel request.
  const billedSeconds = heard.seconds * (dualChannel ? Math.max(1, json.results?.channels?.length ?? 2) : 1);
  // Nothing heard: the recording stays at Telnyx for the day, so a silent
  // line can be told apart from speech the model missed. The daily cron
  // drops it then.
  const keep = !heard.transcript;
  const saved = { transcript: heard.transcript, sttSeconds: billedSeconds, durationSec: durationSec ?? seconds ?? heard.seconds, telnyxRecordingId: keep ? recordingId : null };
  await prisma.phoneCall.update({ where: { id: callId }, data: saved });
  if (!keep) await dropRecording(recordingId, callId);
  return saved;
}

// A call logged through the API with a link to its recording: Deepgram
// fetches it from there. The link is forgotten once it's transcribed; if
// Deepgram can't get it, it stays so the call can be processed again.
async function transcribeRecordingUrl(callId: string, url: string, durationSec: number | null): Promise<{ transcript: string; sttSeconds: number; durationSec: number | null; recordingUrl: null }> {
  const language = process.env.DEEPGRAM_LANGUAGE || "en";
  const res = await fetch(`https://api.deepgram.com/v1/listen?${RECORDING_LISTEN_PARAMS}&language=${language}`, {
    method: "POST",
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Deepgram ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const heard = transcriptFromListenResponse(await res.json());
  const saved = { transcript: heard.transcript, sttSeconds: heard.seconds, durationSec: durationSec ?? heard.seconds, recordingUrl: null };
  await prisma.phoneCall.update({ where: { id: callId }, data: saved });
  return saved;
}

export async function dropRecording(recordingId: string | null, callId: string): Promise<void> {
  if (!recordingId) return;
  await deleteRecording(recordingId).catch((err) => reportError(err, "Deleting a call recording at Telnyx", { callId }));
}

// A call whose processing was cut off goes back as failed, so it gets Try
// again and Discard, and the cleanup below can drop it. Run when Calls or
// Notes is opened, and by the daily cron.
export async function failStuckCalls(where: Prisma.PhoneCallWhereInput = {}, now = new Date()): Promise<number> {
  const { count } = await prisma.phoneCall.updateMany({
    where: { ...where, status: "processing", updatedAt: { lt: new Date(now.getTime() - PROCESSING_STUCK_MS) } },
    data: { status: "failed" },
  });
  return count;
}

// For the daily cron: calls left unprocessed for a day are dropped, with
// their transcripts and any recording still at Telnyx. So is a call whose
// recording never arrived, and one whose processing was cut off a day ago.
export async function discardStaleCalls(now = new Date()): Promise<number> {
  await failStuckCalls({}, now);
  const before = new Date(now.getTime() - PENDING_TTL_MS);
  const where = { status: { in: ["pending", "failed", "recording", "dialing"] }, startedAt: { lt: before } };
  const stale = await prisma.phoneCall.findMany({ where, select: { id: true, telnyxRecordingId: true } });
  let count = 0;
  if (stale.length) {
    ({ count } = await prisma.phoneCall.updateMany({
      where: { ...where, id: { in: stale.map((c) => c.id) } },
      data: { status: "discarded", transcript: null, summary: null, telnyxRecordingId: null },
    }));
    for (const c of stale) await dropRecording(c.telnyxRecordingId, c.id);
  }
  // Recordings kept past processing (nothing was heard) go after a day too.
  const kept = await prisma.phoneCall.findMany({ where: { telnyxRecordingId: { not: null }, status: { notIn: ["pending", "failed", "recording", "dialing", "processing"] }, startedAt: { lt: before } }, select: { id: true, telnyxRecordingId: true } });
  for (const c of kept) {
    await dropRecording(c.telnyxRecordingId, c.id);
    await prisma.phoneCall.update({ where: { id: c.id }, data: { telnyxRecordingId: null } });
  }
  return count;
}

// What Telnyx billed, once its records have settled (daily cron): Telnyx
// keeps re-rating a call's records for hours after it ends, so only calls
// over a day old, up to 30 days back. A call Telnyx has nothing for yet is
// tried again the next day.
export async function fillTelnyxCosts(now = new Date(), budgetMs = 20_000): Promise<number> {
  if (!isTelnyxConfigured()) return 0;
  const calls = await prisma.phoneCall.findMany({
    where: { telnyxCallControlId: { not: null }, telnyxCostUsd: null, startedAt: { gte: new Date(now.getTime() - 30 * PENDING_TTL_MS), lt: new Date(now.getTime() - PENDING_TTL_MS) } },
    select: { id: true, telnyxCallControlId: true },
    orderBy: { startedAt: "asc" },
    take: 200,
  });
  const stop = Date.now() + budgetMs;
  let filled = 0;
  let failed: unknown = null;
  for (const c of calls) {
    if (Date.now() > stop) break;
    try {
      const cost = await telnyxCallCost(c.telnyxCallControlId!);
      if (cost === null) continue;
      await prisma.phoneCall.update({ where: { id: c.id }, data: { telnyxCostUsd: cost } });
      filled++;
    } catch (err) {
      // That call waits for tomorrow; the rest still get their cost.
      failed = err;
    }
  }
  if (failed) await reportError(failed, "Telnyx call cost lookup", { filled });
  return filled;
}
