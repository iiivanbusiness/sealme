import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { consentFor, isCallTestWorkspace, recordingDecision } from "@/lib/call-consent";
import { MIN_PROCESS_SECONDS } from "@/lib/call-inbox";
import { callAction, decodeClientState, deleteRecording, dial, encodeClientState, findRecordingId, type TelnyxEvent } from "@/lib/telnyx";
import { reportError } from "@/lib/error-report";
import { dispatchCallCompleted } from "@/lib/webhook-events";

// What a call is doing, carried on the call itself (client_state).
// The rep calling the SealMe number and merging:
//   rec     recording since SealMe answered
//   notice  waiting for the rep to press 1 for the recording notice
//   noticing  playing the notice; recording starts when it ends
//   bye     saying why SealMe isn't on this call, then hanging up
// SealMe calling the rep, then the client (a = play the recording notice):
//   rep     the rep's leg
//   client  the client's leg, ringing
//   cnotice the client's leg, hearing the recording notice
//   live    the client's leg, joined to the rep and recording
type CallState = { k: "rec" | "notice" | "noticing" | "bye" | "rep" | "client" | "cnotice" | "live"; c?: string; m?: ByeReason; a?: 1 };
type ByeReason = "unknown" | "nolead" | "off" | "nopickup";

const VOICE = { voice: "AWS.Polly.Joanna-Neural", language: "en-US" };
const SAY: Record<ByeReason | "notice_prompt" | "notice" | "holding", string> = {
  unknown: "This is SealMe. This phone number isn't set up in SealMe yet. Add it in SealMe under Settings, then call again. Goodbye.",
  nolead: "This is SealMe. No lead is waiting for this call. Tap Call on a lead in SealMe, then call again. Goodbye.",
  off: "This is SealMe. Recording is off for this call. Hang up and call your client directly.",
  notice_prompt: "SealMe is on the line. Once your client is on the call too, press 1 to play the recording notice. Nothing is recorded before that.",
  notice: "This call is being recorded.",
  nopickup: "Your client didn't pick up. Try again later. Goodbye.",
  holding: "Calling your client now. They'll hear that the call is recorded, then you're connected.",
};
// A safety cap; a sales call longer than this is unheard of.
const MAX_RECORDING_SECONDS = 4 * 60 * 60;

// Recording from the moment SealMe answers a merged line: one mixed track.
// These names only work on "answer"; record_start takes its own (below).
const answerRecordOptions = (callId: string) => ({
  record: "record-from-answer",
  record_format: "mp3",
  record_channels: "single",
  record_max_length: MAX_RECORDING_SECONDS,
  command_id: `answer-record-${callId}`,
});

// record_start, once the notice has played: Telnyx requires format and
// channels here and rejects the answer-style names. A call SealMe places
// itself is recorded on the client's leg in two channels (client, rep), so
// who said what never has to be guessed.
export const recordStartOptions = (callId: string, channels: "single" | "dual") => ({
  format: "mp3",
  channels,
  max_length: MAX_RECORDING_SECONDS,
  command_id: `record-${callId}`,
});

// One verified event from the SealMe number. Throws only on our own
// errors; the route reports them and still answers Telnyx, so a retry
// doesn't send the same command twice. Returns the call to process once
// its recording is in, which the route does after answering.
export async function handleTelnyxEvent(event: TelnyxEvent): Promise<{ processCallId?: string }> {
  const type = event.data?.event_type;
  const p = event.data?.payload;
  const id = p?.call_control_id;
  if (!type || !p || !id) return {};
  const state = decodeClientState<CallState>(p.client_state);

  switch (type) {
    case "call.initiated":
      if (p.direction === "incoming") await answerIncoming(id, p.from ?? null);
      return {};
    case "call.answered":
      if (state?.k === "bye" && state.m) await callAction(id, "speak", { ...VOICE, payload: SAY[state.m], command_id: `bye-${id}` });
      if (state?.k === "notice") await callAction(id, "speak", { ...VOICE, payload: SAY.notice_prompt, command_id: `prompt-${id}` });
      if (state?.k === "rep" && state.c) await repAnswered(id, state);
      if (state?.k === "client" && state.c) await clientAnswered(id, state);
      return {};
    case "call.dtmf.received":
      if (state?.k === "notice" && p.digit === "1" && state.c) {
        await callAction(id, "speak", { ...VOICE, payload: SAY.notice, client_state: encodeClientState({ k: "noticing", c: state.c }), command_id: `notice-${id}` });
      }
      return {};
    case "call.speak.ended":
      if (state?.k === "bye") await callAction(id, "hangup", { command_id: `hangup-${id}` });
      if (state?.k === "noticing" && state.c) await startRecordingAfterNotice(id, state.c);
      if (state?.k === "cnotice" && state.c) await joinAndRecord(id, state.c);
      return {};
    case "call.hangup":
      if (state?.k === "rep" || state?.k === "client") await outboundLegEnded(id, state, p.hangup_cause ?? null);
      else await callEnded(id, state);
      return {};
    case "call.recording.saved":
      return recordingSaved(id, state, p);
  }
  return {};
}

// Someone dialed the SealMe number. A rep is known by the number they call
// from; the lead comes from the Call button they tapped (a CallIntent),
// and the lead's area code decides whether SealMe may record.
async function answerIncoming(callControlId: string, rawFrom: string | null): Promise<void> {
  const from = normalizePhone(rawFrom);
  const rep = from
    ? await prisma.user.findFirst({
        where: { phone: from, deactivatedAt: null, workspace: { prospectingEnabled: true } },
        select: { id: true, workspaceId: true, workspace: { select: { allPartyStatePolicy: true } } },
      })
    : null;
  if (!rep) {
    await callAction(callControlId, "answer", { client_state: encodeClientState({ k: "bye", m: "unknown" }), command_id: `answer-${callControlId}` });
    return;
  }

  const now = new Date();
  const intent = await prisma.callIntent.findFirst({
    where: { userId: rep.id, usedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    include: { lead: { select: { id: true, phone: true } } },
  });
  if (intent) await prisma.callIntent.update({ where: { id: intent.id }, data: { usedAt: now } });

  const consent = consentFor(intent?.lead?.phone ?? null);
  const { record, announce } = recordingDecision(consent.rule, rep.workspace.allPartyStatePolicy, { testMode: isCallTestWorkspace(rep.workspaceId) });

  let callId: string;
  try {
    const call = await prisma.phoneCall.create({
      data: {
        workspaceId: rep.workspaceId,
        userId: rep.id,
        leadId: intent?.lead?.id ?? null,
        mode: intent?.mode ?? "unknown",
        templateId: intent?.templateId ?? null,
        source: "phone",
        status: record ? "recording" : "skipped",
        ...(record ? {} : { extracted: { skipped: "not_recorded" }, processedAt: now }),
        fromNumber: from,
        toNumber: intent?.lead?.phone ?? null,
        consentState: consent.state,
        consentRule: consent.rule,
        // With the notice, recording starts only once it has played.
        recorded: record && !announce,
        telnyxCallControlId: callControlId,
        startedAt: now,
      },
    });
    callId = call.id;
  } catch (err) {
    // Telnyx sent this event twice; the first one already answered.
    if ((err as { code?: string }).code === "P2002") return;
    throw err;
  }

  if (!record) {
    await callAction(callControlId, "answer", { client_state: encodeClientState({ k: "bye", m: intent ? "off" : "nolead", c: callId }), command_id: `answer-${callControlId}` });
    return;
  }
  if (announce) {
    await callAction(callControlId, "answer", { client_state: encodeClientState({ k: "notice", c: callId }), command_id: `answer-${callControlId}` });
    return;
  }
  const answered = await callAction(callControlId, "answer", {
    client_state: encodeClientState({ k: "rec", c: callId }),
    ...answerRecordOptions(callId),
    command_id: `answer-${callControlId}`,
  });
  if (answered.data?.recording_id) await prisma.phoneCall.update({ where: { id: callId }, data: { telnyxRecordingId: answered.data.recording_id } });
}

// The notice has played to everyone on the merged call; only now does
// SealMe start recording.
async function startRecordingAfterNotice(callControlId: string, callId: string): Promise<void> {
  await callAction(callControlId, "record_start", { ...recordStartOptions(callId, "single"), client_state: encodeClientState({ k: "rec", c: callId }) });
  await prisma.phoneCall.update({ where: { id: callId }, data: { recorded: true } });
}

// SealMe calls the rep's phone first (startLeadCall). When they pick up,
// it dials the client from the rep's own (verified) number. Without a
// notice to play, the two are joined at once and the rep hears it ring.
export async function callRep(callId: string, repPhone: string, announce: boolean): Promise<string> {
  const from = process.env.TELNYX_PHONE_NUMBER;
  if (!from) throw new Error("TELNYX_PHONE_NUMBER isn't set");
  return dial({ to: repPhone, from, clientState: { k: "rep", c: callId, ...(announce ? { a: 1 } : {}) }, timeoutSecs: 30, commandId: `rep-${callId}` });
}

async function repAnswered(repLeg: string, state: CallState): Promise<void> {
  const call = await prisma.phoneCall.findUnique({ where: { id: state.c! } });
  if (!call || call.status !== "dialing" || !call.toNumber || !call.fromNumber || call.telnyxClientLegId) return;
  const clientLeg = await dial({
    to: call.toNumber,
    from: call.fromNumber,
    linkTo: repLeg,
    clientState: { k: "client", c: call.id, ...(state.a ? { a: 1 } : {}) },
    timeoutSecs: 30,
    commandId: `client-${call.id}`,
  });
  await prisma.phoneCall.update({ where: { id: call.id }, data: { telnyxClientLegId: clientLeg } });
  // Cancel (or the rep hanging up) may have landed while the client was
  // being dialed, before this leg was saved for it to end: end it here.
  // "recording" means the client already picked up, so the rep still joins.
  const latest = await prisma.phoneCall.findUnique({ where: { id: call.id }, select: { status: true } });
  if (latest?.status !== "dialing" && latest?.status !== "recording") {
    await callAction(clientLeg, "hangup", { command_id: `hangup-client-${call.id}` }).catch(() => {});
    return;
  }
  if (state.a) await callAction(repLeg, "speak", { ...VOICE, payload: SAY.holding, command_id: `holding-${call.id}` });
  else await callAction(repLeg, "bridge", { call_control_id: clientLeg, play_ringtone: true, command_id: `bridge-${call.id}` });
}

async function clientAnswered(clientLeg: string, state: CallState): Promise<void> {
  if (state.a) {
    await callAction(clientLeg, "speak", { ...VOICE, payload: SAY.notice, client_state: encodeClientState({ k: "cnotice", c: state.c }), command_id: `cnotice-${state.c}` });
    return;
  }
  await startRecordingClientLeg(clientLeg, state.c!);
}

// After the notice: join the rep and the client, then record.
async function joinAndRecord(clientLeg: string, callId: string): Promise<void> {
  const call = await prisma.phoneCall.findUnique({ where: { id: callId }, select: { telnyxCallControlId: true } });
  if (!call?.telnyxCallControlId) return;
  await callAction(call.telnyxCallControlId, "bridge", { call_control_id: clientLeg, command_id: `bridge-${callId}` });
  await startRecordingClientLeg(clientLeg, callId);
}

async function startRecordingClientLeg(clientLeg: string, callId: string): Promise<void> {
  try {
    await callAction(clientLeg, "record_start", { ...recordStartOptions(callId, "dual"), client_state: encodeClientState({ k: "live", c: callId }) });
  } catch (err) {
    // They're talking, but nothing is recorded: say so on the call instead
    // of it ending up "cancelled", and tell us.
    const failed = await prisma.phoneCall.update({ where: { id: callId }, data: { status: "skipped", extracted: { skipped: "record_failed" }, processedAt: new Date() } });
    await reportError(err, "Starting a call recording", { callId });
    await dispatchCallCompleted(failed.workspaceId, callId);
    return;
  }
  await prisma.phoneCall.update({ where: { id: callId }, data: { status: "recording", recorded: true } });
}

// A leg ended before the two were talking: the rep didn't pick up, the
// client didn't, or the rep gave up. The other leg is ended too, and the
// call is set aside with the reason. Each write only lands while the call
// is still "dialing": Cancel can mark it cancelled between the read and the
// write, and that must not turn into "they didn't pick up".
async function outboundLegEnded(leg: string, state: CallState, cause: string | null): Promise<void> {
  const call = await prisma.phoneCall.findUnique({ where: { id: state.c! } });
  if (!call) return;
  if (call.status !== "dialing") {
    if (!call.endedAt) await prisma.phoneCall.update({ where: { id: call.id }, data: { endedAt: new Date() } });
    return;
  }
  const now = new Date();
  if (state.k === "client") {
    const { count } = await prisma.phoneCall.updateMany({
      where: { id: call.id, status: "dialing" },
      data: { status: "skipped", outcome: "no_answer", extracted: { skipped: "no_pickup" }, endedAt: now, processedAt: now },
    });
    if (count === 0) {
      await endedMeanwhile(call.id, now);
      return;
    }
    // The rep is still on: tell them, then hang up.
    if (call.telnyxCallControlId) {
      await callAction(call.telnyxCallControlId, "speak", { ...VOICE, payload: SAY.nopickup, client_state: encodeClientState({ k: "bye", m: "nopickup", c: call.id }), command_id: `nopickup-${call.id}` }).catch(() => {});
    }
    await dispatchCallCompleted(call.workspaceId, call.id);
    return;
  }
  // The rep's leg ended: stop ringing the client if it got that far.
  if (call.telnyxClientLegId) await callAction(call.telnyxClientLegId, "hangup", { command_id: `hangup-client-${call.id}` }).catch(() => {});
  const missed = cause === "timeout" || cause === "no_answer" || cause === "user_busy" || cause === "call_rejected";
  const { count } = await prisma.phoneCall.updateMany({
    where: { id: call.id, status: "dialing" },
    data: { status: "skipped", extracted: { skipped: missed && !call.telnyxClientLegId ? "rep_missed" : "cancelled" }, endedAt: now, processedAt: now },
  });
  if (count === 0) await endedMeanwhile(call.id, now);
}

// The call left "dialing" while a hangup was being handled (cancelled, or
// picked up): keep whatever it became, just note when it ended.
async function endedMeanwhile(callId: string, now: Date): Promise<void> {
  await prisma.phoneCall.updateMany({ where: { id: callId, endedAt: null }, data: { endedAt: now } });
}

async function findCall(callControlId: string, state: CallState | null) {
  if (state?.c) return prisma.phoneCall.findUnique({ where: { id: state.c } });
  return prisma.phoneCall.findUnique({ where: { telnyxCallControlId: callControlId } });
}

// The rep hung up. A recorded call waits for its recording; one where
// recording never started (the notice wasn't played) is closed here.
async function callEnded(callControlId: string, state: CallState | null): Promise<void> {
  const call = await findCall(callControlId, state);
  if (!call) return;
  const now = new Date();
  if (call.status === "recording" && !call.recorded) {
    await prisma.phoneCall.update({ where: { id: call.id }, data: { status: "skipped", extracted: { skipped: "not_recorded" }, endedAt: now, processedAt: now } });
    await dispatchCallCompleted(call.workspaceId, call.id);
    return;
  }
  if (!call.endedAt) await prisma.phoneCall.update({ where: { id: call.id }, data: { endedAt: now } });
}

// The recording is ready. A call tied to a lead is processed right away;
// one without stays in the inbox. A call too short to be worth anything is
// set aside and its recording dropped.
async function recordingSaved(callControlId: string, state: CallState | null, p: NonNullable<NonNullable<TelnyxEvent["data"]>["payload"]>): Promise<{ processCallId?: string }> {
  const call = await findCall(callControlId, state);
  if (!call || call.status !== "recording") return {};
  const recordingId = p.recording_id ?? call.telnyxRecordingId ?? (await findRecordingId(callControlId));
  const started = p.recording_started_at ? Date.parse(p.recording_started_at) : NaN;
  const ended = p.recording_ended_at ? Date.parse(p.recording_ended_at) : NaN;
  const seconds = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.round((ended - started) / 1000)) : null;
  const tooShort = seconds !== null && seconds < MIN_PROCESS_SECONDS;

  await prisma.phoneCall.update({
    where: { id: call.id },
    data: {
      telnyxRecordingId: tooShort ? null : recordingId,
      durationSec: seconds,
      endedAt: call.endedAt ?? new Date(),
      status: tooShort ? "skipped" : "pending",
      ...(tooShort ? { extracted: { skipped: "too_short" }, processedAt: new Date() } : {}),
    },
  });
  if (tooShort && recordingId) await deleteRecording(recordingId).catch((err) => reportError(err, "Deleting a short call's recording", { callId: call.id }));
  if (tooShort) await dispatchCallCompleted(call.workspaceId, call.id);
  // Tied to a lead (the rep tapped Call): the notes write themselves.
  return !tooShort && call.leadId ? { processCallId: call.id } : {};
}
