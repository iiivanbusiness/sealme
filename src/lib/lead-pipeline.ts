import { prisma } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { dispatchLeadsUpdated, leadChanges } from "@/lib/webhook-events";
import { reportError } from "@/lib/error-report";
import { leadForClient } from "@/lib/client-lead";
import type { PipelineStage } from "@/lib/pipeline-stages";

export { PIPELINE_STAGES, PIPELINE_STAGE_LABEL, PIPELINE_STAGE_CHIP, isPipelineStage, type PipelineStage } from "@/lib/pipeline-stages";

// Set by hand, so nothing a document does moves the lead out of them.
const MANUAL_STAGES = new Set(["lost", "not_now"]);
// A document that's out with the client, waiting on them: it went to them
// (sentAt) and isn't done. Changes asked for, or a new version waiting on
// approval, are still with the client; a contract a reviewer sent back
// before it ever went out isn't.
const OUT = new Set(["sent", "partially_signed", "changes_requested", "pending_approval"]);
// A contract the client didn't sign: it ran out, or the rep said so.
const UNSIGNED = new Set(["expired", "not_signed"]);

type DocState = { status: string; sentAt?: Date | null };
type DealState = { kind: string; contract: DocState | null };
const isOut = (c: DocState) => OUT.has(c.status) && (c.sentAt != null || c.status === "sent" || c.status === "partially_signed");
type LeadState = { isClient: boolean; pipelineStage: string };

// When the latest contract that went to the client went: null when none
// did. One that went without a send date counts as the latest, since a
// contract follows the proposal it was made from.
function lastContractOut(contracts: DocState[]): number | null {
  const times = contracts.filter((c) => wentOut({ status: c.status, sentAt: c.sentAt ?? null })).map((c) => c.sentAt?.getTime() ?? Infinity);
  return times.length > 0 ? Math.max(...times) : null;
}

// The stage a lead's documents put it at: a contract out beats a proposal
// out. A proposal stays "sent" for good, so a contract that went out after
// it answers it: only a proposal sent after the latest contract (a new
// offer) still counts, or the lead would fall back to Proposal sent once
// that contract runs out or is marked not signed. A contract that went
// unsigned moves a lead that was waiting on it to Not signed, when nothing
// else is out; once the lead is active again (a new call, or Reactivate)
// that contract no longer counts. fromScratch: working a lead's stage out
// for the first time, with no stage to go by (or the rep just marked a
// contract not signed, which counts whatever the stage was).
export function pipelineStageFor(lead: LeadState, deals: DealState[], { fromScratch = false }: { fromScratch?: boolean } = {}): PipelineStage {
  if (lead.isClient) return "client";
  if (MANUAL_STAGES.has(lead.pipelineStage)) return lead.pipelineStage as PipelineStage;
  const of = (kind: string) => deals.filter((d) => (kind === "proposal" ? d.kind === "proposal" : d.kind !== "proposal") && d.contract).map((d) => d.contract!);
  const contracts = of("contract");
  if (contracts.some(isOut)) return "contract_sent";
  const contractAt = lastContractOut(contracts);
  const stillOffered = (p: DocState) => contractAt == null || (p.sentAt != null && p.sentAt.getTime() > contractAt);
  if (of("proposal").some((p) => isOut(p) && stillOffered(p))) return "proposal_sent";
  const waited = fromScratch || lead.pipelineStage === "contract_sent" || lead.pipelineStage === "not_signed";
  if (waited && contracts.some((c) => UNSIGNED.has(c.status))) return "not_signed";
  return "new";
}

// Brings a lead's stage up to date with its documents, after one is sent,
// signed, runs out or is marked not signed. sentNow: a document just went
// out to the client, which is activity on the lead even when the stage stays
// put (a re-send, a second proposal). A stage change alone never is: a
// contract running out on its own leaves an idle lead idle. unsignedNow:
// the rep just marked a contract not signed, so the lead goes to Not signed
// even if it wasn't waiting on that contract (Reactivated since, say),
// unless something else is still out with the client. Never throws into
// what caused it.
export async function refreshLeadPipeline(
  leadId: string | null | undefined,
  { sentNow = false, unsignedNow = false }: { sentNow?: boolean; unsignedNow?: boolean } = {}
): Promise<void> {
  if (!leadId) return;
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { workspaceId: true, isClient: true, pipelineStage: true, stage: true, deals: { where: { trashedAt: null }, select: { kind: true, contract: { select: { status: true, sentAt: true } } } } },
    });
    if (!lead) return;
    // The rep sending a proposal or contract to a lead they set aside (Lost,
    // Not now) means it's back on, the same as Reactivate: the stage follows
    // what was sent. Only a send does this; a contract running out on its
    // own never moves a lead out of a stage set by hand.
    const revived = sentNow && MANUAL_STAGES.has(lead.pipelineStage);
    const stage = pipelineStageFor(revived ? { ...lead, pipelineStage: "new" } : lead, lead.deals, { fromScratch: unsignedNow });
    const activity = sentNow ? { lastActivityAt: new Date() } : {};
    // What the API reports: a lost lead someone sends to again is contacted.
    const apiStage = revived && lead.stage === "lost" ? { stage: "contacted" } : {};
    let counted = false;
    // Only if nothing changed it meanwhile (a signature, a merge, Mark as
    // lost): a stale read never undoes a newer stage.
    if (stage !== lead.pipelineStage) {
      const { count } = await prisma.lead.updateMany({ where: { id: leadId, isClient: lead.isClient, pipelineStage: lead.pipelineStage }, data: { pipelineStage: stage, ...activity, ...apiStage } });
      counted = count > 0;
      if (counted && apiStage.stage) await dispatchLeadsUpdated(lead.workspaceId, [leadChanges(leadId, { stage: lead.stage }, apiStage)]);
    }
    // The send happened whatever the stage did meanwhile.
    if (sentNow && !counted) await prisma.lead.updateMany({ where: { id: leadId }, data: activity });
  } catch (err) {
    await reportError(err, "Lead stage refresh", { leadId });
  }
}

// A proposal or contract that went to the client at some point, whatever it
// says now: a record of what they got, so whatever it's on isn't deleted.
// The status covers one that never had a sentAt, like a signed contract
// brought in from a spreadsheet in Settings.
export const WENT_OUT_STATUSES = ["sent", "partially_signed", "signed", "expired", "not_signed"];
export const wentOutWhere = { OR: [{ sentAt: { not: null } }, { status: { in: WENT_OUT_STATUSES } }] };
export const wentOut = (c: { sentAt: Date | null; status: string }) => c.sentAt != null || WENT_OUT_STATUSES.includes(c.status);

// The Leads tabs. Clients signed a contract. Inactive: lost, not now, a
// contract that went unsigned, or nothing happened for INACTIVE_AFTER_DAYS.
// Active is everyone else.
export const INACTIVE_STAGES = ["lost", "not_now", "not_signed"];
export const INACTIVE_AFTER_DAYS = 30;
export const LEAD_TABS = ["active", "clients", "inactive", "all"] as const;
export type LeadTab = (typeof LEAD_TABS)[number];

export function inactiveCutoff(now = new Date()): Date {
  return new Date(now.getTime() - INACTIVE_AFTER_DAYS * 24 * 60 * 60 * 1000);
}

// A lead with no activity on record yet counts from when it was added.
function idleSince(cutoff: Date) {
  return { OR: [{ lastActivityAt: { lt: cutoff } }, { lastActivityAt: null, createdAt: { lt: cutoff } }] };
}

export function leadTabWhere(tab: LeadTab, now = new Date()) {
  const cutoff = inactiveCutoff(now);
  if (tab === "clients") return { isClient: true };
  if (tab === "inactive") return { isClient: false, OR: [{ pipelineStage: { in: INACTIVE_STAGES } }, idleSince(cutoff)] };
  if (tab === "active") {
    return {
      isClient: false,
      pipelineStage: { notIn: INACTIVE_STAGES },
      OR: [{ lastActivityAt: { gte: cutoff } }, { lastActivityAt: null, createdAt: { gte: cutoff } }],
    };
  }
  return {};
}

export function leadIsInactive(lead: { isClient: boolean; pipelineStage: string; lastActivityAt: Date | null; createdAt: Date }, now = new Date()): boolean {
  if (lead.isClient) return false;
  if (INACTIVE_STAGES.includes(lead.pipelineStage)) return true;
  return (lead.lastActivityAt ?? lead.createdAt).getTime() < inactiveCutoff(now).getTime();
}

// The same, for the lead a deal belongs to.
export async function refreshDealLeadPipeline(dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { leadId: true } }).catch(() => null);
  await refreshLeadPipeline(deal?.leadId);
}

// A signed contract makes its lead a client: on the Clients tab for good, and
// "converted" for the API and webhooks. lead.converted goes out once: older
// code sent it when it made a deal from the lead, and set convertedDealId
// with it, so a lead with one has had it. A deal in the trash doesn't count,
// the same as for syncLeadClient.
export async function markLeadClient(dealId: string): Promise<void> {
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        workspaceId: true,
        kind: true,
        clientId: true,
        ownerId: true,
        trashedAt: true,
        client: { select: { id: true, name: true, company: true, email: true, phone: true } },
        lead: true,
      },
    });
    if (!deal || deal.kind !== "contract" || deal.trashedAt) return;
    let lead = deal.lead;
    if (!lead) {
      // A deal nothing linked to a lead (older ones): the signature still
      // makes a client, so its lead is found or made from the client first.
      const leadId = await leadForClient(deal.workspaceId, deal.client, { ownerId: deal.ownerId });
      await prisma.deal.update({ where: { id: deal.id }, data: { leadId } });
      lead = await prisma.lead.findUnique({ where: { id: leadId } });
      if (!lead) return;
    }
    const now = new Date();
    const announce = !lead.convertedDealId;
    const converted = { stage: "converted", convertedAt: lead.convertedAt ?? now, convertedDealId: lead.convertedDealId ?? deal.id };
    if (lead.isClient) {
      // Already a client (another signature, or marked one when its old
      // deals were linked up): converted for the API too, if it isn't yet,
      // and tied to the client it became.
      const data = {
        pipelineStage: "client",
        lastActivityAt: now,
        ...(lead.stage !== "converted" ? converted : {}),
        ...(lead.convertedClientId ? {} : { convertedClientId: deal.clientId }),
      };
      await prisma.lead.update({ where: { id: lead.id }, data });
      if (lead.stage !== "converted") await dispatchLeadsUpdated(deal.workspaceId, [leadChanges(lead.id, lead, data)]);
      if (lead.stage !== "converted" && announce) {
        await dispatchWebhookEvent(deal.workspaceId, "lead.converted", { leadId: lead.id, dealId: deal.id, clientId: deal.clientId, name: lead.name, company: lead.company, convertedAt: converted.convertedAt.toISOString() });
      }
      return;
    }
    const data = {
      isClient: true,
      clientAt: now,
      pipelineStage: "client",
      ...converted,
      convertedClientId: lead.convertedClientId ?? deal.clientId,
      lastActivityAt: now,
    };
    // Two signatures landing together still make one client and one event.
    const claimed = await prisma.lead.updateMany({ where: { id: lead.id, isClient: false }, data });
    if (claimed.count === 0) return;
    await dispatchLeadsUpdated(deal.workspaceId, [leadChanges(lead.id, lead, data)]);
    if (announce) {
      await dispatchWebhookEvent(deal.workspaceId, "lead.converted", { leadId: lead.id, dealId: deal.id, clientId: deal.clientId, name: lead.name, company: lead.company, convertedAt: converted.convertedAt.toISOString() });
    }
  } catch (err) {
    await reportError(err, "Making a lead a client after signing", { dealId });
  }
}

// After proposals and contracts move between leads (a call moved to another
// lead): a lead is a client exactly when it has a signed contract, so the
// client status goes where the signed contract went.
export async function syncLeadClient(leadId: string): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: {
        workspaceId: true,
        isClient: true,
        stage: true,
        convertedAt: true,
        convertedDealId: true,
        deals: { where: { kind: "contract", trashedAt: null, contract: { status: "signed" } }, select: { id: true }, take: 1 },
      },
    });
    if (!lead) return;
    if (lead.deals[0] && !lead.isClient) await markLeadClient(lead.deals[0].id);
    if (!lead.deals[0] && lead.isClient) {
      // Its signed contract went with the call to another lead: this one
      // isn't converted anymore either, so its own first signature later
      // announces it (lead.converted) like any other.
      const data = { isClient: false, clientAt: null, pipelineStage: "new", ...(lead.stage === "converted" ? { stage: "contacted" } : {}), convertedAt: null, convertedDealId: null };
      const { count } = await prisma.lead.updateMany({ where: { id: leadId, isClient: true }, data });
      if (count > 0 && lead.stage === "converted") await dispatchLeadsUpdated(lead.workspaceId, [leadChanges(leadId, lead, { stage: "contacted" })]);
      await refreshLeadPipeline(leadId);
    }
  } catch (err) {
    await reportError(err, "Lead client status after a move", { leadId });
  }
}
