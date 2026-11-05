import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { createNotification } from "@/lib/notifications";
import { isValidTimeZone } from "@/lib/tasks";
import { dayInZone } from "@/lib/viewer-time";
import { dispatchLeadsCreated } from "@/lib/webhooks";
import type { Lead } from "@/generated/prisma/client";

// Leads that come IN from a workspace's HubSpot or Salesforce. The CRM is
// the source of truth for who the person is (name, company, title, email,
// phone, owner); everything SealMe adds on top (stage, interest, notes,
// calls, tasks) is never touched by a sync.

export type CrmSource = "hubspot" | "salesforce";

// How a merged duplicate's CRM id is kept on the lead it was merged into
// (Lead.mergedCrmIds), so the next sync finds that lead instead of bringing
// the duplicate back.
export function crmAlias(crm: CrmSource | "ghl", id: string): string {
  return `${crm}:${id}`;
}

const crmIdField = (source: CrmSource, id: string) => (source === "hubspot" ? { hubspotContactId: id } : { salesforceRecordId: id });

// The lead a CRM record belongs to: the one carrying its id, or else the
// lead a duplicate with that id was merged into (viaAlias).
export async function findLeadByCrmId(workspaceId: string, source: CrmSource, id: string): Promise<{ lead: Lead; viaAlias: boolean } | null> {
  const own = await prisma.lead.findFirst({ where: { workspaceId, ...crmIdField(source, id) } });
  if (own) return { lead: own, viaAlias: false };
  const merged = await prisma.lead.findFirst({ where: { workspaceId, mergedCrmIds: { has: crmAlias(source, id) } } });
  return merged ? { lead: merged, viaAlias: true } : null;
}

export type CrmLeadRecord = {
  source: CrmSource;
  externalId: string;
  recordType?: "Lead" | "Contact";
  name: string | null;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  domain: string | null;
  ownerEmail: string | null;
};

export type HubspotLeadFilter = { lifecycleStages: string[]; leadStatuses: string[]; teamOwnedOnly: boolean };
export type SalesforceLeadFilter = { statuses: string[]; teamOwnedOnly: boolean };

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : []);

export function readHubspotFilter(raw: unknown): HubspotLeadFilter {
  const v = (raw ?? {}) as Record<string, unknown>;
  return { lifecycleStages: strings(v.lifecycleStages), leadStatuses: strings(v.leadStatuses), teamOwnedOnly: v.teamOwnedOnly === true };
}

export function readSalesforceFilter(raw: unknown): SalesforceLeadFilter {
  const v = (raw ?? {}) as Record<string, unknown>;
  return { statuses: strings(v.statuses), teamOwnedOnly: v.teamOwnedOnly === true };
}

type Member = { id: string; name: string; timezone: string | null };

// Active teammates by lowercased email, for matching the CRM's owner.
export async function membersByEmail(workspaceId: string): Promise<Map<string, Member>> {
  const users = await prisma.user.findMany({ where: { workspaceId, deactivatedAt: null }, select: { id: true, name: true, email: true, timezone: true } });
  return new Map(users.map((u) => [u.email.toLowerCase(), { id: u.id, name: u.name, timezone: u.timezone }]));
}

const clean = (v: string | null | undefined, max = 200) => (v ? v.trim().slice(0, max) || null : null);

export type UpsertResult = { outcome: "created" | "updated" | "unchanged" | "skipped"; assignedTo: string | null; leadName: string | null; leadId?: string };

// The CRM record a lead came from, carried over to the client it becomes,
// so pushing the deal updates that person in the CRM instead of making a
// second one. Salesforce only has a Contact to reuse; a Salesforce Lead
// stays a Lead there.
export function clientCrmIds(lead: { hubspotContactId: string | null; salesforceRecordId: string | null; salesforceRecordType: string | null }): {
  hubspotContactId?: string;
  salesforceContactId?: string;
} {
  return {
    ...(lead.hubspotContactId ? { hubspotContactId: lead.hubspotContactId } : {}),
    ...(lead.salesforceRecordId && lead.salesforceRecordType === "Contact" ? { salesforceContactId: lead.salesforceRecordId } : {}),
  };
}

// Creates or updates one lead from a CRM record. Matches an existing lead
// by its CRM id first (its own, or one a merged duplicate had), then by
// email or phone (so a lead imported from a spreadsheet gets linked rather
// than duplicated). When the CRM gives the lead to someone on the team,
// SealMe gives it to them too, with a "call" task for their today.
export async function upsertCrmLead(workspaceId: string, rec: CrmLeadRecord, ctx: { members: Map<string, Member>; teamOwnedOnly: boolean; createdById?: string | null }): Promise<UpsertResult> {
  const email = clean(rec.email, 200)?.toLowerCase() ?? null;
  const phone = normalizePhone(rec.phone);
  const name = clean(rec.name) ?? email;
  if (!name) return { outcome: "skipped", assignedTo: null, leadName: null };

  const ownerEmail = clean(rec.ownerEmail, 200)?.toLowerCase() ?? null;
  const owner = ownerEmail ? (ctx.members.get(ownerEmail) ?? null) : null;

  const idField = crmIdField(rec.source, rec.externalId);
  const found = await findLeadByCrmId(workspaceId, rec.source, rec.externalId);
  let existing = found?.lead ?? null;
  // A merged duplicate's record, on a lead that still has its own record in
  // this CRM: that one says who the person is, so the duplicate only fills
  // gaps and doesn't move the lead between owners.
  const secondary = Boolean(found?.viaAlias && (rec.source === "hubspot" ? found.lead.hubspotContactId : found.lead.salesforceRecordId));
  if (!existing && (email || phone)) {
    existing = await prisma.lead.findFirst({
      where: {
        workspaceId,
        OR: [...(email ? [{ email: { equals: email, mode: "insensitive" as const } }] : []), ...(phone ? [{ phone }] : [])],
        ...(rec.source === "hubspot" ? { hubspotContactId: null } : { salesforceRecordId: null }),
      },
    });
  }
  if (!existing && ctx.teamOwnedOnly && !owner) return { outcome: "skipped", assignedTo: null, leadName: name };
  // A client SealMe itself put into the CRM (a deal's push) comes back as
  // a new contact; they're already a client, not a lead.
  if (!existing) {
    const clientIdField = rec.source === "hubspot" ? { hubspotContactId: rec.externalId } : rec.recordType === "Contact" ? { salesforceContactId: rec.externalId } : null;
    if (clientIdField && (await prisma.client.findFirst({ where: { workspaceId, ...clientIdField }, select: { id: true } }))) {
      return { outcome: "skipped", assignedTo: null, leadName: name };
    }
  }

  const contact = {
    name,
    company: clean(rec.company),
    title: clean(rec.title),
    email,
    phone,
    domain: clean(rec.domain),
    externalOwnerEmail: ownerEmail,
  };

  let leadId: string;
  let assignedTo: string | null = null;
  let outcome: UpsertResult["outcome"];
  if (!existing) {
    let created;
    try {
      created = await prisma.lead.create({
        data: {
          workspaceId,
          ...contact,
          ...idField,
          ...(rec.source === "salesforce" ? { salesforceRecordType: rec.recordType ?? "Lead" } : {}),
          source: rec.source,
          ownerId: owner?.id ?? null,
        },
      });
    } catch (err) {
      // Two syncs at once (a webhook and "Sync now", say) can race to
      // create the same record; the other one won, which is fine.
      if ((err as { code?: string }).code === "P2002") return { outcome: "unchanged", assignedTo: null, leadName: name };
      throw err;
    }
    leadId = created.id;
    assignedTo = owner?.id ?? null;
    outcome = "created";
  } else {
    // Only what the CRM actually has replaces what's here.
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(contact)) {
      const current = (existing as Record<string, unknown>)[key];
      if (value !== null && value !== current && (!secondary || current == null)) changes[key] = value;
    }
    if (rec.source === "hubspot" && !existing.hubspotContactId) changes.hubspotContactId = rec.externalId;
    if (rec.source === "salesforce" && !existing.salesforceRecordId) {
      changes.salesforceRecordId = rec.externalId;
      changes.salesforceRecordType = rec.recordType ?? "Lead";
    }
    // Reassigned in the CRM to someone on the team: follow it. An owner
    // the team doesn't have leaves SealMe's owner as it is.
    if (owner && !secondary && existing.ownerId !== owner.id) {
      changes.ownerId = owner.id;
      assignedTo = owner.id;
    }
    leadId = existing.id;
    if (Object.keys(changes).length) {
      await prisma.lead.update({ where: { id: existing.id }, data: changes });
      outcome = "updated";
    } else outcome = "unchanged";
  }

  if (assignedTo && owner) {
    const open = await prisma.task.findFirst({ where: { leadId, assigneeId: owner.id, status: "open" }, select: { id: true } });
    if (!open) {
      const tz = owner.timezone && isValidTimeZone(owner.timezone) ? owner.timezone : "America/New_York";
      await prisma.task.create({
        data: {
          workspaceId,
          leadId,
          assigneeId: owner.id,
          createdById: ctx.createdById ?? null,
          type: "cold_call",
          dueDate: new Date(`${dayInZone(new Date(), tz)}T00:00:00Z`),
          timezone: tz,
          note: `Assigned to you in ${rec.source === "hubspot" ? "HubSpot" : "Salesforce"}`,
        },
      });
    }
  }
  return { outcome, assignedTo, leadName: name, leadId };
}

// One in-app note per person per sync, not one per lead.
export async function notifyCrmAssignments(workspaceId: string, source: CrmSource, results: UpsertResult[]): Promise<void> {
  const byOwner = new Map<string, string[]>();
  for (const r of results) if (r.assignedTo) byOwner.set(r.assignedTo, [...(byOwner.get(r.assignedTo) ?? []), r.leadName ?? "a lead"]);
  const crm = source === "hubspot" ? "HubSpot" : "Salesforce";
  for (const [userId, names] of byOwner) {
    try {
      await createNotification({
        workspaceId,
        userId,
        type: "lead.assigned",
        title: names.length === 1 ? `New lead from ${crm}: ${names[0]}` : `${names.length} new leads from ${crm}`,
        body: names.length === 1 ? `Assigned to you in ${crm}. It's on your list for today.` : `Assigned to you in ${crm}. They're on your list for today.`,
        linkUrl: "/dashboard",
      });
    } catch (err) {
      console.error("Failed to notify about CRM leads", err);
    }
  }
}

// more: stopped at the time or size cap; the next sync carries on.
export type SyncSummary = { created: number; updated: number; skipped: number; more?: boolean };

export function summarize(results: UpsertResult[], more = false): SyncSummary {
  return {
    more,
    created: results.filter((r) => r.outcome === "created").length,
    updated: results.filter((r) => r.outcome === "updated").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
  };
}

// lead.created webhooks for the leads a sync or webhook import just made.
export async function announceCreatedLeads(workspaceId: string, results: UpsertResult[]): Promise<void> {
  const ids = results.filter((r) => r.outcome === "created" && r.leadId).map((r) => r.leadId as string);
  if (ids.length) await dispatchLeadsCreated(workspaceId, ids);
}
