"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { listGhlPipelines } from "@/lib/gohighlevel";
import { logAudit } from "@/lib/audit";

export async function connectGohighlevel(formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const token = String(formData.get("token") ?? "").trim();
  const locationId = String(formData.get("locationId") ?? "").trim();
  if (!token) return { error: "Paste your GoHighLevel Private Integration token first" };
  if (!locationId) return { error: "Add the sub-account's Location ID too" };

  // Fails unless the token belongs to that sub-account and can read pipelines.
  try {
    await listGhlPipelines(token, locationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    return { error: /40[13]/.test(message) ? "GoHighLevel didn't accept that token for this Location ID. Check both, and that the token has the opportunities scope." : "Couldn't reach GoHighLevel with that token. Try again." };
  }

  await prisma.workspace.update({
    where: { id: user.workspaceId },
    data: { ghlAccessToken: token, ghlLocationId: locationId, ghlEnabled: true, ghlPipelineId: null, ghlStageId: null },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "gohighlevel.connected", metadata: { locationId } });

  revalidatePath("/settings");
  return {};
}

// "pipelineId:stageId", or empty for no opportunities.
export async function setGohighlevelPipeline(formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const [pipelineId, stageId] = String(formData.get("stage") ?? "").split(":");
  await prisma.workspace.update({
    where: { id: user.workspaceId },
    data: { ghlPipelineId: pipelineId || null, ghlStageId: pipelineId ? stageId || null : null },
  });
  revalidatePath("/settings");
  return {};
}

export async function toggleGohighlevel(): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { id: user.workspaceId }, select: { ghlEnabled: true } });
  await prisma.workspace.update({ where: { id: user.workspaceId }, data: { ghlEnabled: !workspace.ghlEnabled } });
  revalidatePath("/settings");
  return {};
}

export async function disconnectGohighlevel(): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  await prisma.workspace.update({
    where: { id: user.workspaceId },
    data: { ghlEnabled: false, ghlAccessToken: null, ghlLocationId: null, ghlPipelineId: null, ghlStageId: null },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "gohighlevel.disconnected" });

  revalidatePath("/settings");
  return {};
}
