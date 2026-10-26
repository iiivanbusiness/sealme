// GoHighLevel (LeadConnector) API v2, with a sub-account's Private
// Integration token. Everything a sub-account owns is keyed by its Location
// ID, which the admin pastes next to the token in Settings. One-way: SealMe
// writes contacts, notes, tasks and opportunities and reads only pipelines.

const GHL_API = "https://services.leadconnectorhq.com";
// The API version GoHighLevel's own Private Integration examples use, still
// supported with no end date.
const GHL_VERSION = "2021-07-28";

export type GhlPipeline = { id: string; name: string; stages: { id: string; name: string }[] };

async function ghl<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GHL_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json", "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`GoHighLevel ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

// Also how a token and Location ID are checked when they're pasted in: the
// call fails unless the token belongs to that sub-account.
export async function listGhlPipelines(token: string, locationId: string): Promise<GhlPipeline[]> {
  const data = await ghl<{ pipelines?: { id: string; name: string; stages?: { id: string; name: string }[] }[] }>(
    token,
    `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
  );
  return (data.pipelines ?? []).map((p) => ({ id: p.id, name: p.name, stages: (p.stages ?? []).map((s) => ({ id: s.id, name: s.name })) }));
}

export function ghlNameParts(name: string): { firstName: string; lastName?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? { firstName: parts[0], lastName: parts.slice(1).join(" ") } : { firstName: parts[0] ?? name };
}

// Finds the contact by email or phone (per the sub-account's duplicate
// setting) or makes it.
export async function upsertGhlContact(
  token: string,
  locationId: string,
  person: { name: string; email: string | null; phone: string | null; company: string | null },
): Promise<string> {
  const data = await ghl<{ contact?: { id?: string } }>(token, "/contacts/upsert", {
    method: "POST",
    body: JSON.stringify({
      locationId,
      ...ghlNameParts(person.name),
      name: person.name,
      ...(person.email ? { email: person.email } : {}),
      ...(person.phone ? { phone: person.phone } : {}),
      ...(person.company ? { companyName: person.company } : {}),
      source: "SealMe",
    }),
  });
  if (!data.contact?.id) throw new Error("GoHighLevel didn't return the contact");
  return data.contact.id;
}

export async function addGhlNote(token: string, contactId: string, body: string): Promise<string> {
  const data = await ghl<{ note?: { id?: string } }>(token, `/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
  if (!data.note?.id) throw new Error("GoHighLevel didn't return the note");
  return data.note.id;
}

export async function addGhlTask(token: string, contactId: string, task: { title: string; body: string | null; dueDate: Date }): Promise<void> {
  await ghl(token, `/contacts/${encodeURIComponent(contactId)}/tasks`, {
    method: "POST",
    body: JSON.stringify({ title: task.title, ...(task.body ? { body: task.body } : {}), dueDate: task.dueDate.toISOString(), completed: false }),
  });
}

export async function createGhlOpportunity(
  token: string,
  o: { locationId: string; pipelineId: string; stageId: string | null; contactId: string; name: string },
): Promise<string> {
  const data = await ghl<{ opportunity?: { id?: string } }>(token, "/opportunities/", {
    method: "POST",
    body: JSON.stringify({
      locationId: o.locationId,
      pipelineId: o.pipelineId,
      ...(o.stageId ? { pipelineStageId: o.stageId } : {}),
      contactId: o.contactId,
      name: o.name,
      status: "open",
    }),
  });
  if (!data.opportunity?.id) throw new Error("GoHighLevel didn't return the opportunity");
  return data.opportunity.id;
}

// The note a call leaves on the contact: what it was, the write-up, and
// what happens next.
export function ghlCallNote(call: { title: string; startedAt: Date; summary: string | null; notes: string | null; nextStep: string | null }): string {
  const day = call.startedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  return [
    `${call.title} (${day})`,
    call.summary,
    call.notes,
    call.nextStep ? `Next step: ${call.nextStep}` : null,
    "Written up by SealMe",
  ]
    .filter(Boolean)
    .join("\n\n");
}
