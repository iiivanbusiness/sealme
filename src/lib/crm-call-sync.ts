import { prisma } from "@/lib/db";
import { CALL_OUTCOME_LABEL, UNREACHED_OUTCOMES } from "@/lib/call-outcomes";
import { salesforceGet, salesforceRequest, SALESFORCE_API_VERSION } from "@/lib/salesforce";
import { reportError } from "@/lib/error-report";
import { NEW_LEAD_NAME } from "@/lib/cold-call";
import { addGhlNote, addGhlTask, createGhlOpportunity, ghlCallNote, upsertGhlContact } from "@/lib/gohighlevel";

const HUBSPOT_API = "https://api.hubapi.com";
// HubSpot's own association type for call -> contact.
const HUBSPOT_CALL_TO_CONTACT = 194;

// HubSpot's built-in Lead Status values, by what happened on the call. A
// portal can switch values off, so each is checked against the portal's
// options before it's written.
export function hubspotLeadStatusFor(outcome: string): string | null {
  if (UNREACHED_OUTCOMES.has(outcome)) return "ATTEMPTED_TO_CONTACT";
  if (outcome === "meeting_booked" || outcome === "interested") return "IN_PROGRESS";
  if (outcome === "follow_up" || outcome === "wrong_person") return "CONNECTED";
  if (outcome === "not_interested") return "UNQUALIFIED";
  return null;
}

// Statuses a call shouldn't move a contact away from: the deal's already
// open, or someone closed it out on purpose.
const HUBSPOT_SETTLED = new Set(["OPEN_DEAL", "UNQUALIFIED"]);

// Salesforce Lead Status values are set up per org, so the target is picked
// from the org's own list by what it says: a "working / contacted" status
// for any call, a "closed, not converted" one when they said no.
export function salesforceLeadStatusFor(outcome: string, available: string[]): string | null {
  const find = (re: RegExp) => available.find((v) => re.test(v)) ?? null;
  if (outcome === "not_interested") return find(/not\s*converted|unqualified|disqualified/i);
  // "Open - Not Contacted" says contacted too, so it's ruled out by name.
  return find(/working/i) ?? available.find((v) => /contacted|attempt/i.test(v) && !/not\s+contacted/i.test(v)) ?? null;
}

// Statuses a call shouldn't overwrite: converted or closed leads.
const SALESFORCE_SETTLED = /converted|closed|qualified/i;

function callTitle(call: { mode: string; outcome: string | null }): string {
  if (call.mode === "sales") return "SealMe sales call";
  return `SealMe call: ${CALL_OUTCOME_LABEL[call.outcome ?? ""] ?? "Call"}`;
}

async function hubspot<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HUBSPOT_API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`HubSpot ${path.split("?")[0]} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type CallForCrm = {
  id: string;
  mode: string;
  outcome: string | null;
  summary: string | null;
  durationSec: number | null;
  startedAt: Date;
  hubspotCallId: string | null;
  salesforceTaskId: string | null;
};

async function logToHubspot(token: string, contactId: string, call: CallForCrm): Promise<string> {
  const created = await hubspot<{ id: string }>(token, "/crm/v3/objects/calls", {
    method: "POST",
    body: JSON.stringify({
      properties: {
        hs_timestamp: call.startedAt.toISOString(),
        hs_call_title: callTitle(call),
        hs_call_body: call.summary ?? "",
        hs_call_direction: "OUTBOUND",
        hs_call_status: "COMPLETED",
        ...(call.durationSec ? { hs_call_duration: String(call.durationSec * 1000) } : {}),
      },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: HUBSPOT_CALL_TO_CONTACT }] }],
    }),
  });

  const target = call.outcome ? hubspotLeadStatusFor(call.outcome) : null;
  if (target) {
    const [property, contact] = await Promise.all([
      hubspot<{ options?: { value: string; hidden?: boolean }[] }>(token, "/crm/v3/properties/contacts/hs_lead_status"),
      hubspot<{ properties: { hs_lead_status?: string | null } }>(token, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=hs_lead_status`),
    ]);
    const offered = (property.options ?? []).some((o) => o.value === target && !o.hidden);
    const current = contact.properties.hs_lead_status ?? "";
    if (offered && current !== target && !HUBSPOT_SETTLED.has(current)) {
      await hubspot(token, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { method: "PATCH", body: JSON.stringify({ properties: { hs_lead_status: target } }) });
    }
  }
  return created.id;
}

async function logToSalesforce(workspaceId: string, recordId: string, recordType: string | null, call: CallForCrm): Promise<string> {
  const base = `/services/data/${SALESFORCE_API_VERSION}/sobjects`;
  const core = {
    WhoId: recordId,
    Subject: callTitle(call),
    Description: call.summary ?? "",
    Status: "Completed",
    ActivityDate: call.startedAt.toISOString().slice(0, 10),
  };
  // The call-specific fields make it show up as a logged call; an org that
  // trimmed the Task picklists still gets a plain completed task.
  let res = await salesforceRequest(workspaceId, `${base}/Task`, {
    method: "POST",
    // No "Type": smaller editions (Starter) don't have that field at all.
    body: JSON.stringify({ ...core, TaskSubtype: "Call", CallType: "Outbound", ...(call.durationSec ? { CallDurationInSeconds: call.durationSec } : {}) }),
  });
  if (res.status === 400) res = await salesforceRequest(workspaceId, `${base}/Task`, { method: "POST", body: JSON.stringify(core) });
  if (!res.ok) throw new Error(`Salesforce Task creation failed: ${res.status} ${await res.text()}`);
  const task = (await res.json()) as { id: string };

  if (recordType !== "Contact" && call.outcome) {
    const describe = await salesforceGet<{ fields: { name: string; picklistValues?: { value: string; active: boolean }[] }[] }>(workspaceId, `${base}/Lead/describe`);
    const available = (describe.fields.find((f) => f.name === "Status")?.picklistValues ?? []).filter((p) => p.active).map((p) => p.value);
    const target = salesforceLeadStatusFor(call.outcome, available);
    if (target) {
      const lead = await salesforceGet<{ Status?: string | null; IsConverted?: boolean }>(workspaceId, `${base}/Lead/${encodeURIComponent(recordId)}?fields=Status,IsConverted`);
      const current = lead.Status ?? "";
      if (!lead.IsConverted && current !== target && !SALESFORCE_SETTLED.test(current)) {
        const patch = await salesforceRequest(workspaceId, `${base}/Lead/${encodeURIComponent(recordId)}`, { method: "PATCH", body: JSON.stringify({ Status: target }) });
        if (!patch.ok && patch.status !== 204) throw new Error(`Salesforce Lead status update failed: ${patch.status} ${await patch.text()}`);
      }
    }
  }
  return task.id;
}

// What a next step reads as in another CRM.
function nextStepTitle(type: string, leadName: string): string {
  if (type === "follow_up") return `Follow up with ${leadName}`;
  if (type === "sales_call") return `Sales call with ${leadName}`;
  if (type === "cold_call") return `Call ${leadName}`;
  return `To-do: ${leadName}`;
}

type GhlWorkspace = { ghlLocationId: string; ghlAccessToken: string; ghlPipelineId: string | null; ghlStageId: string | null };
type GhlLead = { id: string; name: string; email: string | null; phone: string | null; company: string | null; ghlContactId: string | null; ghlOpportunityId: string | null };

// GoHighLevel: unlike HubSpot and Salesforce, these leads mostly start in
// SealMe, so the contact is found (by email or phone) or made the first
// time. Then the write-up goes on as a note, the call's next step as a task,
// and the first call opens an opportunity when a pipeline is picked.
async function logToGohighlevel(workspace: GhlWorkspace, lead: GhlLead, call: CallForCrm & { notes: string | null }): Promise<string> {
  const token = workspace.ghlAccessToken;
  let contactId = lead.ghlContactId;
  if (!contactId) {
    contactId = await upsertGhlContact(token, workspace.ghlLocationId, { name: lead.name, email: lead.email, phone: lead.phone, company: lead.company });
    await prisma.lead.update({ where: { id: lead.id }, data: { ghlContactId: contactId } });
  }

  // The next step this call set: the lead's open to-do made since it started.
  const next = await prisma.task.findFirst({
    where: { leadId: lead.id, status: "open", createdAt: { gte: call.startedAt } },
    select: { type: true, note: true, dueDate: true },
    orderBy: { dueDate: "asc" },
  });
  const nextTitle = next ? nextStepTitle(next.type, lead.name) : null;

  const noteId = await addGhlNote(
    token,
    contactId,
    ghlCallNote({ title: callTitle(call), startedAt: call.startedAt, summary: call.summary, notes: call.notes, nextStep: next ? [nextTitle, next.note].filter(Boolean).join(": ") : null }),
  );
  // Midday UTC of the due day, so it lands on the same date in any timezone.
  if (next && nextTitle) await addGhlTask(token, contactId, { title: nextTitle, body: next.note, dueDate: new Date(next.dueDate.getTime() + 12 * 60 * 60 * 1000) });

  if (workspace.ghlPipelineId && !lead.ghlOpportunityId) {
    const opportunityId = await createGhlOpportunity(token, {
      locationId: workspace.ghlLocationId,
      pipelineId: workspace.ghlPipelineId,
      stageId: workspace.ghlStageId,
      contactId,
      name: lead.company ? `${lead.company} (${lead.name})` : lead.name,
    });
    await prisma.lead.update({ where: { id: lead.id }, data: { ghlOpportunityId: opportunityId } });
  }
  return noteId;
}

// After a call is processed: the call and its summary go onto the lead in
// the CRM it came from, and its status there moves along. Only for leads
// that came from HubSpot or Salesforce, only while that integration is on,
// and only once per call. GoHighLevel, when connected, gets every processed
// call with a named lead (see logToGohighlevel). Never throws; a failure is
// reported and the call in SealMe is unaffected.
export async function pushCallToCrm(callId: string): Promise<void> {
  const call = await prisma.phoneCall.findUnique({
    where: { id: callId },
    select: {
      id: true,
      status: true,
      source: true,
      mode: true,
      outcome: true,
      summary: true,
      notes: true,
      durationSec: true,
      startedAt: true,
      hubspotCallId: true,
      salesforceTaskId: true,
      ghlNoteId: true,
      lead: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          company: true,
          hubspotContactId: true,
          salesforceRecordId: true,
          salesforceRecordType: true,
          ghlContactId: true,
          ghlOpportunityId: true,
        },
      },
      workspace: {
        select: {
          id: true,
          hubspotEnabled: true,
          hubspotAccessToken: true,
          salesforceEnabled: true,
          salesforceRefreshToken: true,
          ghlEnabled: true,
          ghlLocationId: true,
          ghlAccessToken: true,
          ghlPipelineId: true,
          ghlStageId: true,
        },
      },
    },
  });
  // A call logged through the API came from the customer's own dialer,
  // which logs it to their CRM already.
  if (!call || call.status !== "processed" || !call.lead || call.source === "api") return;
  const { lead, workspace } = call;

  if (lead.hubspotContactId && workspace.hubspotEnabled && workspace.hubspotAccessToken && !call.hubspotCallId) {
    try {
      const hubspotCallId = await logToHubspot(workspace.hubspotAccessToken, lead.hubspotContactId, call);
      await prisma.phoneCall.update({ where: { id: call.id }, data: { hubspotCallId } });
    } catch (err) {
      await reportError(err, "Logging a call to HubSpot", { workspaceId: workspace.id, callId });
    }
  }

  // A lead the call couldn't name yet would only make a nameless contact.
  const named = lead.name !== NEW_LEAD_NAME || Boolean(lead.email || lead.phone);
  if (workspace.ghlEnabled && workspace.ghlAccessToken && workspace.ghlLocationId && !call.ghlNoteId && named) {
    try {
      const ghlNoteId = await logToGohighlevel(
        { ghlLocationId: workspace.ghlLocationId, ghlAccessToken: workspace.ghlAccessToken, ghlPipelineId: workspace.ghlPipelineId, ghlStageId: workspace.ghlStageId },
        lead,
        call,
      );
      await prisma.phoneCall.update({ where: { id: call.id }, data: { ghlNoteId } });
    } catch (err) {
      await reportError(err, "Logging a call to GoHighLevel", { workspaceId: workspace.id, callId });
    }
  }

  if (lead.salesforceRecordId && workspace.salesforceEnabled && workspace.salesforceRefreshToken && !call.salesforceTaskId) {
    try {
      const salesforceTaskId = await logToSalesforce(workspace.id, lead.salesforceRecordId, lead.salesforceRecordType, call);
      await prisma.phoneCall.update({ where: { id: call.id }, data: { salesforceTaskId } });
    } catch (err) {
      await reportError(err, "Logging a call to Salesforce", { workspaceId: workspace.id, callId });
    }
  }
}
