import { prisma } from "@/lib/db";
import { extractPlaceholderKeys } from "@/lib/contract";
import { buildDealFieldRows } from "@/lib/extract-deal";
import { applyExtractionToDeal } from "@/lib/deal-live";
import { suggestTemplateId, type DealKind } from "@/lib/call-deal";
import { NEW_LEAD_NAME, PLACEHOLDER_CLIENT } from "@/lib/cold-call";
import { addCallAiUsage, runCallProcessing } from "@/lib/call-inbox";
import { meterAiUsage } from "@/lib/ai-usage";
import { dispatchDealCreated } from "@/lib/webhooks";
import { dispatchCallCompleted } from "@/lib/webhook-events";
import { refreshLeadPipeline } from "@/lib/lead-pipeline";
import { isValidTimeZone } from "@/lib/tasks";
import { reportError } from "@/lib/error-report";

// A call recorded live in the desktop app, started from Start a call. It's a
// PhoneCall on a lead from the first second (status "recording"), and its
// words come in a chunk about a minute apart (see the transcribe route).
// Notes need nothing while the call runs: they're written once, at the end,
// by the small model. Only a proposal or contract asked for (ticked before
// the call, or Create proposal / Create contract during it) gets the big
// model during the call, about every LIVE_EXTRACT_EVERY_MS, and once more at
// the end. Nothing from this flow is ever sent on its own.

// Chunks come about a minute apart: this reads the terms on about every
// third one.
export const LIVE_EXTRACT_EVERY_MS = 170_000;

// The client a document made during the call goes to: the lead's, from an
// earlier proposal or contract, or a new one from what's known of the lead.
// A lead that's still "New lead from a call" makes a "New client" until the
// call names them (see finishLiveDeals).

// Below this many words a call hasn't said enough to tell which template
// fits: a document started earlier takes the first one, and picks again
// once the call gets here (see repickTemplate).
const PICK_TEMPLATE_WORDS = 60;

// Who the call is with: filled in from the lead, and kept when a document's
// template is picked again.
const WHO_KEYS = ["clientName", "clientEmail"];

function wordCount(text: string | null | undefined): number {
  return (text ?? "").split(/\s+/).filter(Boolean).length;
}

// The rows for every term a template needs, empty, except who the call is
// with when that's known already.
function liveFieldRows(dealId: string, lead: { name: string; company: string | null; email: string | null }, clauses: string) {
  const named = lead.name !== NEW_LEAD_NAME;
  const { fieldRows } = buildDealFieldRows({ clientName: named ? lead.name : "", company: lead.company, email: lead.email, summary: null, fields: [] }, extractPlaceholderKeys(clauses));
  return fieldRows.map((row) => ({
    dealId,
    ...row,
    ...(row.fieldKey === "clientName" && named ? { value: lead.name, status: "extracted" } : {}),
    ...(row.fieldKey === "clientEmail" && lead.email ? { value: lead.email, status: "extracted" } : {}),
  }));
}

// The proposal or contract made on a call that's still recording: a deal on
// the call's lead with every term the template needs, empty, so the page
// shows it right away and fills it in as the terms are said. The template:
// the one picked, the only one, or the one that fits what's been said so far.
export async function startLiveDeal(phoneCallId: string, kind: DealKind, options: { templateId?: string | null } = {}): Promise<{ dealId: string }> {
  const call = await prisma.phoneCall.findUnique({
    where: { id: phoneCallId },
    select: { id: true, workspaceId: true, userId: true, status: true, transcript: true, dealId: true, templateId: true, lead: true, user: { select: { teamId: true } } },
  });
  if (!call?.lead) throw new Error("This call isn't on a lead");
  if (call.status !== "recording") throw new Error("This call has ended. Make it from the call on the lead");
  const made = await prisma.deal.findFirst({ where: { phoneCallId, kind, trashedAt: null }, select: { id: true } });
  if (made) return { dealId: made.id };

  const templates = await prisma.contractTemplate.findMany({ where: { workspaceId: call.workspaceId, kind }, select: { id: true, name: true, description: true, clauses: true }, orderBy: { name: "asc" } });
  if (templates.length === 0) throw new Error(`Add a ${kind} template first`);
  const wanted = options.templateId ?? (kind === "contract" ? call.templateId : null);
  const picked = wanted && templates.some((t) => t.id === wanted) ? wanted : null;
  // Enough said to pick from: the pick is made now, and it counts toward the
  // call's cost like the rest of its model calls.
  const suggested = !picked && wordCount(call.transcript) >= PICK_TEMPLATE_WORDS;
  let templateId = picked ?? templates[0].id;
  if (suggested) {
    const pick = await meterAiUsage(() => suggestTemplateId(call.transcript!, templates));
    templateId = pick.result;
    await addCallAiUsage(phoneCallId, pick.usage).catch((err) => reportError(err, "Counting a live call's model use", { phoneCallId }));
  }
  const template = templates.find((t) => t.id === templateId)!;

  const { lead } = call;
  const named = lead.name !== NEW_LEAD_NAME;
  const known = lead.convertedClientId ? await prisma.client.findFirst({ where: { id: lead.convertedClientId, workspaceId: call.workspaceId }, select: { id: true } }) : null;
  const client =
    known ??
    (await prisma.client.create({
      data: { workspaceId: call.workspaceId, name: named ? lead.name : PLACEHOLDER_CLIENT, company: lead.company ?? (named ? lead.name : PLACEHOLDER_CLIENT), email: lead.email },
      select: { id: true },
    }));

  const deal = await prisma.deal.create({
    data: {
      workspaceId: call.workspaceId,
      clientId: client.id,
      leadId: lead.id,
      phoneCallId,
      kind,
      templateId,
      ownerId: call.userId ?? lead.ownerId,
      teamId: call.user?.teamId ?? null,
      service: "",
      feeDisplay: "",
      status: "processing",
      source: "local",
      // The words the template was picked from: the readings that follow
      // start from them, and they mark the pick as made from enough words,
      // so it's never picked again (see repickTemplate).
      ...(suggested ? { lastExtractedTranscript: call.transcript } : {}),
    },
    select: { id: true },
  });
  // Who the call is with, when that's known already, is filled in from the start.
  await prisma.dealField.createMany({ data: liveFieldRows(deal.id, lead, template.clauses) });
  await prisma.$transaction([
    // The call points at its contract, or its proposal when that's all it
    // has, and asks for what was made, so writing it up afterwards treats
    // it as the call that made it (a sales call, the meeting done) and
    // doesn't make it again. Its templateId stays the rep's pick while it
    // records (what keeps a document's template from being picked again);
    // the contract's own goes on it at the end (see finishLiveDeals).
    prisma.phoneCall.update({
      where: { id: phoneCallId },
      data: kind === "contract" ? { dealId: deal.id, wantsContract: true } : { wantsProposal: true, ...(!call.dealId ? { dealId: deal.id } : {}) },
    }),
    prisma.lead.update({ where: { id: lead.id }, data: { lastActivityAt: new Date(), ...(known ? {} : { convertedClientId: client.id }) } }),
  ]);
  return { dealId: deal.id };
}

// The documents on a live call that SealMe may still fill in: not sent, not
// in review, not in the trash.
const FILLABLE = { trashedAt: null, status: { in: ["processing", "missing_info", "ready"] }, OR: [{ contract: null }, { contract: { status: "draft" } }] };

async function liveDeals(phoneCallId: string) {
  return prisma.deal.findMany({
    where: { phoneCallId, ...FILLABLE },
    select: {
      id: true,
      kind: true,
      workspaceId: true,
      clientId: true,
      templateId: true,
      lastExtractedAt: true,
      lastExtractedTranscript: true,
      template: { select: { kind: true, clauses: true } },
      lead: { select: { name: true, company: true, email: true } },
    },
  });
}

type LiveDeal = Awaited<ReturnType<typeof liveDeals>>[number];

// A document started before the call said enough to tell which template
// fits took the first one (see startLiveDeal). Once the call has said
// enough, and nothing but who it's with is filled in yet, the template that
// fits what was said takes its place, with every term empty. One the rep
// picked (the call's template), or one already picked from enough words
// (the last reading had them), stays; so does one with any term heard,
// since switching would throw that away. Returns the new template's clauses
// when it switched.
async function repickTemplate(deal: LiveDeal, transcript: string, callTemplateId: string | null): Promise<string | null> {
  const repPicked = callTemplateId !== null && callTemplateId === deal.templateId && deal.template?.kind === deal.kind;
  if (repPicked || wordCount(deal.lastExtractedTranscript) >= PICK_TEMPLATE_WORDS || wordCount(transcript) < PICK_TEMPLATE_WORDS) return null;
  const fields = await prisma.dealField.findMany({ where: { dealId: deal.id }, select: { fieldKey: true, value: true } });
  if (fields.some((f) => !WHO_KEYS.includes(f.fieldKey) && f.value?.trim())) return null;
  const templates = await prisma.contractTemplate.findMany({ where: { workspaceId: deal.workspaceId, kind: deal.kind }, select: { id: true, name: true, description: true, clauses: true }, orderBy: { name: "asc" } });
  if (templates.length < 2) return null;
  const pickedId = await suggestTemplateId(transcript, templates);
  const picked = templates.find((t) => t.id === pickedId);
  if (!picked || picked.id === deal.templateId) return null;

  const rows = liveFieldRows(deal.id, deal.lead ?? { name: NEW_LEAD_NAME, company: null, email: null }, picked.clauses);
  // Who the call is with, as far as the new template asks: anything else
  // (a "Client email" only the old template wanted) goes with the old terms.
  const keepWho = rows.filter((r) => WHO_KEYS.includes(r.fieldKey)).map((r) => r.fieldKey);
  await prisma.$transaction([
    prisma.deal.update({ where: { id: deal.id }, data: { templateId: picked.id } }),
    prisma.contract.updateMany({ where: { dealId: deal.id }, data: { templateId: picked.id } }),
    prisma.dealField.deleteMany({ where: { dealId: deal.id, fieldKey: { notIn: keepWho } } }),
    // Who the call is with keeps its value, in its place on the new template.
    ...rows.filter((r) => WHO_KEYS.includes(r.fieldKey)).map((r) => prisma.dealField.updateMany({ where: { dealId: deal.id, fieldKey: r.fieldKey }, data: { orderIndex: r.orderIndex } })),
    prisma.dealField.createMany({ data: rows, skipDuplicates: true }),
  ]);
  return picked.clauses;
}

// Reads the terms again for each document on the call, at most about every
// LIVE_EXTRACT_EVERY_MS (always when final). Claimed first, so two chunks
// whose readings overlap never pay for the same pass twice. One document
// failing never stops the other, or the call. What the model calls cost is
// added to the call's, like its notes.
export async function refreshLiveDeals(phoneCallId: string, transcript: string, { final = false }: { final?: boolean } = {}): Promise<void> {
  if (!transcript.trim()) return;
  const now = new Date();
  const cutoff = new Date(now.getTime() - LIVE_EXTRACT_EVERY_MS);
  const deals = await liveDeals(phoneCallId);
  if (deals.length === 0) return;
  // The template the rep picked for the call, if any.
  const call = await prisma.phoneCall.findUnique({ where: { id: phoneCallId }, select: { templateId: true } });
  const { usage } = await meterAiUsage(async () => {
    for (const deal of deals) {
      if (!deal.template) continue;
      if (!final) {
        const { count } = await prisma.deal.updateMany({ where: { id: deal.id, OR: [{ lastExtractedAt: null }, { lastExtractedAt: { lt: cutoff } }] }, data: { lastExtractedAt: now } });
        if (count === 0) continue;
      }
      try {
        // The rep can send a document while the call is still on (Send for
        // signature on the contract screen), or throw it away. The list was
        // read before the readings of the documents ahead of this one, so
        // look again: terms an approver or the client has stay as they went out.
        if ((await prisma.deal.count({ where: { id: deal.id, ...FILLABLE } })) === 0) continue;
        const clauses = (await repickTemplate(deal, transcript, call?.templateId ?? null)) ?? deal.template.clauses;
        await applyExtractionToDeal(deal.id, transcript, extractPlaceholderKeys(clauses));
      } catch (err) {
        await reportError(err, "Reading terms on a live call", { phoneCallId, dealId: deal.id, final });
      }
    }
  });
  await addCallAiUsage(phoneCallId, usage).catch((err) => reportError(err, "Counting a live call's model use", { phoneCallId }));
}

// The documents once the call is over: a last reading of the whole call, a
// draft to review (never sent from here) and the name the call gave a "New
// client". Returns the contracts to announce (deal.created), which waits
// for the notes: they can move a contract to the client of a lead they find.
async function finishLiveDeals(phoneCallId: string, transcript: string): Promise<{ workspaceId: string; dealId: string }[]> {
  await refreshLiveDeals(phoneCallId, transcript, { final: true });
  const deals = await prisma.deal.findMany({
    where: { phoneCallId, trashedAt: null },
    select: { id: true, kind: true, status: true, workspaceId: true, templateId: true, clientId: true, client: { select: { name: true, company: true } }, fields: { where: { fieldKey: "clientName" }, select: { value: true } } },
  });
  const announce: { workspaceId: string; dealId: string }[] = [];
  for (const deal of deals) {
    try {
      // A reading that never got through leaves the deal waiting on the call.
      if (deal.status === "processing") {
        const missing = await prisma.dealField.count({ where: { dealId: deal.id, status: "missing" } });
        await prisma.deal.updateMany({ where: { id: deal.id, status: "processing" }, data: { status: missing > 0 ? "missing_info" : "ready" } });
      }
      await prisma.contract.upsert({ where: { dealId: deal.id }, create: { dealId: deal.id, templateId: deal.templateId, status: "draft" }, update: {} });
      const heardName = deal.fields[0]?.value?.trim();
      if (deal.client.name === PLACEHOLDER_CLIENT && heardName) {
        const name = heardName.slice(0, 200);
        await prisma.client.update({ where: { id: deal.clientId }, data: { name, ...(deal.client.company === PLACEHOLDER_CLIENT ? { company: name } : {}) } });
      }
      if (deal.kind === "contract") {
        // The template it ended on, now that nothing picks it again (the
        // call points at its contract's template, as one made afterwards does).
        await prisma.phoneCall.update({ where: { id: phoneCallId }, data: { templateId: deal.templateId } });
        announce.push({ workspaceId: deal.workspaceId, dealId: deal.id });
      }
    } catch (err) {
      await reportError(err, "Finishing a document from a live call", { phoneCallId, dealId: deal.id });
    }
  }
  return announce;
}

// After the call's last chunk is in: the documents first (their terms come
// from the whole call), then the notes, which also find out who the call was
// with. Notes skip any proposal or contract the call already has.
export async function finishLiveCall(phoneCallId: string): Promise<void> {
  const call = await prisma.phoneCall.findUnique({ where: { id: phoneCallId }, select: { transcript: true, leadId: true, user: { select: { timezone: true } } } });
  if (!call) return;
  const transcript = call.transcript ?? "";
  let announce: { workspaceId: string; dealId: string }[] = [];
  try {
    announce = await finishLiveDeals(phoneCallId, transcript);
  } catch (err) {
    await reportError(err, "Finishing documents from a live call", { phoneCallId });
  }
  const tz = call.user?.timezone && isValidTimeZone(call.user.timezone) ? call.user.timezone : "America/New_York";
  try {
    await runCallProcessing(phoneCallId, tz, { force: true });
  } finally {
    // Now each contract is on the client it ends up with.
    for (const a of announce) {
      try {
        await dispatchDealCreated(a.workspaceId, a.dealId);
      } catch (err) {
        await reportError(err, "Announcing a contract from a live call", { phoneCallId, dealId: a.dealId });
      }
    }
  }
  await refreshLeadPipeline(call.leadId);
}

// A live call that never got its last chunk (the app was closed or crashed
// before Stop) is finished from what came in, a day after the last of it,
// instead of being thrown away with its words; one that never heard a word
// just ends. For the daily cron, before the stale-call cleanup (which leaves
// these alone).
export async function finishAbandonedLiveCalls(now = new Date(), staleMs = 24 * 60 * 60 * 1000): Promise<number> {
  const stale = await prisma.phoneCall.findMany({
    where: { source: "desktop", status: "recording", updatedAt: { lt: new Date(now.getTime() - staleMs) } },
    select: { id: true, workspaceId: true, startedAt: true, updatedAt: true, transcript: true },
    orderBy: { updatedAt: "asc" },
    // Each one is written up here, in the cron's own time; the rest wait a day.
    take: 5,
  });
  let finished = 0;
  for (const call of stale) {
    const heard = Boolean(call.transcript?.trim());
    const durationSec = Math.max(1, Math.round((call.updatedAt.getTime() - call.startedAt.getTime()) / 1000));
    const { count } = await prisma.phoneCall.updateMany({
      where: { id: call.id, status: "recording" },
      data: heard
        ? { status: "processing", endedAt: call.updatedAt, durationSec }
        : { status: "skipped", connected: false, endedAt: call.updatedAt, durationSec, extracted: { skipped: "no_speech" }, processedAt: now },
    });
    if (count === 0) continue;
    // Its token can't add to the call anymore.
    await prisma.localCaptureToken.updateMany({ where: { phoneCallId: call.id }, data: { usedAt: now, expiresAt: now } });
    if (heard) await finishLiveCall(call.id).catch((err) => reportError(err, "Finishing an abandoned live call", { phoneCallId: call.id }));
    else {
      // A document made on a call that said nothing waits on the rep.
      await prisma.deal.updateMany({ where: { phoneCallId: call.id, status: "processing" }, data: { status: "missing_info" } });
      // Set aside, like any call nothing was heard on: SealMe is done with it.
      await dispatchCallCompleted(call.workspaceId, call.id);
    }
    finished++;
  }
  return finished;
}
