import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import crypto from "crypto";
import { prisma } from "@/lib/db";
import { transcribeWav, isDeepgramConfigured, isUnusableAudio } from "@/lib/deepgram";
import { applyExtractionToDeal } from "@/lib/deal-live";
import { extractPlaceholderKeys } from "@/lib/contract";
import { autoGenerateAndSendContract } from "@/lib/auto-send";
import { extractActionItems } from "@/lib/extract-action-items";
import { extractCallHighlights } from "@/lib/extract-call-highlights";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { reportError } from "@/lib/error-report";
import { createNotification } from "@/lib/notifications";

export const runtime = "nodejs";
// Transcribing, then reading the terms, and on a final the action items and
// highlights as well: as long as a request may run, like the other routes
// that read a call.
export const maxDuration = 300;

// A final pass that's cut off (a timeout, a deploy) never gets to let go of
// the call. Past this, longer than any request can run, a final sent again
// takes it over.
const FINAL_LEASE_MS = 10 * 60 * 1000;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// A finished call's token expires as of the moment its final pass started.
// A pass only ever starts on a token that hasn't expired, so no running or
// abandoned one looks like this.
function isFinished(record: { usedAt: Date | null; expiresAt: Date }): boolean {
  return record.usedAt !== null && record.expiresAt <= record.usedAt;
}

// Receives a chunk of a locally-recorded call from the desktop app's native
// capture bridge, authenticated with a token minted by startLocalCapture —
// not a session cookie, since this request comes from Rust, not the webview.
//
// Called repeatedly while the call is still going (?final=false, roughly
// once a minute — see begin_live_updates in the Rust side) so deal terms
// fill in live the same way they do for a Recall bot call, and once more
// when the call ends (?final=true), which checks auto-send and can mark the
// deal extraction_failed. The token is spent only once a final pass gets all
// the way through, so the desktop can send a failed final again.
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 401 });

  const isFinal = new URL(req.url).searchParams.get("final") === "true";

  // A live call pings this roughly once a minute for its whole duration —
  // a tight per-token limit would legitimately trip on a normal-length call.
  const allowed = await checkRateLimit(`local-capture:${hashToken(token)}`, 120, 60 * 60 * 1000);
  if (!allowed) return NextResponse.json({ error: "Too many attempts" }, { status: 429 });

  const record = await prisma.localCaptureToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { call: { select: { endedAt: true } } } });
  if (!record) return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  // A final sent again because the answer to the first one got lost on the
  // way back: the call is already in.
  if (isFinal && isFinished(record)) return NextResponse.json({ ok: true, dealId: record.dealId, final: true });
  // Live pings stop with the call: one that turns up after the final belongs
  // to a call that's over.
  if (record.expiresAt < new Date() || (!isFinal && (record.usedAt || record.call.endedAt))) {
    return NextResponse.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  const deal = await prisma.deal.findUnique({ where: { id: record.dealId }, include: { template: true, workspace: true, client: { select: { name: true } } } });
  if (!deal || !deal.template) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const audioBuffer = Buffer.from(await req.arrayBuffer());

  // One final pass at a time. One that fails lets go of the call below, so
  // the same audio can be sent again; non-final (live) pings reuse the token
  // for the whole call.
  const claimedAt = new Date();
  if (isFinal) {
    const { count } = await prisma.localCaptureToken.updateMany({
      where: { id: record.id, expiresAt: { gt: claimedAt }, OR: [{ usedAt: null }, { usedAt: { lt: new Date(claimedAt.getTime() - FINAL_LEASE_MS) } }] },
      data: { usedAt: claimedAt },
    });
    if (count === 0) return NextResponse.json({ error: "This call is still being finished. Try again in a few minutes" }, { status: 409 });
    // Not after transcription/extraction below: the call itself ended the
    // moment its first final arrived, whether or not this one gets through.
    await prisma.call.updateMany({ where: { id: record.callId, endedAt: null }, data: { endedAt: claimedAt } });
  }
  const letGo = () => prisma.localCaptureToken.updateMany({ where: { id: record.id, usedAt: claimedAt }, data: { usedAt: null } });

  if (!isDeepgramConfigured()) {
    if (isFinal) {
      await prisma.deal.update({ where: { id: deal.id }, data: { status: "extraction_failed" } });
      await letGo();
    }
    return NextResponse.json({ error: "Transcription isn't configured" }, { status: 500 });
  }

  const placeholderKeys = extractPlaceholderKeys(deal.template.clauses);

  // Set once this chunk's words are in: a failure after that is only in
  // reading them, and the words stay.
  let gotNewWords = false;
  try {
    // A chunk can be empty on the final call (e.g. the call was stopped in
    // the same instant as the last periodic ping) — nothing new to
    // transcribe, but we still need to run the finalize steps below.
    if (audioBuffer.length > 0) {
      const chunkTranscript = await transcribeWav(audioBuffer).catch(async (err) => {
        if (!isUnusableAudio(err)) throw err;
        // Audio Deepgram will never take goes by like silence. Sent again,
        // it would fail again and hold up every chunk after it, and the end
        // of the call.
        await reportError(err, "Local capture chunk Deepgram can't read", { dealId: deal.id, callId: record.callId, final: isFinal });
        return "";
      });
      // A chunk sent again carries words that may already be in. Any live
      // one: its answer can get lost, or its request cut off after the
      // words went in, and the desktop sends it until it gets a yes. A
      // final only once one came in before (a pass that failed further on):
      // a first one ending on the same line as the last ping is still new.
      const mayBeResent = !isFinal || record.call.endedAt !== null;
      const alreadyIn = mayBeResent && chunkTranscript.trim() !== "" && (await prisma.call.findUnique({ where: { id: record.callId }, select: { transcript: true } }))?.transcript.endsWith(`\n${chunkTranscript}`);
      if (chunkTranscript.trim() && !alreadyIn) {
        // Same append twice, together so a retried chunk can tell from the
        // call whether the deal has its words too: Deal.liveTranscript stays
        // the input extraction actually reads; Call.transcript exists so the
        // negotiation timeline can show "here's what was said in call N"
        // without re-splitting one giant string.
        await prisma.$transaction([
          prisma.$executeRaw`UPDATE "Deal" SET "liveTranscript" = COALESCE("liveTranscript", '') || ${`\n${chunkTranscript}`} WHERE id = ${deal.id}`,
          prisma.$executeRaw`UPDATE "Call" SET "transcript" = "transcript" || ${`\n${chunkTranscript}`} WHERE id = ${record.callId}`,
        ]);
        gotNewWords = true;
      }
    }

    // Mid-call chunks with only silence would re-run the paid extraction on an
    // unchanged transcript. The final pass always runs: it decides auto-send.
    if (!isFinal && !gotNewWords) {
      return NextResponse.json({ ok: true, dealId: deal.id, final: false });
    }

    const fresh = await prisma.deal.findUnique({ where: { id: deal.id } });
    const { hasMissing } = await applyExtractionToDeal(deal.id, fresh?.liveTranscript ?? "", placeholderKeys, record.callId);

    if (isFinal) {
      try {
        await extractActionItems(record.callId);
      } catch (err) {
        console.error(`Failed to extract action items for call ${record.callId}`, err);
        await reportError(err, "Action item extraction", { dealId: deal.id, callId: record.callId });
      }
      try {
        // This call's words only, like the action items: the deal's
        // transcript holds every call on it, and the earlier calls'
        // highlights are already on the deal.
        const call = await prisma.call.findUnique({ where: { id: record.callId }, select: { transcript: true } });
        await extractCallHighlights(deal.id, call?.transcript ?? "", record.callId);
      } catch (err) {
        console.error(`Failed to extract call highlights for call ${record.callId}`, err);
        await reportError(err, "Call highlight extraction", { dealId: deal.id, callId: record.callId });
      }
      if (!hasMissing && !deal.workspace.requireApproval) {
        try {
          await autoGenerateAndSendContract(deal.id);
        } catch (err) {
          // The call was read fine; the email (or DocuSign) is what failed.
          // That's for the rep to fix and send, not "reading the call failed".
          await reportError(err, "Auto-send after a local call", { dealId: deal.id });
          if (deal.ownerId) {
            await createNotification({
              workspaceId: deal.workspaceId,
              userId: deal.ownerId,
              type: "contract.send_failed",
              title: `Contract for ${deal.client.name} couldn't be sent`,
              body: `${err instanceof Error ? err.message.slice(0, 200) : "Sending failed"}. Check the client's email and send it from the deal.`,
              linkUrl: `/deals/${deal.id}`,
            }).catch((notifyErr) => reportError(notifyErr, "Send-failed notification", { dealId: deal.id }));
          }
        }
      }
      await logAudit({ workspaceId: deal.workspaceId, action: "deal.local_capture_transcribed", targetType: "deal", targetId: deal.id });
    }

    // Doesn't push anything to an already-open tab (the deal page polls
    // getLiveDealState for that), but keeps any OTHER navigation to this
    // deal — a second tab, the deals list, the rep re-opening this page —
    // from serving a stale cached render mid-call.
    revalidatePath(`/deals/${deal.id}`);

    // Done: the token is spent (see isFinished).
    if (isFinal) await prisma.localCaptureToken.update({ where: { id: record.id }, data: { expiresAt: claimedAt } });

    return NextResponse.json({ ok: true, dealId: deal.id, final: isFinal });
  } catch (err) {
    console.error(`Local capture transcription failed for deal ${deal.id} (final=${isFinal})`, err);
    if (!isFinal) {
      await reportError(err, "Local capture chunk (mid-call)", { workspace: deal.workspace.name, dealId: deal.id });
      // Its words are in and only reading them failed: soft-fail, same as
      // the Recall realtime webhook. The next chunk, or the final, reads
      // the whole transcript again.
      if (gotNewWords) return NextResponse.json({ ok: false }, { status: 200 });
      // Nothing went in: an error, so the desktop keeps the chunk and sends
      // it again rather than drop that part of the call.
      return NextResponse.json({ error: "Transcription failed" }, { status: 502 });
    }
    // As the deal is now, not as it was when this request came in: the
    // contract may have gone out (or into review) in the meantime.
    await prisma.deal.updateMany({ where: { id: deal.id, status: { notIn: ["sent", "signed", "pending_approval"] } }, data: { status: "extraction_failed" } });
    await letGo();
    await reportError(err, "Local capture transcription (final)", { workspace: `${deal.workspace.name} (${deal.workspaceId})`, dealId: deal.id });
    return NextResponse.json({ error: "Transcription failed" }, { status: 500 });
  }
}
