import { prisma } from "@/lib/db";
import { parseFee } from "@/lib/money";
import { reportError } from "@/lib/error-report";

// A per-workspace HubSpot Private App token, pasted in Settings — not
// OAuth. HubSpot disabled creating new "public" OAuth apps outside their
// CLI/Projects flow, so each workspace makes its own Private App in its
// own HubSpot account (Settings -> Integrations -> Private Apps, with the
// crm.objects.contacts/deals read+write scopes) and pastes the resulting
// token here. Deliberately one-directional (SealMe -> HubSpot push only) —
// a real two-way sync needs HubSpot's own webhook subscriptions and
// conflict resolution, a separate decision if a customer needs it.

type HubspotObject = { id: string; properties: Record<string, string> };

async function hubspotFetch(accessToken: string, path: string, init?: RequestInit): Promise<HubspotObject> {
  const res = await fetch(`https://api.hubapi.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`HubSpot API ${path} failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<HubspotObject>;
}

// Called once, when a token is pasted into Settings — proves the token is
// actually valid and returns the portal it belongs to, so Settings can
// show "connected to portal 12345" instead of just trusting the paste.
// Throws with HubSpot's own message on an invalid/revoked token.
export async function validateHubspotToken(accessToken: string): Promise<{ portalId: string }> {
  const res = await fetch("https://api.hubapi.com/account-info/v3/details", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`That token isn't valid: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { portalId?: number };
  if (!data.portalId) throw new Error("HubSpot didn't return a portal id for that token");
  return { portalId: String(data.portalId) };
}

// SealMe keeps one name; HubSpot shows firstname + lastname, so the full
// name in firstname alone doubles up on a contact that has a last name.
export function hubspotNameParts(name: string): { firstname: string; lastname?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? { firstname: parts[0], lastname: parts.slice(1).join(" ") } : { firstname: parts[0] ?? name };
}

// HubSpot refuses a second contact with an email it already has, and says
// which contact that is: "Contact already exists. Existing ID: 123".
export function existingHubspotContactId(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(" 409 ") ? (message.match(/Existing ID: (\d+)/)?.[1] ?? null) : null;
}

// Creates the Contact on first sync, updates it on every later one —
// hubspotContactId on our Client row is the join key. A client whose email
// is already in HubSpot (a repeat client, or someone the team added there
// first) takes over that contact instead of failing the whole sync.
async function upsertContact(accessToken: string, client: { id: string; name: string; company: string; email: string | null; hubspotContactId: string | null }): Promise<string> {
  const properties = { email: client.email ?? undefined, ...hubspotNameParts(client.name), company: client.company };
  if (client.hubspotContactId) {
    await hubspotFetch(accessToken, `/crm/v3/objects/contacts/${client.hubspotContactId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
    return client.hubspotContactId;
  }
  let contactId: string;
  try {
    contactId = (await hubspotFetch(accessToken, "/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({ properties }) })).id;
  } catch (err) {
    const existing = existingHubspotContactId(err);
    if (!existing) throw err;
    await hubspotFetch(accessToken, `/crm/v3/objects/contacts/${existing}`, { method: "PATCH", body: JSON.stringify({ properties }) });
    contactId = existing;
  }
  await prisma.client.update({ where: { id: client.id }, data: { hubspotContactId: contactId } });
  return contactId;
}

async function upsertDeal(
  accessToken: string,
  deal: { id: string; service: string; feeDisplay: string; status: string; hubspotDealId: string | null },
  contactId: string
): Promise<string> {
  const amount = parseFee(deal.feeDisplay);
  const properties: Record<string, string> = { dealname: deal.service || "SealMe deal", amount: String(amount) };

  let dealId: string;
  if (deal.hubspotDealId) {
    await hubspotFetch(accessToken, `/crm/v3/objects/deals/${deal.hubspotDealId}`, { method: "PATCH", body: JSON.stringify({ properties }) });
    dealId = deal.hubspotDealId;
  } else {
    const created = await hubspotFetch(accessToken, "/crm/v3/objects/deals", { method: "POST", body: JSON.stringify({ properties }) });
    dealId = created.id;
    await prisma.deal.update({ where: { id: deal.id }, data: { hubspotDealId: dealId } });
  }

  // Best-effort — a deal synced without its contact association is still
  // useful, so this failing shouldn't undo the deal/contact upserts above.
  try {
    await fetch(`https://api.hubapi.com/crm/v4/objects/deals/${dealId}/associations/default/contacts/${contactId}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch (err) {
    console.error(`HubSpot deal-contact association failed for deal ${dealId}`, err);
  }

  return dealId;
}

// Pushes one deal (and its client, as a Contact) to HubSpot — called
// alongside dispatchWebhookEvent/notifySlack at the same event sites
// (deal.created, contract.sent, contract.signed). Never throws into the
// caller; a failure is reported, same contract as Salesforce's.
export async function syncDealToHubspot(workspaceId: string, dealId: string): Promise<void> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace || !workspace.hubspotEnabled || !workspace.hubspotAccessToken) return;

  try {
    const deal = await prisma.deal.findUnique({ where: { id: dealId }, include: { client: true } });
    if (!deal) return;

    const contactId = await upsertContact(workspace.hubspotAccessToken, deal.client);
    await upsertDeal(workspace.hubspotAccessToken, deal, contactId);
  } catch (err) {
    console.error(`HubSpot sync failed for deal ${dealId}`, err);
    await reportError(err, "HubSpot deal sync", { workspaceId, dealId });
  }
}
