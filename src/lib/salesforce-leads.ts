import { prisma } from "@/lib/db";
import { salesforceGet, SALESFORCE_API_VERSION } from "@/lib/salesforce";
import { announceCreatedLeads, findLeadByCrmId, membersByEmail, notifyCrmAssignments, readSalesforceFilter, summarize, upsertCrmLead, type CrmLeadRecord, type SyncSummary, type UpsertResult } from "@/lib/crm-leads";

type SfLead = {
  Id: string;
  Name: string | null;
  Company?: string | null;
  Title?: string | null;
  Email?: string | null;
  Phone?: string | null;
  MobilePhone?: string | null;
  Website?: string | null;
  Owner?: { Email?: string | null } | null;
  Status?: string | null;
  LastModifiedDate: string;
};
type LeadDescribe = { fields: { name: string; picklistValues?: { value: string; label: string; active: boolean }[] }[] };

// Fields we read when the org has them. Which Lead fields exist, and which
// the connected user may see, differs from org to org; asking for one that
// isn't there fails the whole query.
const OPTIONAL_FIELDS = ["Company", "Title", "Email", "Phone", "MobilePhone", "Website"] as const;

function describeLead(workspaceId: string): Promise<LeadDescribe> {
  return salesforceGet<LeadDescribe>(workspaceId, `/services/data/${SALESFORCE_API_VERSION}/sobjects/Lead/describe`);
}
type QueryPage<T> = { records: T[]; nextRecordsUrl?: string; done: boolean };

function leadFields(available: Set<string>): string[] {
  return [
    "Id",
    "Name",
    ...OPTIONAL_FIELDS.filter((f) => available.has(f)),
    ...(available.has("Status") ? ["Status"] : []),
    ...(available.has("OwnerId") ? ["Owner.Email"] : []),
    "LastModifiedDate",
  ];
}

function toRecord(r: SfLead): CrmLeadRecord {
  return {
    source: "salesforce",
    externalId: r.Id,
    recordType: "Lead",
    name: r.Name,
    company: r.Company && r.Company !== "[not provided]" ? r.Company : null,
    title: r.Title ?? null,
    email: r.Email ?? null,
    phone: r.Phone || r.MobilePhone || null,
    domain: r.Website ? r.Website.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null,
    ownerEmail: r.Owner?.Email ?? null,
  };
}

// One sync can't run forever; anything past this comes in on the next one.
const MAX_PER_SYNC = 5000;

const soqlString = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// The Lead Status values set up in this org, for the import filter.
export async function salesforceLeadStatuses(workspaceId: string): Promise<{ value: string; label: string }[]> {
  const data = await describeLead(workspaceId);
  const status = data.fields.find((f) => f.name === "Status");
  return (status?.picklistValues ?? []).filter((p) => p.active).map((p) => ({ value: p.value, label: p.label }));
}

// Pulls Leads changed since the last sync (all open ones on the first run)
// that match the workspace's filter. Converted Leads are left out: once a
// Salesforce Lead is converted it's a Contact/Opportunity there.
export async function syncSalesforceLeads(workspaceId: string, options: { full?: boolean; budgetMs?: number } = {}): Promise<SyncSummary> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (!workspace.salesforceRefreshToken) throw new Error("Salesforce isn't connected");
  const filter = readSalesforceFilter(workspace.salesforceLeadFilter);
  const startedAt = new Date();
  // Stay well inside the request's time limit; the cursor below picks up
  // where this left off.
  const deadline = startedAt.getTime() + (options.budgetMs ?? 45_000);
  // A minute of overlap, so a record saved during the last run isn't missed.
  const since = !options.full && workspace.salesforceLeadsSyncedAt ? new Date(workspace.salesforceLeadsSyncedAt.getTime() - 60_000) : null;

  const available = new Set((await describeLead(workspaceId)).fields.map((f) => f.name));
  const fields = leadFields(available);
  const where = [
    "IsConverted = false",
    ...(since ? [`LastModifiedDate > ${since.toISOString().replace(/\.\d{3}Z$/, "Z")}`] : []),
    ...(filter.statuses.length && available.has("Status") ? [`Status IN (${filter.statuses.map(soqlString).join(", ")})`] : []),
  ].join(" AND ");
  const soql = `SELECT ${fields.join(", ")} FROM Lead WHERE ${where} ORDER BY LastModifiedDate ASC`;

  const members = await membersByEmail(workspaceId);
  const results: UpsertResult[] = [];
  let path: string | undefined = `/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  let lastModified: string | null = null;
  while (path && results.length < MAX_PER_SYNC && Date.now() < deadline) {
    const page: QueryPage<SfLead> = await salesforceGet<QueryPage<SfLead>>(workspaceId, path);
    for (const r of page.records) {
      if (Date.now() >= deadline) break;
      results.push(await upsertCrmLead(workspaceId, toRecord(r), { members, teamOwnedOnly: filter.teamOwnedOnly }));
      lastModified = r.LastModifiedDate;
    }
    path = page.done ? undefined : page.nextRecordsUrl;
  }
  const more = Boolean(path) || Date.now() >= deadline;

  // Stopped at the cap: carry on from the last record next time instead of
  // skipping what's left.
  const syncedTo = more && lastModified ? new Date(lastModified) : startedAt;
  await prisma.workspace.update({ where: { id: workspaceId }, data: { salesforceLeadsSyncedAt: syncedTo } });
  await notifyCrmAssignments(workspaceId, "salesforce", results);
  await announceCreatedLeads(workspaceId, results);
  return summarize(results, more);
}

// Webhook path: the Leads a Flow's outbound message just told us about,
// re-read through the API (so the owner's email and the filter apply the
// same way as a sync). A Lead that doesn't match the filter (yet) isn't
// brought in; one already here keeps updating.
export async function importSalesforceLeads(workspaceId: string, leadIds: string[]): Promise<SyncSummary> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  if (!workspace.salesforceRefreshToken || !workspace.salesforceLeadImport) return { created: 0, updated: 0, skipped: 0 };
  const filter = readSalesforceFilter(workspace.salesforceLeadFilter);
  const ids = [...new Set(leadIds.filter((id) => SALESFORCE_LEAD_ID.test(id)))].slice(0, 500);
  if (ids.length === 0) return { created: 0, updated: 0, skipped: 0 };

  const available = new Set((await describeLead(workspaceId)).fields.map((f) => f.name));
  const fields = leadFields(available);
  const members = await membersByEmail(workspaceId);
  const results: UpsertResult[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const soql = `SELECT ${fields.join(", ")} FROM Lead WHERE IsConverted = false AND Id IN (${ids.slice(i, i + 100).map(soqlString).join(", ")})`;
    const page = await salesforceGet<QueryPage<SfLead>>(workspaceId, `/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(soql)}`);
    for (const r of page.records) {
      const known = await findLeadByCrmId(workspaceId, "salesforce", r.Id);
      if (!known && filter.statuses.length && !(r.Status && filter.statuses.includes(r.Status))) continue;
      results.push(await upsertCrmLead(workspaceId, toRecord(r), { members, teamOwnedOnly: filter.teamOwnedOnly }));
    }
  }
  await notifyCrmAssignments(workspaceId, "salesforce", results);
  await announceCreatedLeads(workspaceId, results);
  return summarize(results);
}

// Lead record ids start with 00Q (15 or 18 characters).
const SALESFORCE_LEAD_ID = /^00Q[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;

// The record ids in a Salesforce outbound message (SOAP). Each
// <Notification> carries its own id plus the record's, so only ids inside
// <sObject> count.
export function leadIdsFromOutboundMessage(xml: string): string[] {
  const ids: string[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?sObject\b[^>]*>([\s\S]*?)<\/(?:\w+:)?sObject>/g)) {
    const id = /<(?:\w+:)?Id>\s*([a-zA-Z0-9]{15,18})\s*<\/(?:\w+:)?Id>/.exec(m[1])?.[1];
    if (id && SALESFORCE_LEAD_ID.test(id)) ids.push(id);
  }
  return [...new Set(ids)];
}

// What Salesforce expects back; anything else and it retries for 24 hours.
export const OUTBOUND_MESSAGE_ACK = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Body>
    <notificationsResponse xmlns="http://soap.sforce.com/2005/09/outbound">
      <Ack>true</Ack>
    </notificationsResponse>
  </soapenv:Body>
</soapenv:Envelope>`;
