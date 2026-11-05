"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { checkHubspotStages, listHubspotDealPipelines, type HubspotPipeline } from "@/lib/hubspot";
import { logAudit } from "@/lib/audit";
import { reportError } from "@/lib/error-report";

export type HubspotStagesState = {
  pipelines: HubspotPipeline[];
  pipelineId: string;
  sentStageId: string;
  signedStageId: string;
};

// A rejected token means the connection needs redoing; anything else is
// worth another try.
function pipelinesError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/failed: 40[13] /.test(text)) {
    return "HubSpot turned down SealMe's token. Check that the Private App has the deals read scope, or disconnect HubSpot and connect it again.";
  }
  return "Couldn't read your deal pipelines from HubSpot. Try again.";
}

// The portal's deal pipelines, read live when the picker opens, with the
// stages already chosen.
export async function loadHubspotPipelines(): Promise<HubspotStagesState | { error: string }> {
  const user = await requirePermission("canManageWorkspace");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId } });
  if (!workspace.hubspotAccessToken) return { error: "Connect HubSpot first" };
  try {
    return {
      pipelines: await listHubspotDealPipelines(workspace.hubspotAccessToken),
      pipelineId: workspace.hubspotPipelineId ?? "",
      sentStageId: workspace.hubspotSentStageId ?? "",
      signedStageId: workspace.hubspotSignedStageId ?? "",
    };
  } catch (err) {
    console.error("Loading HubSpot pipelines failed", err);
    await reportError(err, "HubSpot deal pipelines", { workspaceId: user.workspaceId });
    return { error: pipelinesError(err) };
  }
}

// Saves the pipeline and the stages for contract sent and signed. An empty
// pipeline turns it off, and deals are pushed without a stage as before.
export async function saveHubspotStages(formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const choice = {
    pipelineId: String(formData.get("pipeline") ?? "").trim(),
    sentStageId: String(formData.get("sentStage") ?? "").trim(),
    signedStageId: String(formData.get("signedStage") ?? "").trim(),
  };

  let pipelines: HubspotPipeline[] = [];
  if (choice.pipelineId) {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId }, select: { hubspotAccessToken: true } });
    if (!workspace.hubspotAccessToken) return { error: "Connect HubSpot first" };
    try {
      pipelines = await listHubspotDealPipelines(workspace.hubspotAccessToken);
    } catch (err) {
      console.error("Loading HubSpot pipelines failed", err);
      return { error: pipelinesError(err) };
    }
  }
  const checked = checkHubspotStages(pipelines, choice);
  if ("error" in checked) return { error: checked.error };

  await prisma.workspace.update({ where: { id: user.workspaceId }, data: checked.data });
  await logAudit({
    workspaceId: user.workspaceId,
    actorEmail: user.email,
    action: checked.data.hubspotPipelineId ? "hubspot.deal_stages.saved" : "hubspot.deal_stages.off",
    metadata: { ...checked.data },
  });

  revalidatePath("/settings");
  return {};
}
