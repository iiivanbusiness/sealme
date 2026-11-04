"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requirePermission, canActOnRole, ROLE_ESCALATION_ERROR } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

const PERMISSION_FIELDS = [
  "canManageWorkspace",
  "canManageTeam",
  "canManageTemplates",
  "canApproveTemplates",
  "canViewAllDeals",
] as const;

function readPermissions(formData: FormData) {
  const data: Record<(typeof PERMISSION_FIELDS)[number], boolean> = {
    canManageWorkspace: false,
    canManageTeam: false,
    canManageTemplates: false,
    canApproveTemplates: false,
    canViewAllDeals: false,
  };
  for (const field of PERMISSION_FIELDS) data[field] = formData.get(field) === "on";
  return data;
}

export async function createRole(formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageTeam");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Role name is required" };
  const permissions = readPermissions(formData);
  if (!canActOnRole(user.role, permissions)) return { error: ROLE_ESCALATION_ERROR };

  const existing = await prisma.role.findFirst({ where: { workspaceId: user.workspaceId, name } });
  if (existing) return { error: "A role with that name already exists" };

  await prisma.role.create({
    data: { workspaceId: user.workspaceId, name, ...permissions },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "role.created", metadata: { name } });

  revalidatePath("/settings");
  return {};
}

// The Owner role is the workspace's safety net — it's created by the system,
// always holds every permission, and can't be deleted. Locking its
// permissions too (name is still editable) means there's always at least
// one role nobody can misconfigure into a lockout.
export async function updateRole(roleId: string, formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageTeam");
  const role = await prisma.role.findFirst({ where: { id: roleId, workspaceId: user.workspaceId } });
  if (!role) return { error: "Role not found" };
  if (!canActOnRole(user.role, role)) return { error: ROLE_ESCALATION_ERROR };

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Role name is required" };

  if (role.isOwner) {
    await prisma.role.update({ where: { id: roleId }, data: { name } });
    revalidatePath("/settings");
    return {};
  }

  const permissions = readPermissions(formData);
  if (!canActOnRole(user.role, permissions)) return { error: ROLE_ESCALATION_ERROR };

  // If this role currently holds canManageTeam and is about to lose it,
  // make sure someone still on the team keeps it through another role,
  // otherwise nobody could ever manage roles or teammates again. Counting
  // roles isn't enough: the Owner role always qualifies, even with nobody
  // active on it.
  if (role.canManageTeam && !permissions.canManageTeam) {
    const otherTeamManagers = await prisma.user.count({
      where: { workspaceId: user.workspaceId, deactivatedAt: null, roleId: { not: roleId }, role: { canManageTeam: true } },
    });
    if (otherTeamManagers === 0) {
      return { error: "That would leave nobody who can manage the team. Give someone else a role that can manage it first" };
    }
  }

  await prisma.role.update({ where: { id: roleId }, data: { name, ...permissions } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "role.updated", targetId: roleId, metadata: { name } });

  revalidatePath("/settings");
  return {};
}

export async function deleteRole(roleId: string): Promise<{ error?: string }> {
  const user = await requirePermission("canManageTeam");
  // Only people still on the team block it: anyone deactivated who still
  // points at the role just loses it (roleId is set null on delete).
  const role = await prisma.role.findFirst({
    where: { id: roleId, workspaceId: user.workspaceId },
    include: { _count: { select: { users: { where: { deactivatedAt: null } } } } },
  });
  if (!role) return { error: "Role not found" };
  if (role.isOwner) return { error: "The Owner role can't be deleted" };
  if (!canActOnRole(user.role, role)) return { error: ROLE_ESCALATION_ERROR };
  if (role._count.users > 0) return { error: `Reassign ${role._count.users} teammate(s) off this role before deleting it` };

  await prisma.role.delete({ where: { id: roleId } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "role.deleted", targetId: roleId, metadata: { name: role.name } });

  revalidatePath("/settings");
  return {};
}

export async function assignUserRole(userId: string, formData: FormData): Promise<{ error?: string }> {
  const roleId = String(formData.get("roleId") ?? "");
  const user = await requirePermission("canManageTeam");

  const [targetUser, newRole] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, workspaceId: user.workspaceId, deactivatedAt: null }, include: { role: true } }),
    prisma.role.findFirst({ where: { id: roleId, workspaceId: user.workspaceId } }),
  ]);
  if (!targetUser) return { error: "Teammate not found" };
  if (!newRole) return { error: "Role not found" };
  if (!canActOnRole(user.role, targetUser.role) || !canActOnRole(user.role, newRole)) return { error: ROLE_ESCALATION_ERROR };

  // Never let a reassignment leave the workspace with nobody who can manage
  // the team — that would be a permanent lockout with no way back in short
  // of a database edit.
  if (targetUser.role?.canManageTeam && !newRole.canManageTeam) {
    const otherTeamManagers = await prisma.user.count({
      where: { workspaceId: user.workspaceId, id: { not: userId }, deactivatedAt: null, role: { canManageTeam: true } },
    });
    if (otherTeamManagers === 0) {
      return { error: "This is the only teammate who can manage the team. Assign someone else first" };
    }
  }

  await prisma.user.update({ where: { id: userId }, data: { roleId } });

  const session = await auth();
  await logAudit({
    workspaceId: user.workspaceId,
    actorEmail: session?.user?.email,
    action: "role.assigned",
    targetId: userId,
    metadata: { role: newRole.name },
  });

  revalidatePath("/settings");
  return {};
}
