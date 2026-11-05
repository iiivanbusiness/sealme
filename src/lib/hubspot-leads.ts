import crypto from "crypto";
import { prisma } from "@/lib/db";
import { announceCreatedLeads, findLeadByCrmId, membersByEmail, notifyCrmAssignments, readHubspotFilter, summarize, upsertCrmLead, type CrmLeadRecord, type HubspotLeadFilter, type SyncSummary, type UpsertResult } from "@/lib/crm-leads";

const API = "https://api.hubapi.com";
const CONTACT_PROPS = ["firstname", "lastname", "email", "phone", "mobilephone", "company", "jobtitle", "website", "hubspot_owner_id", "lifecyclestage", "hs_lead_status", "lastmodifieddate"];
const MAX_PER_SYNC = 5000;

type Contact = { id: string; properties: Record<string, string | null> };

async function hs<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`HubSpot ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// Owner ids to emails, cached for one sync.
function ownerLookup(token: string) {
  const cache = new Map<string, string | null>();
  return async (ownerId: string | null | undefined): Promise<string | null> => {
    if (!ownerId) return null;
    if (cache.has(ownerId)) return cache.get(ownerId)!;
    let email: string | null = null;
    try {
      email = (await hs<{ email?: string }>(token, `/crm/v3/owners/${encodeURIComponent(ownerId)}`)).email ?? null;
    } catch {
      email = null;
    }
    cache.set(ownerId, email);
    return email;
  };
}

function matchesFilter(c: Contact, filter: HubspotLeadFilter): boolean {
  const p = c.properties;
  if (filter.lifecycleStages.length && !filter.lifecycleStages.includes(p.lifecyclestage ?? "")) return false;
  if (filter.leadStatuses.length && !filter.leadStatuses.includes(p.hs_lead_status ?? "")) return false;
  return true;
}

async function toRecord(c: Contact, ownerEmail: (id: string | null | undefined) => Promise<string | null>): Promise<CrmLeadRecord> {
  const p = c.properties;
  const name = [p.firstname, p.lastname].filter(Boolean).join(" ").trim() || null;
  return {
    source: "hubspot",
    externalId: c.id,
    name,
    company: p.company ?? null,
    title: p.jobtitle ?? null,
    email: p.email ?? null,
    phone: p.phone || p.mobilephone || null,
    domain: p.website ? p.website.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null,
    ownerEmail: await ownerEmail(p.hubspot_owner_id),
  };
}

// The lifecycle stages and lead statuses this portal uses, for the filter.
export async function hubspotLeadOptions(token: string): Promise<{ lifecycleStages: { value: string; label: string }[]; leadStatuses: { value: string; label: string }[] }> {
  const get = async (name: string) => {
    try {
      const prop = await hs<{ options?: { value: string; label: string; hidden?: boolean }[] }>(token, `/crm/v3/properties/contacts/${name}`);
      return (prop.options ?? []).filter((o) => !o.hidden).map((o) => ({ value: o.value, label: o.label }));
    } catch {
      return null;
    }
  };
  const [lifecycleStages, leadStatuses] = await Promise.all([get("lifecyclestage"), get("hs_lead_status")]);
  // Both failing means the token or its scopes are the problem, not an
  // empty portal; say so instead of showing no options.
  if (!lifecycleStages && !leadStatuses) throw new Error("Couldn't read contact properties from HubSpot");
  return { lifecycleStages: lifecycleStages ?? [], leadStatuses: leadStatuses ?? [] };
}

// "Sync now" and the first import: contacts matching the filter, changed
// since the last sync (all of them the first time).
export async function syncHubspotLeads(workspaceId: string, options: { full?: boolean; budgetMs?: number } = {}): Promise<SyncSummary> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const token = workspace.hubspotAccessToken;
  if (!token) throw new Error("HubSpot isn't connected");
  const filter = readHubspotFilter(workspace.hubspotLeadFilter);
  const startedAt = new Date();
  // Stay well inside the request's time limit; the cursor below picks up
  // where this left off.
  const deadline = startedAt.getTime() + (options.budgetMs ?? 45_000);
  const since = !options.full && workspace.hubspotLeadsSyncedAt ? workspace.hubspotLeadsSyncedAt.getTime() - 60_000 : null;

  const filters = [
    ...(filter.lifecycleStages.length ? [{ propertyName: "lifecyclestage", operator: "IN", values: filter.lifecycleStages }] : []),
    ...(filter.leadStatuses.length ? [{ propertyName: "hs_lead_status", operator: "IN", values: filter.leadStatuses }] : []),
    ...(since ? [{ propertyName: "lastmodifieddate", operator: "GT", value: String(since) }] : []),
  ];
  const members = await membersByEmail(workspaceId);
  const ownerEmail = ownerLookup(token);
  const results: UpsertResult[] = [];
  let after: string | undefined;
  let lastModified: string | null = null;
  do {
    const page: { results: Contact[]; paging?: { next?: { after: string } } } = await hs(token, "/crm/v3/objects/contacts/search", {
      method: "POST",
      body: JSON.stringify({
        ...(filters.length ? { filterGroups: [{ filters }] } : {}),
        sorts: [{ propertyName: "lastmodifieddate", direction: "ASCENDING" }],
        properties: CONTACT_PROPS,
        limit: 100,
        ...(after ? { after } : {}),
      }),
    });
    for (const c of page.results) {
      if (Date.now() >= deadline) break;
      results.push(await upsertCrmLead(workspaceId, await toRecord(c, ownerEmail), { members, teamOwnedOnly: filter.teamOwnedOnly }));
      lastModified = c.properties.lastmodifieddate ?? lastModified;
    }
    after = page.paging?.next?.after;
  } while (after && results.length < MAX_PER_SYNC && Date.now() < deadline);
  const more = Boolean(after) || Date.now() >= deadline;

  const syncedTo = more && lastModified ? new Date(Number(lastModified) || Date.parse(lastModified)) : startedAt;
  await prisma.workspace.update({ where: { id: workspaceId }, data: { hubspotLeadsSyncedAt: Number.isNaN(syncedTo.getTime()) ? startedAt : syncedTo } });
  await notifyCrmAssignments(workspaceId, "hubspot", results);
  await announceCreatedLeads(workspaceId, results);
  return summarize(results, more);
}

// Webhook path: the contacts HubSpot just told us about, re-read from the
// API (the event only carries an id) and checked against the filter.
export async function importHubspotContacts(workspaceId: string, contactIds: string[]): Promise<SyncSummary> {
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const token = workspace.hubspotAccessToken;
  if (!token || !workspace.hubspotLeadImport) return { created: 0, updated: 0, skipped: 0 };
  const filter = readHubspotFilter(workspace.hubspotLeadFilter);
  const members = await membersByEmail(workspaceId);
  const ownerEmail = ownerLookup(token);
  const results: UpsertResult[] = [];
  for (let i = 0; i < contactIds.length; i += 100) {
    const batch = await hs<{ results: Contact[] }>(token, "/crm/v3/objects/contacts/batch/read", {
      method: "POST",
      body: JSON.stringify({ properties: CONTACT_PROPS, inputs: contactIds.slice(i, i + 100).map((id) => ({ id })) }),
    });
    for (const c of batch.results) {
      // A contact that doesn't match the filter (yet) isn't brought in; one
      // already here keeps updating.
      const known = await findLeadByCrmId(workspaceId, "hubspot", c.id);
      if (!known && !matchesFilter(c, filter)) continue;
      results.push(await upsertCrmLead(workspaceId, await toRecord(c, ownerEmail), { members, teamOwnedOnly: filter.teamOwnedOnly }));
    }
  }
  await notifyCrmAssignments(workspaceId, "hubspot", results);
  await announceCreatedLeads(workspaceId, results);
  return summarize(results);
}

// HubSpot signs webhook calls with the Private App's client secret. v3
// (HMAC with a timestamp) when present, otherwise the older v1/v2 hashes.
export function verifyHubspotSignature(options: { secret: string; method: string; url: string; body: string; headers: Headers }): boolean {
  const { secret, method, url, body, headers } = options;
  const eq = (a: string, b: string) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const v3 = headers.get("x-hubspot-signature-v3");
  const timestamp = headers.get("x-hubspot-request-timestamp");
  if (v3 && timestamp) {
    if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
    const uri = url.replace(/%3A/gi, ":").replace(/%2F/gi, "/").replace(/%3F/gi, "?").replace(/%40/gi, "@").replace(/%21/gi, "!").replace(/%24/gi, "$").replace(/%27/gi, "'").replace(/%28/gi, "(").replace(/%29/gi, ")").replace(/%2A/gi, "*").replace(/%2C/gi, ",").replace(/%3B/gi, ";");
    const expected = crypto.createHmac("sha256", secret).update(`${method}${uri}${body}${timestamp}`, "utf8").digest("base64");
    return eq(expected, v3);
  }
  const v1v2 = headers.get("x-hubspot-signature");
  if (!v1v2) return false;
  const version = headers.get("x-hubspot-signature-version");
  const source = version === "v2" ? `${secret}${method}${url}${body}` : `${secret}${body}`;
  return eq(crypto.createHash("sha256").update(source, "utf8").digest("hex"), v1v2);
}
