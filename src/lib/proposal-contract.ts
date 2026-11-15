import { prisma } from "@/lib/db";
import { suggestTemplateId } from "@/lib/call-deal";
import { contractParty, extractPlaceholderKeys } from "@/lib/contract";
import { extractDealFromTranscript, type DealFieldRow } from "@/lib/extract-deal";
import { fieldMeta } from "@/lib/field-meta";
import { fillKnownDetails } from "@/lib/known-details";
import { NEW_LEAD_NAME, PLACEHOLDER_CLIENT } from "@/lib/cold-call";
import { docFailed, sharingPointerWhere } from "@/lib/call-docs";
import { logAudit } from "@/lib/audit";
import { reportError } from "@/lib/error-report";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The errors a rep can act on. The server action shows these as they are;
// anything else reads as "try again".
export const FINISH_CALL_FIRST = "Finish the call first";
export const CALL_STILL_PROCESSING = "SealMe is still writing up the call. Try again in a minute.";
export const ADD_CONTRACT_TEMPLATE_FIRST = "Add a contract template first";

// While the call records, SealMe reads every unsent document on it again,
// and once it ends it reads them one last time and announces the contracts
// (see live-call.ts). A contract made in that window would be read over and
// announced twice, and would copy terms the last reading is about to change.
const LIVE_CALL = new Set(["dialing", "recording"]);

type ProposalForContract = {
  summary: string | null;
  service: string;
  feeDisplay: string;
  fields: { label: string; value: string | null }[];
};

// What the proposal says, for picking a contract template when there's no
// call to read: its summary and its terms, a line each.
function termsAsText(p: ProposalForContract): string {
  const lines = [
    p.summary?.trim(),
    p.service.trim() ? `Service: ${p.service.trim()}` : null,
    p.feeDisplay.trim() ? `Fee: ${p.feeDisplay.trim()}` : null,
    ...p.fields.filter((f) => f.value?.trim()).map((f) => `${f.label}: ${f.value?.trim()}`),
  ];
  return lines.filter(Boolean).join("\n");
}

// How long after a call is written up SealMe may still be writing the
// contract it asked for (the same wait "Create contract" on a call has).
const WRITING_CONTRACT_MS = 5 * 60 * 1000;

// A lead still called "New lead from a call", and the "New client" a call
// makes for it, have no name yet: neither is ever who a contract is with or
// who signs it.
function realName(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  return trimmed && trimmed !== NEW_LEAD_NAME && trimmed !== PLACEHOLDER_CLIENT ? trimmed : null;
}

// "Create contract from proposal": a contract deal for the same client, lead
// and call, on a contract template, with the proposal's terms where the two
// templates share a field. What the contract asks for that the proposal
// didn't comes from the lead and the client on file, then from one more
// reading of the call; anything still unknown is left for the rep to fill.
// It's a draft: nothing is sent and the rep isn't notified (they clicked and
// are waiting for it). The caller checks the rep can see the proposal, and
// announces the new contract.
//
// A proposal that already has its contract returns that one instead, and so
// does one whose call already has a contract (one contract per call).
export async function createContractFromProposal(
  proposalDealId: string,
  userId: string,
  options: { templateId?: string | null } = {},
): Promise<{ dealId: string; existed: boolean; hasMissing: boolean }> {
  const user = await prisma.user.findFirst({ where: { id: userId, deactivatedAt: null }, select: { id: true, workspaceId: true, teamId: true, email: true } });
  if (!user) throw new Error("User not found");
  const workspaceId = user.workspaceId;

  const proposal = await prisma.deal.findFirst({
    where: { id: proposalDealId, workspaceId, kind: "proposal", trashedAt: null },
    include: {
      fields: { orderBy: { orderIndex: "asc" } },
      client: true,
      lead: { select: { id: true, name: true, company: true, title: true, email: true, phone: true } },
      phoneCall: {
        select: { id: true, leadId: true, dealId: true, status: true, transcript: true, templateId: true, wantsContract: true, mode: true, processedAt: true, extracted: true },
      },
      calls: { select: { transcript: true }, orderBy: { startedAt: "asc" } },
      derivedDeals: { where: { kind: { not: "proposal" }, trashedAt: null }, select: { id: true, status: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!proposal) throw new Error("Proposal not found");

  // One contract per proposal: a second click opens the first. Not atomic,
  // like "Create contract" on a call: a double click can still make two.
  const existing = proposal.derivedDeals[0];
  if (existing) return { dealId: existing.id, existed: true, hasMissing: existing.status === "missing_info" };

  const call = proposal.phoneCall;
  if (call && LIVE_CALL.has(call.status)) throw new Error(FINISH_CALL_FIRST);
  if (call?.status === "processing") throw new Error(CALL_STILL_PROCESSING);

  // The call made its own contract too (both were asked for, or it was made
  // from the call on the lead's page): that's this proposal's contract.
  // Linking it shows "Open contract" on the proposal from now on. A call from
  // before documents knew their call points at its contract instead, when
  // the pointer is that call's alone (see call-docs.ts).
  let pointerTaken = false;
  if (call) {
    let callContract = await prisma.deal.findFirst({
      where: { workspaceId, phoneCallId: call.id, kind: { not: "proposal" }, trashedAt: null },
      select: { id: true, status: true },
      orderBy: { createdAt: "desc" },
    });
    if (!callContract && call.dealId && call.dealId !== proposal.id) {
      const shared = call.leadId ? await prisma.phoneCall.count({ where: sharingPointerWhere({ id: call.id, leadId: call.leadId, dealId: call.dealId }) }) : 0;
      const pointed = await prisma.deal.findFirst({ where: { id: call.dealId, workspaceId, kind: { not: "proposal" }, trashedAt: null }, select: { id: true, status: true } });
      if (pointed && shared === 0) callContract = pointed;
      // Someone else's (the lead's one old deal): the call keeps pointing at it.
      else if (pointed) pointerTaken = true;
    }
    if (callContract) {
      await prisma.deal.updateMany({ where: { id: callContract.id, sourceDealId: null }, data: { sourceDealId: proposal.id } });
      return { dealId: callContract.id, existed: true, hasMissing: callContract.status === "missing_info" };
    }
    // The call asked for a contract and SealMe writes it right after the
    // notes: one made here now would be a second. Unless writing it failed.
    const asked = call.wantsContract || call.mode === "sales";
    if (asked && !docFailed(call.extracted, "contract") && call.processedAt && Date.now() - call.processedAt.getTime() < WRITING_CONTRACT_MS) {
      throw new Error(CALL_STILL_PROCESSING);
    }
  }

  const templates = await prisma.contractTemplate.findMany({
    where: { workspaceId, kind: { not: "proposal" } },
    select: { id: true, name: true, description: true, clauses: true },
    orderBy: { name: "asc" },
  });
  if (templates.length === 0) throw new Error(ADD_CONTRACT_TEMPLATE_FIRST);

  const transcript =
    proposal.phoneCall?.transcript?.trim() ||
    proposal.calls
      .map((c) => c.transcript.trim())
      .filter(Boolean)
      .join("\n\n") ||
    proposal.liveTranscript?.trim() ||
    "";

  // The rep's pick, then the call's (only when it's a contract template: a
  // call that made only a proposal remembers the proposal template), then
  // the one that fits what was said.
  const contractTemplateId = (id: string | null | undefined) => (id && templates.some((t) => t.id === id) ? id : null);
  const templateId =
    contractTemplateId(options.templateId) ??
    contractTemplateId(proposal.phoneCall?.templateId) ??
    (await suggestTemplateId(transcript || termsAsText(proposal), templates));
  const template = templates.find((t) => t.id === templateId) ?? templates[0];
  const keys = extractPlaceholderKeys(template.clauses);

  // One row per field the contract template asks for, in its order. A field
  // the proposal filled keeps the proposal's value (confirmed, so a later
  // reading of the call can't change it); a field only the proposal has is
  // dropped (it stays on the proposal). Service, fee and the client are
  // always on the proposal, even when its template never asked for them.
  const copied = new Map(proposal.fields.filter((f) => f.value?.trim()).map((f) => [f.fieldKey, f]));
  const { client, lead } = proposal;
  // Who it's with: the proposal's, else the lead's. A client still called
  // "New client" isn't a name, so with nothing better it's left to fill.
  const party = realName(contractParty(proposal.fields, client)) ?? realName(lead?.company) ?? realName(lead?.name);
  const onTheDeal = new Map<string, string>([
    ["service", proposal.service.trim()],
    ["fee", proposal.feeDisplay.trim()],
    ["clientName", party ?? ""],
  ]);
  let rows: DealFieldRow[] = keys.map((fieldKey, orderIndex) => {
    const from = copied.get(fieldKey);
    if (from) {
      return { groupLabel: from.groupLabel, label: from.label, fieldKey, value: from.value, status: "confirmed", confidence: null, sourceQuote: from.sourceQuote, orderIndex };
    }
    const value = onTheDeal.get(fieldKey) || null;
    return { ...fieldMeta(fieldKey), fieldKey, value, status: value ? "confirmed" : "missing", confidence: null, sourceQuote: null, orderIndex };
  });
  // Who the contract is with, even when the template never names them, the
  // way every deal has it (see buildDealFieldRows).
  if (!keys.includes("clientName")) {
    rows.unshift({ ...fieldMeta("clientName"), fieldKey: "clientName", value: party, status: party ? "confirmed" : "missing", confidence: null, sourceQuote: null, orderIndex: -1 });
  }
  // Somewhere to send it: a client with no email gets a "Client email" to
  // fill in, unless the proposal or the lead already has one.
  if (!client.email && !rows.some((r) => r.fieldKey === "clientEmail")) {
    const value = copied.get("clientEmail")?.value?.trim() || null;
    rows.push({ ...fieldMeta("clientEmail"), fieldKey: "clientEmail", value, status: value ? "confirmed" : "missing", confidence: null, sourceQuote: null, orderIndex: rows.length });
  }

  rows = fillKnownDetails(rows, {
    name: realName(lead?.name) ?? realName(client.name),
    title: lead?.title,
    email: client.email || lead?.email,
    phone: client.phone || lead?.phone,
    address: client.billingAddress,
  });

  // What's still unknown may have been said on the call: one reading for
  // just those fields. If it fails they stay for the rep to fill.
  const gaps = rows.filter((r) => r.status === "missing").map((r) => r.fieldKey);
  if (gaps.length > 0 && transcript) {
    try {
      const wanted = new Set(gaps);
      const extracted = await extractDealFromTranscript(transcript, gaps);
      const heard = new Map(extracted.fields.filter((f) => wanted.has(f.fieldKey) && f.value?.trim()).map((f) => [f.fieldKey, f]));
      rows = rows.map((r) => {
        const f = r.status === "missing" ? heard.get(r.fieldKey) : undefined;
        return f ? { ...r, value: f.value?.trim() ?? null, status: "extracted", confidence: f.confidence, sourceQuote: f.sourceQuote } : r;
      });
    } catch (err) {
      await reportError(err, "Reading the call for a contract from a proposal", { proposalDealId, templateId: template.id });
    }
  }

  const hasMissing = rows.some((r) => r.status === "missing");
  const rowValue = (key: string) => rows.find((r) => r.fieldKey === key)?.value?.trim() || null;
  // Deal.service, Deal.feeDisplay and Client.email are copies of those
  // fields (see syncCoreDealFields), so they follow what the rows hold.
  const service = rowValue("service") ?? proposal.service;
  const feeDisplay = rowValue("fee") ?? proposal.feeDisplay;
  const email = client.email ? null : rowValue("clientEmail")?.toLowerCase();

  // The contract carries on the proposal's deal, so it's the proposal
  // owner's (who can then open it from the proposal); whoever clicked can
  // see it too, since they could see the proposal.
  const owner =
    proposal.ownerId && proposal.ownerId !== user.id
      ? await prisma.user.findFirst({ where: { id: proposal.ownerId, workspaceId, deactivatedAt: null }, select: { id: true, teamId: true } })
      : null;
  const ownedBy = owner ?? user;

  const dealId = await prisma.$transaction(async (tx) => {
    const created = await tx.deal.create({
      data: {
        workspaceId,
        clientId: proposal.clientId,
        leadId: proposal.leadId,
        phoneCallId: proposal.phoneCallId,
        sourceDealId: proposal.id,
        kind: "contract",
        templateId: template.id,
        ownerId: ownedBy.id,
        teamId: ownedBy.teamId,
        service,
        feeDisplay,
        summary: proposal.summary,
        status: hasMissing ? "missing_info" : "ready",
        source: "proposal",
        fields: { create: rows },
        contract: { create: { templateId: template.id, status: "draft" } },
      },
      select: { id: true },
    });
    // The call points at its contract, the way the Calls inbox and the API
    // read it, and remembers the contract template. A pointer at the lead's
    // one old deal stays as it is.
    if (proposal.phoneCallId) {
      await tx.phoneCall.updateMany({ where: { id: proposal.phoneCallId }, data: { ...(pointerTaken ? {} : { dealId: created.id }), templateId: template.id } });
    }
    if (proposal.leadId) await tx.lead.updateMany({ where: { id: proposal.leadId }, data: { lastActivityAt: new Date() } });
    if (email && EMAIL.test(email)) await tx.client.updateMany({ where: { id: client.id, email: null }, data: { email } });
    return created.id;
  });

  await logAudit({
    workspaceId,
    actorEmail: user.email,
    action: "deal.contract_from_proposal",
    targetType: "Deal",
    targetId: dealId,
    metadata: { fromDealId: proposal.id },
  });

  return { dealId, existed: false, hasMissing };
}
