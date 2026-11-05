"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { validateHubspotToken } from "@/lib/hubspot";
import { logAudit } from "@/lib/audit";

export async function connectHubspot(formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const token = String(formData.get("token") ?? "").trim();
  if (!token) return { error: "Paste your HubSpot Private App token first" };

  let portalId: string;
  try {
    ({ portalId } = await validateHubspotToken(token));
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Couldn't validate that HubSpot token" };
  }

  const workspace = await prisma.workspace.findFirstOrThrow({ where: { id: user.workspaceId }, select: { hubspotPortalId: true } });
  await prisma.workspace.update({
    where: { id: user.workspaceId },
    data: {
      hubspotAccessToken: token,
      hubspotPortalId: portalId,
      hubspotEnabled: true,
      // Stage ids belong to one portal; a different portal starts with none.
      ...(workspace.hubspotPortalId !== portalId ? { hubspotPipelineId: null, hubspotSentStageId: null, hubspotSignedStageId: null } : {}),
    },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "hubspot.connected", metadata: { portalId } });

  revalidatePath("/settings");
  return {};
}

export async function toggleHubspot(): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const workspace = await prisma.workspace.findFirstOrThrow({ where: { id: user.workspaceId } });
  await prisma.workspace.update({ where: { id: user.workspaceId }, data: { hubspotEnabled: !workspace.hubspotEnabled } });
  revalidatePath("/settings");
  return {};
}

export async function disconnectHubspot(): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  await prisma.workspace.update({
    where: { id: user.workspaceId },
    data: { hubspotEnabled: false, hubspotPortalId: null, hubspotAccessToken: null, hubspotPipelineId: null, hubspotSentStageId: null, hubspotSignedStageId: null },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "hubspot.disconnected" });

  revalidatePath("/settings");
  return {};
}
