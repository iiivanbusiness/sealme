import { prisma } from "@/lib/db";
import { mergeList } from "@/lib/lead-match";
import { dispatchLeadsUpdated, leadChanges } from "@/lib/webhook-events";
import type { Lead } from "@/generated/prisma/client";

// How far along a stage is, for keeping the furthest of two leads. Lost
// counts for nothing next to a lead that's still moving.
const STAGE_RANK: Record<string, number> = { lost: -1, new: 0, contacted: 1, interested: 2, meeting: 3, converted: 4 };

// The lead that comes out of merging source into target: target's details
// win, gaps are filled from source, lists are joined, and the newest call's
// summary and next step are kept.
export function mergedLeadData(target: Lead, source: Lead) {
  const sourceNewer = (source.lastContactedAt?.getTime() ?? 0) > (target.lastContactedAt?.getTime() ?? 0);
  const newer = sourceNewer ? source : target;
  const older = sourceNewer ? target : source;
  const stage = (STAGE_RANK[source.stage] ?? 0) > (STAGE_RANK[target.stage] ?? 0) ? source.stage : target.stage;
  return {
    stage,
    ownerId: target.ownerId ?? source.ownerId,
    company: target.company ?? source.company,
    title: target.title ?? source.title,
    email: target.email ?? source.email,
    phone: target.phone ?? source.phone,
    domain: target.domain ?? source.domain,
    campaign: target.campaign ?? source.campaign,
    interest: newer.interest ?? older.interest,
    isDecisionMaker: newer.isDecisionMaker ?? older.isDecisionMaker,
    painPoints: mergeList(newer.painPoints, older.painPoints),
    objections: mergeList(newer.objections, older.objections),
    nextStep: newer.nextStep ?? older.nextStep,
    nextStepAt: newer.nextStep ? newer.nextStepAt : older.nextStepAt,
    summary: newer.summary ?? older.summary,
    notes: [target.notes, source.notes].filter(Boolean).join("\n\n") || null,
    lastContactedAt: newer.lastContactedAt ?? older.lastContactedAt,
    convertedClientId: target.convertedClientId ?? source.convertedClientId,
    convertedDealId: target.convertedDealId ?? source.convertedDealId,
    convertedAt: target.convertedAt ?? source.convertedAt,
    hubspotContactId: target.hubspotContactId ?? source.hubspotContactId,
    salesforceRecordId: target.salesforceRecordId ?? source.salesforceRecordId,
    salesforceRecordType: target.salesforceRecordId ? target.salesforceRecordType : source.salesforceRecordType,
    ghlContactId: target.ghlContactId ?? source.ghlContactId,
    ghlOpportunityId: target.ghlOpportunityId ?? source.ghlOpportunityId,
    externalOwnerEmail: target.externalOwnerEmail ?? source.externalOwnerEmail,
    externalId: target.externalId ?? source.externalId,
  };
}

// Two leads for the same client become one: every call, task and planned
// call moves to target, and source is deleted. Both must already be checked
// to be in the workspace and visible to whoever asked.
export async function mergeLeads(workspaceId: string, sourceId: string, targetId: string): Promise<void> {
  if (sourceId === targetId) throw new Error("That's the same lead");
  const [source, target] = await Promise.all([
    prisma.lead.findFirst({ where: { id: sourceId, workspaceId } }),
    prisma.lead.findFirst({ where: { id: targetId, workspaceId } }),
  ]);
  if (!source || !target) throw new Error("That lead isn't available");
  const data = mergedLeadData(target, source);

  await prisma.$transaction([
    prisma.phoneCall.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
    prisma.task.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
    prisma.callIntent.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
    // The CRM and API ids are unique per workspace: off source before target takes them.
    prisma.lead.update({ where: { id: sourceId }, data: { hubspotContactId: null, salesforceRecordId: null, externalId: null } }),
    prisma.lead.update({ where: { id: targetId }, data }),
    prisma.lead.delete({ where: { id: sourceId } }),
  ]);
  await dispatchLeadsUpdated(workspaceId, [leadChanges(targetId, target, data)]);
}
