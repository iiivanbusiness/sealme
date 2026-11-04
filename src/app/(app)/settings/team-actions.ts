"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

export async function createTeam(formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageTeam");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Team name is required" };

  const existing = await prisma.team.findFirst({ where: { workspaceId: user.workspaceId, name } });
  if (existing) return { error: "A team with that name already exists" };

  await prisma.team.create({ data: { workspaceId: user.workspaceId, name } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "team.created", metadata: { name } });

  revalidatePath("/settings");
  return {};
}

export async function deleteTeam(teamId: string): Promise<{ error?: string }> {
  const user = await requirePermission("canManageTeam");
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId: user.workspaceId },
    include: { _count: { select: { users: true, deals: true, reviewChains: true } } },
  });
  if (!team) return { error: "Team not found" };
  if (team._count.reviewChains > 0) return { error: "A review chain still targets this team. Remove or reassign it first" };

  await prisma.team.delete({ where: { id: teamId } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "team.deleted", metadata: { name: team.name, members: team._count.users, deals: team._count.deals } });

  revalidatePath("/settings");
  return {};
}

export async function assignUserTeam(userId: string, formData: FormData): Promise<{ error?: string }> {
  const teamId = String(formData.get("teamId") ?? "") || null;
  const user = await requirePermission("canManageTeam");

  const targetUser = await prisma.user.findFirst({ where: { id: userId, workspaceId: user.workspaceId, deactivatedAt: null } });
  if (!targetUser) return { error: "Teammate not found" };

  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: teamId, workspaceId: user.workspaceId } });
    if (!team) return { error: "Team not found" };
  }

  await prisma.user.update({ where: { id: userId }, data: { teamId } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "team.member_assigned", targetId: userId, metadata: { teamId } });

  revalidatePath("/settings");
  return {};
}
