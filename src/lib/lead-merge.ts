import { prisma } from "@/lib/db";
import { mergeList } from "@/lib/lead-match";
import { dispatchLeadsUpdated, leadChanges } from "@/lib/webhook-events";
import { crmAlias } from "@/lib/crm-leads";
import { refreshLeadPipeline } from "@/lib/lead-pipeline";
import type { Lead } from "@/generated/prisma/client";

// How far along a stage is, for keeping the furthest of two leads. Lost
// counts for nothing next to a lead that's still moving.
const STAGE_RANK: Record<string, number> = { lost: -1, new: 0, contacted: 1, interested: 2, meeting: 3, converted: 4 };
// The same for where a lead is on the Leads list (refreshed from the merged
// lead's documents right after).
const PIPELINE_RANK: Record<string, number> = { lost: -2, not_now: -1, new: 0, not_signed: 1, proposal_sent: 2, contract_sent: 3, client: 4 };
const earliest = (a: Date | null, b: Date | null) => (a && b ? (a < b ? a : b) : (a ?? b));
const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

// The CRM ids source has that the merged lead won't carry itself, kept as
// aliases on it (along with the aliases either lead already had), so a CRM
// sync of source's record updates the merged lead instead of making source
// again.
function mergedAliases(target: Lead, source: Lead, kept: { hubspotContactId: string | null; salesforceRecordId: string | null; ghlContactId: string | null }): string[] {
  const own = new Set(
    [
      kept.hubspotContactId && crmAlias("hubspot", kept.hubspotContactId),
      kept.salesforceRecordId && crmAlias("salesforce", kept.salesforceRecordId),
      kept.ghlContactId && crmAlias("ghl", kept.ghlContactId),
    ].filter(Boolean),
  );
  const all = [
    ...(target.mergedCrmIds ?? []),
    ...(source.mergedCrmIds ?? []),
    ...(source.hubspotContactId ? [crmAlias("hubspot", source.hubspotContactId)] : []),
    ...(source.salesforceRecordId ? [crmAlias("salesforce", source.salesforceRecordId)] : []),
    ...(source.ghlContactId ? [crmAlias("ghl", source.ghlContactId)] : []),
  ];
  return [...new Set(all)].filter((alias) => !own.has(alias));
}

// The lead that comes out of merging source into target: target's details
// win, gaps are filled from source, lists are joined, and the newest call's
// summary and next step are kept.
export function mergedLeadData(target: Lead, source: Lead) {
  const sourceNewer = (source.lastContactedAt?.getTime() ?? 0) > (target.lastContactedAt?.getTime() ?? 0);
  const newer = sourceNewer ? source : target;
  const older = sourceNewer ? target : source;
  const stage = (STAGE_RANK[source.stage] ?? 0) > (STAGE_RANK[target.stage] ?? 0) ? source.stage : target.stage;
  const crmIds = {
    hubspotContactId: target.hubspotContactId ?? source.hubspotContactId,
    salesforceRecordId: target.salesforceRecordId ?? source.salesforceRecordId,
    ghlContactId: target.ghlContactId ?? source.ghlContactId,
  };
  const isClient = target.isClient || source.isClient;
  const pipelineStage = isClient ? "client" : (PIPELINE_RANK[source.pipelineStage] ?? 0) > (PIPELINE_RANK[target.pipelineStage] ?? 0) ? source.pipelineStage : target.pipelineStage;
  return {
    stage,
    pipelineStage,
    isClient,
    clientAt: earliest(target.clientAt, source.clientAt),
    lastActivityAt: latest(target.lastActivityAt, source.lastActivityAt),
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
    ...crmIds,
    salesforceRecordType: target.salesforceRecordId ? target.salesforceRecordType : source.salesforceRecordType,
    mergedCrmIds: mergedAliases(target, source, crmIds),
    ghlOpportunityId: target.ghlOpportunityId ?? source.ghlOpportunityId,
    externalOwnerEmail: target.externalOwnerEmail ?? source.externalOwnerEmail,
    externalId: target.externalId ?? source.externalId,
  };
}

// Two leads for the same client become one: every call, proposal, contract,
// task and planned call moves to target, and source is deleted. Both must already be checked
// to be in the workspace and visible to whoever asked.
export async function mergeLeads(workspaceId: string, sourceId: string, targetId: string): Promise<void> {
  if (sourceId === targetId) throw new Error("That's the same lead");
  const [source, target] = await Promise.all([
    prisma.lead.findFirst({ where: { id: sourceId, workspaceId } }),
    prisma.lead.findFirst({ where: { id: targetId, workspaceId } }),
  ]);
  if (!source || !target) throw new Error("That lead isn't available");
  const data = mergedLeadData(target, source);
  // A merge only ever makes the lead a client, never takes it back: a
  // contract signed on target while this ran keeps it a client (the stage
  // refresh below then puts the stage right).
  const write: Partial<typeof data> = { ...data };
  // Where the lead stands in its conversion goes in only if target is still
  // not a client when the merge lands; a signature that arrived meanwhile
  // already set all of it.
  const conversion: Partial<typeof data> = {};
  if (!data.isClient) {
    delete write.isClient;
    delete write.clientAt;
    for (const key of ["stage", "pipelineStage", "convertedAt", "convertedDealId", "convertedClientId"] as const) {
      Object.assign(conversion, { [key]: data[key] });
      delete write[key];
    }
  }

  await prisma.$transaction([
    prisma.phoneCall.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
    prisma.deal.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
    prisma.task.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
    prisma.callIntent.updateMany({ where: { leadId: sourceId }, data: { leadId: targetId } }),
    // The CRM and API ids are unique per workspace: off source before target takes them.
    prisma.lead.update({ where: { id: sourceId }, data: { hubspotContactId: null, salesforceRecordId: null, externalId: null } }),
    prisma.lead.update({ where: { id: targetId }, data: write }),
    ...(Object.keys(conversion).length ? [prisma.lead.updateMany({ where: { id: targetId, isClient: false }, data: conversion })] : []),
    prisma.lead.delete({ where: { id: sourceId } }),
  ]);
  await dispatchLeadsUpdated(workspaceId, [leadChanges(targetId, target, data)]);
  await refreshLeadPipeline(targetId);
}
