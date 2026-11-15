import { prisma } from "@/lib/db";
import { apiGuard, apiJson, apiError, readJsonObject } from "@/lib/api-auth";
import { LEAD_API_SELECT, serializeLead } from "@/lib/api-serialize";
import { apiStagePipeline, parseLeadInput, prospectingOn, withoutStage } from "@/lib/api-leads";
import { dispatchLeadsUpdated, leadChanges } from "@/lib/webhook-events";
import { refreshLeadPipeline } from "@/lib/lead-pipeline";

const NOT_ON = "Leads aren't turned on for this workspace";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await apiGuard(req);
  if (auth instanceof Response) return auth;
  if (!(await prospectingOn(auth.workspaceId))) return apiError(403, NOT_ON);

  const { id } = await params;
  const lead = await prisma.lead.findFirst({ where: { id, workspaceId: auth.workspaceId }, select: LEAD_API_SELECT });
  if (!lead) return apiError(404, "Lead not found");
  return apiJson(serializeLead(lead));
}

// PATCH /api/v1/leads/{id}: change only the fields sent; null clears one.
// An old stage name moves the lead on the Leads list too (apiStagePipeline).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await apiGuard(req, { write: true });
  if (auth instanceof Response) return auth;
  if (!(await prospectingOn(auth.workspaceId))) return apiError(403, NOT_ON);

  const { id } = await params;
  const existing = await prisma.lead.findFirst({ where: { id, workspaceId: auth.workspaceId } });
  if (!existing) return apiError(404, "Lead not found");

  const body = await readJsonObject(req);
  if (!body) return apiError(400, "The body must be a JSON object");
  const parsed = await parseLeadInput(auth.workspaceId, body, { requireName: false });
  if ("error" in parsed) return apiError(400, parsed.error);
  if (Object.keys(parsed.data).length === 0) return apiError(400, "Nothing to change. Send at least one field");
  const pipeline = apiStagePipeline(existing, parsed.data.stage);
  const merged = { ...parsed.data, ...pipeline.data };
  // A client stays converted: the stage is left out, the rest still goes in.
  let data = pipeline.dropStage ? withoutStage(merged) : merged;
  // Already converted: keep when it happened.
  if (data.convertedAt && existing.convertedAt) data.convertedAt = existing.convertedAt;
  if (data.externalId && data.externalId !== existing.externalId) {
    const taken = await prisma.lead.findFirst({ where: { workspaceId: auth.workspaceId, externalId: data.externalId, id: { not: id } }, select: { id: true } });
    if (taken) return apiError(409, "Another lead already has this externalId", { existingId: taken.id });
  }

  if (pipeline.notClient) {
    // Not over a signature that landed in the meantime: the lead is a
    // client now, so it gets everything but the stage, as above.
    const { count } = await prisma.lead.updateMany({ where: { id, isClient: false }, data });
    if (count === 0) {
      data = withoutStage(data);
      if (Object.keys(data).length > 0) await prisma.lead.update({ where: { id }, data });
    }
  } else if (Object.keys(data).length > 0) {
    await prisma.lead.update({ where: { id }, data });
  }
  if (pipeline.refresh) await refreshLeadPipeline(id);
  const lead = await prisma.lead.findFirst({ where: { id, workspaceId: auth.workspaceId }, select: LEAD_API_SELECT });
  if (!lead) return apiError(404, "Lead not found");
  await dispatchLeadsUpdated(auth.workspaceId, [leadChanges(id, existing, data)]);
  return apiJson(serializeLead(lead));
}
