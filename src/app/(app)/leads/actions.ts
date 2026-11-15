"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { dispatchLeadsCreated } from "@/lib/webhooks";
import { dispatchLeadsUpdated, leadChanges } from "@/lib/webhook-events";
import { requireProspecting } from "@/lib/prospecting";
import { normalizePhone } from "@/lib/phone";
import { LEAD_INTERESTS } from "@/lib/lead-stages";
import { leadAccess } from "@/lib/lead-visibility";
import { currentUserWithRole } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";
import { INACTIVE_STAGES, refreshLeadPipeline, wentOutWhere } from "@/lib/lead-pipeline";
import { after } from "next/server";
import { dropRecording } from "@/lib/call-inbox";

function text(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
}

// Owner has to be an active member of this workspace; anything else
// (empty, someone from another workspace, a removed teammate) means
// unassigned rather than an error.
async function resolveOwner(workspaceId: string, ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  const owner = await prisma.user.findFirst({ where: { id: ownerId, workspaceId, deactivatedAt: null }, select: { id: true } });
  return owner?.id ?? null;
}

// A date input gives YYYY-MM-DD. Stored at UTC midnight and always shown
// in UTC, so the day never shifts with the viewer's timezone.
function parseDay(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

class FieldError extends Error {}

function leadFieldsFrom(formData: FormData) {
  const name = text(formData, "name");
  if (!name) throw new FieldError("Add the lead's name");
  const email = text(formData, "email")?.toLowerCase() ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new FieldError("That email doesn't look right");
  const rawPhone = text(formData, "phone");
  const interest = text(formData, "interest");
  const decisionMaker = text(formData, "isDecisionMaker");
  return {
    name,
    company: text(formData, "company"),
    title: text(formData, "title"),
    email,
    phone: normalizePhone(rawPhone) ?? rawPhone,
    domain: text(formData, "domain")?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") ?? null,
    interest: interest && (LEAD_INTERESTS as readonly string[]).includes(interest) ? interest : null,
    isDecisionMaker: decisionMaker === "yes" ? true : decisionMaker === "no" ? false : null,
    painPoints: text(formData, "painPoints"),
    objections: text(formData, "objections"),
    notes: text(formData, "notes")?.slice(0, 4000) ?? null,
    nextStep: text(formData, "nextStep"),
    nextStepAt: parseDay(text(formData, "nextStepAt")),
    campaign: text(formData, "campaign")?.slice(0, 100) ?? null,
  };
}

export async function createLead(formData: FormData) {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const fields = leadFieldsFrom(formData);
  // Only managers hand leads to someone else; a rep's new lead is theirs.
  const ownerId = access.canAssign ? await resolveOwner(workspace.id, text(formData, "ownerId")) : access.userId;

  const lead = await prisma.lead.create({
    data: { workspaceId: workspace.id, ownerId, source: "manual", ...fields },
    select: { id: true },
  });
  await dispatchLeadsCreated(workspace.id, [lead.id]);
  revalidatePath("/leads");
  redirect(`/leads/${lead.id}?created=1`);
}

export async function updateLead(leadId: string, formData: FormData) {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const existing = await prisma.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id, ...access.where } });
  if (!existing) throw new Error("Lead not found");

  let fields: ReturnType<typeof leadFieldsFrom>;
  try {
    fields = leadFieldsFrom(formData);
  } catch (err) {
    // Back to the form with what's wrong, instead of an error page. The form
    // checks the same things first, so this is rare.
    if (err instanceof FieldError) redirect(`/leads/${leadId}?edit=1&error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  const ownerId = access.canAssign ? await resolveOwner(workspace.id, text(formData, "ownerId")) : existing.ownerId;
  await prisma.lead.update({ where: { id: leadId }, data: { ...fields, ownerId } });
  await dispatchLeadsUpdated(workspace.id, [leadChanges(leadId, existing, { ...fields, ownerId })]);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  redirect(`/leads/${leadId}?saved=1`);
}

// Managers only. Tasks go with the lead (cascade), and so do its calls. Its
// proposal and contract drafts go to the trash. A client is kept, and so is
// a lead whose proposal or contract ever went out to the client (that's a
// record of what they got): mark it lost instead. So is one with a call
// still going or being written up. keptClients: how many of the kept are
// clients, which can't be marked lost either.
export async function deleteLeads(leadIds: string[]): Promise<{ deleted: number; kept: number; keptClients: number }> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  if (!access.canAssign) throw new Error("Only managers can delete leads");
  if (!Array.isArray(leadIds) || leadIds.length === 0) return { deleted: 0, kept: 0, keptClients: 0 };
  if (leadIds.length > 1000) throw new Error("Delete up to 1,000 leads at a time");

  const leads = await prisma.lead.findMany({
    where: { workspaceId: workspace.id, id: { in: leadIds.map(String) }, AND: [access.where] },
    select: {
      id: true,
      // A client brought in from Settings has a signed contract that never
      // went out through SealMe (no sentAt): still a client, still kept.
      isClient: true,
      deals: { where: { contract: wentOutWhere }, select: { id: true }, take: 1 },
      phoneCalls: { where: { status: { in: ["dialing", "recording", "processing"] } }, select: { id: true }, take: 1 },
    },
  });
  const ids = leads.filter((l) => !l.isClient && l.deals.length === 0 && l.phoneCalls.length === 0).map((l) => l.id);
  const kept = leads.length - ids.length;
  const keptClients = leads.filter((l) => l.isClient).length;
  if (ids.length === 0) return { deleted: 0, kept, keptClients };

  const user = await currentUserWithRole();
  const [recordings, contracts] = await Promise.all([
    prisma.phoneCall.findMany({ where: { leadId: { in: ids }, telnyxRecordingId: { not: null } }, select: { id: true, telnyxRecordingId: true } }),
    prisma.contract.findMany({ where: { deal: { workspaceId: workspace.id, leadId: { in: ids }, trashedAt: null } }, select: { id: true } }),
  ]);
  const contractIds = contracts.map((c) => c.id);
  await prisma.$transaction([
    prisma.deal.updateMany({ where: { workspaceId: workspace.id, leadId: { in: ids }, trashedAt: null }, data: { trashedAt: new Date() } }),
    // A draft waiting on a reviewer stops waiting: nothing is approved and
    // sent from the trash.
    prisma.reviewStep.deleteMany({ where: { contractId: { in: contractIds }, status: "pending" } }),
    prisma.contract.updateMany({ where: { id: { in: contractIds }, status: "pending_approval" }, data: { status: "draft" } }),
    prisma.phoneCall.deleteMany({ where: { leadId: { in: ids } } }),
    prisma.lead.deleteMany({ where: { id: { in: ids } } }),
  ]);
  // Recordings still kept at Telnyx go with their calls.
  if (recordings.length) after(async () => {
    for (const r of recordings) await dropRecording(r.telnyxRecordingId, r.id);
  });
  await logAudit({ workspaceId: workspace.id, actorEmail: user.email, action: "lead.deleted", targetType: "lead", targetId: ids.length === 1 ? ids[0] : undefined, metadata: { count: ids.length, kept } });

  revalidatePath("/leads");
  revalidatePath("/dashboard");
  revalidatePath("/team");
  return { deleted: ids.length, kept, keptClients };
}

// The "Delete lead" button on a lead's own page.
export async function deleteLead(leadId: string): Promise<{ error?: string }> {
  const { deleted, keptClients } = await deleteLeads([leadId]);
  if (!deleted) {
    const busy = await prisma.phoneCall.count({ where: { leadId, status: { in: ["dialing", "recording", "processing"] } } });
    if (busy) return { error: "A call on this lead is still going or being written up. Try again once it's done." };
    if (keptClients) return { error: "This lead is a client: they signed a contract, so it can't be deleted." };
    return { error: "This lead's proposal or contract went out to the client, so it can't be deleted. Mark it as lost instead." };
  }
  // The page sends them back to the list (a redirect here would land in the
  // caller's catch).
  return {};
}

// "Mark as lost" in a lead's menu: off the Active list until someone
// reactivates it or a new call comes in.
export async function markLeadLost(leadId: string): Promise<void> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const before = await prisma.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id, ...access.where }, select: { stage: true, isClient: true } });
  if (!before) throw new Error("Lead not found");
  if (before.isClient) throw new Error("A client can't be marked lost");
  // Not over a signature that landed in the meantime.
  const { count } = await prisma.lead.updateMany({ where: { id: leadId, isClient: false }, data: { pipelineStage: "lost", stage: "lost", convertedAt: null } });
  if (count === 0) throw new Error("A client can't be marked lost");
  await dispatchLeadsUpdated(workspace.id, [leadChanges(leadId, before, { stage: "lost" })]);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

// "Not now" in a lead's menu: set aside for later (on Inactive), without
// calling it lost. A new call or Reactivate brings it back.
export async function markLeadNotNow(leadId: string): Promise<void> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const before = await prisma.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id, ...access.where }, select: { id: true } });
  if (!before) throw new Error("Lead not found");
  const { count } = await prisma.lead.updateMany({ where: { id: leadId, isClient: false }, data: { pipelineStage: "not_now" } });
  if (count === 0) throw new Error("A client can't be set aside");
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}

// "Reactivate": back on the Active list, from lost, not now, a contract that
// went unsigned, or a month with nothing going on.
export async function reactivateLead(leadId: string): Promise<void> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const before = await prisma.lead.findFirst({ where: { id: leadId, workspaceId: workspace.id, ...access.where }, select: { stage: true, pipelineStage: true } });
  if (!before) throw new Error("Lead not found");
  const stage = before.stage === "lost" ? "contacted" : before.stage;
  await prisma.lead.update({
    where: { id: leadId },
    data: { lastActivityAt: new Date(), stage, ...(INACTIVE_STAGES.includes(before.pipelineStage) ? { pipelineStage: "new" } : {}) },
  });
  await refreshLeadPipeline(leadId);
  if (stage !== before.stage) await dispatchLeadsUpdated(workspace.id, [leadChanges(leadId, before, { stage })]);
  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
}
