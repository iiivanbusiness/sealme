import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { isLeadStage, LEAD_INTERESTS } from "@/lib/lead-stages";
import { INACTIVE_STAGES } from "@/lib/lead-pipeline";

// Leads are part of Prospecting, which is turned on per workspace.
export async function prospectingOn(workspaceId: string): Promise<boolean> {
  // Every workspace has leads now (see requireProspecting); the 403 these
  // routes still check for can't happen anymore.
  void workspaceId;
  return true;
}

type LeadInput = {
  name?: string;
  company?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  domain?: string | null;
  notes?: string | null;
  stage?: string;
  interest?: string | null;
  nextStep?: string | null;
  nextStepAt?: Date | null;
  ownerId?: string | null;
  convertedAt?: Date | null;
  externalId?: string | null;
  campaign?: string | null;
};

// Reads the lead fields a request sent. Only keys that are present are
// returned, so PATCH changes just those; null clears a field.
export async function parseLeadInput(workspaceId: string, body: Record<string, unknown>, options: { requireName: boolean }): Promise<{ data: LeadInput } | { error: string }> {
  const data: LeadInput = {};
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
  const str = (k: string, max: number): string | null | undefined => {
    if (!has(k)) return undefined;
    const v = body[k];
    if (v === null) return null;
    if (typeof v !== "string") return undefined;
    return v.trim().slice(0, max) || null;
  };

  const name = str("name", 200);
  if (options.requireName && !name) return { error: "\"name\" is required" };
  if (has("name") && !name) return { error: "\"name\" can't be empty" };
  if (name) data.name = name;

  for (const [k, max] of [["company", 200], ["title", 200], ["notes", 4000], ["nextStep", 500], ["campaign", 100]] as const) {
    const v = str(k, max);
    if (v !== undefined) data[k] = v;
  }

  const email = str("email", 200);
  if (email !== undefined) {
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: "\"email\" doesn't look like an email address" };
    data.email = email?.toLowerCase() ?? null;
  }
  const phone = str("phone", 50);
  if (phone !== undefined) data.phone = phone ? (normalizePhone(phone) ?? phone) : null;
  const domain = str("domain", 200);
  if (domain !== undefined) data.domain = domain ? domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null;

  if (has("stage")) {
    const stage = body.stage;
    if (typeof stage !== "string" || !isLeadStage(stage)) return { error: "\"stage\" must be one of new, contacted, interested, meeting, converted, lost" };
    data.stage = stage;
    data.convertedAt = stage === "converted" ? new Date() : null;
  }
  const interest = str("interest", 10);
  if (interest !== undefined) {
    if (interest && !(LEAD_INTERESTS as readonly string[]).includes(interest)) return { error: "\"interest\" must be cold, warm or hot" };
    data.interest = interest;
  }
  const nextStepAt = str("nextStepAt", 10);
  if (nextStepAt !== undefined) {
    if (nextStepAt && !/^\d{4}-\d{2}-\d{2}$/.test(nextStepAt)) return { error: "\"nextStepAt\" must be a date like 2026-10-31" };
    data.nextStepAt = nextStepAt ? new Date(`${nextStepAt}T00:00:00Z`) : null;
    if (data.nextStepAt && Number.isNaN(data.nextStepAt.getTime())) return { error: "\"nextStepAt\" isn't a real date" };
  }

  // Their own id for the lead. A number is fine too; it's kept as text.
  if (has("externalId")) {
    const v = body.externalId;
    if (v !== null && typeof v !== "string" && typeof v !== "number") return { error: "\"externalId\" must be a string" };
    const id = v === null ? null : String(v).trim();
    if (id !== null && id.length > 200) return { error: "\"externalId\" can be up to 200 characters" };
    data.externalId = id || null;
  }

  const ownerEmail = str("ownerEmail", 200);
  if (ownerEmail !== undefined) {
    if (!ownerEmail) data.ownerId = null;
    else {
      const owner = await prisma.user.findFirst({ where: { workspaceId, email: { equals: ownerEmail, mode: "insensitive" }, deactivatedAt: null }, select: { id: true } });
      if (!owner) return { error: "\"ownerEmail\" doesn't match anyone active in this workspace" };
      data.ownerId = owner.id;
    }
  }
  return { data };
}

// What a stage sent through the API does to where the lead is on the Leads
// list (pipelineStage). Written with the lead's other fields; notClient: only
// while the lead isn't a client, so a signature landing in the meantime wins;
// refresh: work the real stage out after the write, since a proposal or
// contract may still be out; dropStage: the lead is a client, so the stage
// sent is left out of the write (withoutStage).
export type StagePipeline = { data: { pipelineStage?: string; lastActivityAt?: Date }; notClient: boolean; refresh: boolean; dropStage?: true };

// A client's stage is converted for good: a signed contract made it one. A
// stage sent for a client is left out rather than refused, so a sync that
// sends a stage for every lead each night still gets its other changes in.
// What the stage brings along goes too (when it was converted, where the
// lead is on the list).
export function withoutStage<T extends { stage?: string; convertedAt?: Date | null; pipelineStage?: string; lastActivityAt?: Date }>(data: T): T {
  const rest = { ...data };
  delete rest.stage;
  delete rest.convertedAt;
  delete rest.pipelineStage;
  delete rest.lastActivityAt;
  return rest;
}

// The old stage names keep working and move the lead the way the app does:
// lost takes it off Active (Mark as lost), and new, contacted, interested or
// meeting bring a lead that's set aside back (Reactivate). converted is only
// recorded: a lead becomes a client when a contract on it is signed.
// existing is the lead as it is, null for a new one.
export function apiStagePipeline(
  existing: { stage: string; isClient: boolean; pipelineStage: string } | null,
  stage: string | undefined,
  now = new Date(),
): StagePipeline {
  if (stage === undefined || stage === "converted") return { data: {}, notClient: false, refresh: false };
  if (existing?.isClient) return { data: {}, notClient: false, refresh: false, dropStage: true };
  if (stage === "lost") return { data: { pipelineStage: "lost" }, notClient: existing !== null, refresh: false };
  // Sending the stage it already has changes nothing, so a sync that sends
  // every lead each night doesn't undo a rep's Not now or a contract that
  // went unsigned. Back on Active the way Reactivate does it: active today.
  const revive = existing !== null && INACTIVE_STAGES.includes(existing.pipelineStage) && existing.stage !== stage;
  return { data: revive ? { pipelineStage: "new", lastActivityAt: now } : {}, notClient: existing !== null, refresh: revive };
}
