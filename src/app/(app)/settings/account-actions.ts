"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth, signOut } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";

async function currentUser() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error("Not signed in");
  const user = await prisma.user.findUnique({ where: { email }, include: { role: true } });
  if (!user) throw new Error("Not signed in");
  return user;
}

// Leaving would strand the teammates still on the workspace: nobody left
// could assign roles, invite people or change SSO and integrations. Same
// guard as removing a teammate and SCIM deactivation. Alone on the
// workspace, there's nobody to strand.
async function isOnlyTeamManager(user: { id: string; workspaceId: string; role: { canManageTeam: boolean } | null }): Promise<boolean> {
  if (!user.role?.canManageTeam) return false;
  const active = { workspaceId: user.workspaceId, id: { not: user.id }, deactivatedAt: null };
  const [others, otherManagers] = await Promise.all([
    prisma.user.count({ where: active }),
    prisma.user.count({ where: { ...active, role: { canManageTeam: true } } }),
  ]);
  return others > 0 && otherManagers === 0;
}

// Deletes the signed-in user's own account and personal data — required by
// Apple Guideline 5.1.1(v) for any account-creating app. Anonymizes rather
// than hard-deletes the User row: several tables reference User with a
// required foreign key that isn't nullable (ApprovalDecision.decidedByUser,
// FeedbackPost.author, ...), because that history belongs to the workspace
// team, not just this one person — same reasoning already behind Deal.owner
// using onDelete: SetNull, and SCIM's deactivatedAt for employer-initiated
// offboarding. A hard delete would either fail on those constraints or
// erase workspace history that isn't this user's alone to delete. Wiping
// the identifying fields (name, email, password) and deactivating is a
// real, complete deletion of this person's own personal data.
export async function deleteMyAccount(formData: FormData): Promise<{ error?: string }> {
  const confirmation = String(formData.get("confirmation") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const user = await currentUser();

  if (confirmation.toLowerCase() !== "delete") {
    return { error: 'Type "delete" to confirm' };
  }

  const allowed = await checkRateLimit(`account-delete:${user.id}`, 5, 15 * 60 * 1000);
  if (!allowed) return { error: "Too many attempts. Try again later" };

  // Google-only accounts have no password to check — the typed confirmation
  // above is the only gate for those.
  if (user.passwordHash && !verifyPassword(password, user.passwordHash)) {
    return { error: "That password is incorrect" };
  }

  if (await isOnlyTeamManager(user)) {
    return { error: "You're the only one who can manage this team. Give a teammate that access first, in Settings on a computer" };
  }

  // Same cleanup as removing a teammate, so no review chain waits on them.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        name: "Deleted user",
        email: `deleted-${user.id}@deleted.sealme.net`,
        passwordHash: null,
        emailVerifiedAt: null,
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorBackupCodes: null,
        deactivatedAt: new Date(),
        // Signs out every other device too, not just this one.
        sessionVersion: { increment: 1 },
      },
    }),
    prisma.reviewChainStep.deleteMany({ where: { assigneeId: user.id } }),
    prisma.approvalDelegate.deleteMany({ where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }] } }),
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
  ]);

  await logAudit({ workspaceId: user.workspaceId, actorEmail: user.email, action: "account.self_deleted" });

  await signOut({ redirectTo: "/login?deleted=1" });
  return {};
}

// Their name as teammates see it. An invite starts it as the email.
export async function updateMyName(formData: FormData): Promise<{ error?: string }> {
  const name = String(formData.get("name") ?? "").trim().slice(0, 100);
  if (!name) return { error: "Enter your name" };
  const user = await currentUser();
  await prisma.user.update({ where: { id: user.id }, data: { name } });
  revalidatePath("/settings");
  return {};
}

// Dismisses the one-time AI-data-sharing notice (AiDisclosureModal.tsx) —
// see aiDisclosureAcknowledgedAt's doc comment in schema.prisma for why
// this exists at all.
export async function acknowledgeAiDisclosure(): Promise<void> {
  const user = await currentUser();
  if (user.aiDisclosureAcknowledgedAt) return;
  await prisma.user.update({ where: { id: user.id }, data: { aiDisclosureAcknowledgedAt: new Date() } });
}
