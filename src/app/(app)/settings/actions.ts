"use server";

import { randomBytes, createHash } from "crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireWorkspace } from "@/lib/workspace";
import { requirePermission, canActOnRole, ROLE_ESCALATION_ERROR } from "@/lib/permissions";
import { createSenderDomain, getSenderDomainStatus, removeSenderDomain } from "@/lib/sender-domain";
import { sendTeammateInviteEmail, sendVerificationEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";

type ToggleField = "requireApproval" | "notifyOnSigned" | "autoRemind" | "zoomConnected" | "meetConnected";

export async function toggleWorkspaceFlag(field: ToggleField) {
  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { [field]: !workspace[field] },
  });

  revalidatePath("/settings");
}

export async function updateSigningTiming(formData: FormData) {
  const rawInterval = String(formData.get("reminderIntervalDays") ?? "").trim();
  const reminderIntervalDays = rawInterval ? Number(rawInterval) : 3;
  if (!Number.isInteger(reminderIntervalDays) || reminderIntervalDays < 1 || reminderIntervalDays > 90) {
    throw new Error("Reminder days must be a whole number between 1 and 90");
  }

  const rawExpiry = String(formData.get("signingExpiryDays") ?? "").trim();
  const signingExpiryDays = rawExpiry ? Number(rawExpiry) : null;
  if (signingExpiryDays != null && (!Number.isInteger(signingExpiryDays) || signingExpiryDays < 1 || signingExpiryDays > 365)) {
    throw new Error("Expiry days must be a whole number between 1 and 365, or left blank for no expiry");
  }

  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();
  await prisma.workspace.update({ where: { id: workspace.id }, data: { reminderIntervalDays, signingExpiryDays } });

  revalidatePath("/settings");
}

export async function updateWorkspaceName(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();

  await prisma.workspace.update({ where: { id: workspace.id }, data: { name } });
  revalidatePath("/settings");
}

export async function connectSenderDomain(formData: FormData) {
  const domain = String(formData.get("domain") ?? "").trim().toLowerCase();
  const mailbox = String(formData.get("mailbox") ?? "hello").trim().toLowerCase() || "hello";
  if (!domain) throw new Error("Enter a domain");

  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();
  const created = await createSenderDomain(domain);

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: {
      senderDomain: domain,
      senderDomainId: created.id,
      senderDomainStatus: created.status,
      senderEmail: `${mailbox}@${domain}`,
    },
  });

  revalidatePath("/settings");
}

export async function checkSenderDomainVerification() {
  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();
  if (!workspace.senderDomainId) return;

  const status = await getSenderDomainStatus(workspace.senderDomainId);
  await prisma.workspace.update({ where: { id: workspace.id }, data: { senderDomainStatus: status.status } });

  revalidatePath("/settings");
}

export async function disconnectSenderDomain() {
  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();
  if (workspace.senderDomainId) {
    try {
      await removeSenderDomain(workspace.senderDomainId);
    } catch {
      // already gone on Resend's side — fine, still clear our local state
    }
  }

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { senderDomain: null, senderDomainId: null, senderDomainStatus: null, senderEmail: null },
  });

  revalidatePath("/settings");
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Returns the error as data instead of throwing — a thrown Error's message
// gets stripped to a generic "#441" digest by Next.js in production
// (deliberate: it won't leak arbitrary server-side exception text to the
// client), so a validation failure like "already tied to another workspace"
// would otherwise never actually reach the user. See InviteTeammateForm.
export async function inviteTeammate(formData: FormData): Promise<{ error: string } | undefined> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!email) return { error: "Enter an email address" };

  await requirePermission("canManageTeam");
  const workspace = await requireWorkspace();
  const session = await auth();

  if (workspace.allowedEmailDomain && !email.endsWith(`@${workspace.allowedEmailDomain}`)) {
    return { error: `This workspace only accepts @${workspace.allowedEmailDomain} email addresses` };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.workspaceId === workspace.id) {
      return { error: "They're already on this workspace" };
    }
    return { error: "That email is already tied to another SealMe workspace" };
  }

  const invited = await prisma.user.create({
    data: { workspaceId: workspace.id, name: email, email, passwordHash: null },
  });
  // A link to set their own password, so a teammate without a Google
  // account (Microsoft 365, anything else) can join. A week to use it;
  // after that "Forgot password" does the same.
  const rawToken = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: { userId: invited.id, tokenHash: createHash("sha256").update(rawToken).digest("hex"), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
  });
  await logAudit({
    workspaceId: workspace.id,
    actorEmail: session?.user?.email,
    action: "teammate.invited",
    metadata: { invitedEmail: email },
  });

  try {
    await sendTeammateInviteEmail({
      to: email,
      inviterName: session?.user?.name ?? session?.user?.email ?? "A teammate",
      workspaceName: workspace.name,
      setPasswordUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/reset-password/${rawToken}?invite=1`,
    });
  } catch (err) {
    console.error("Failed to send teammate invite email", err);
  }

  revalidatePath("/settings");
}

// Returns { error } as data for the same reason inviteTeammate does. See
// RemoveTeammateButton.
export async function removeTeammate(userId: string): Promise<{ error?: string }> {
  const actor = await requirePermission("canManageTeam");
  const workspace = await requireWorkspace();
  const session = await auth();

  const others = await prisma.user.count({ where: { workspaceId: workspace.id, id: { not: userId }, deactivatedAt: null } });
  if (others === 0) return { error: "Can't remove the only member of a workspace" };

  const removed = await prisma.user.findFirst({ where: { id: userId, workspaceId: workspace.id }, include: { role: true } });
  if (!removed) return { error: "Teammate not found" };
  if (!canActOnRole(actor.role, removed.role)) return { error: ROLE_ESCALATION_ERROR };
  if (removed.role?.canManageTeam) {
    const otherTeamManagers = await prisma.user.count({
      where: { workspaceId: workspace.id, id: { not: userId }, deactivatedAt: null, role: { canManageTeam: true } },
    });
    if (otherTeamManagers === 0) return { error: "This is the only teammate who can manage the team. Give someone else that access first" };
  }
  // Not a delete: past approvals and feedback posts point at the person and
  // block it. Same as SCIM and deleting your own account, they're
  // deactivated, and their email and phone are freed so they can be invited
  // again or start their own workspace. Their name stays on the deals, tasks
  // and approvals they worked on. What a delete used to clear with them goes
  // too: their review chain steps, approval backups and unused invite link.
  // So does their role, or it could never be deleted ("reassign 1
  // teammate") once they're off the list.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: removed.id },
      data: {
        email: `deleted-${removed.id}@deleted.sealme.net`,
        roleId: null,
        passwordHash: null,
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorBackupCodes: null,
        phone: null,
        phoneVerifiedAt: null,
        scimExternalId: null,
        deactivatedAt: removed.deactivatedAt ?? new Date(),
      },
    }),
    prisma.reviewChainStep.deleteMany({ where: { assigneeId: removed.id } }),
    prisma.approvalDelegate.deleteMany({ where: { OR: [{ fromUserId: removed.id }, { toUserId: removed.id }] } }),
    prisma.passwordResetToken.deleteMany({ where: { userId: removed.id } }),
  ]);
  await logAudit({
    workspaceId: workspace.id,
    actorEmail: session?.user?.email,
    action: "teammate.removed",
    metadata: { removedEmail: removed.email },
  });
  revalidatePath("/settings");
  return {};
}

const MAX_LOGO_BYTES = 1.5 * 1024 * 1024;

export async function uploadLogo(formData: FormData) {
  const file = formData.get("logo") as File | null;
  if (!file || file.size === 0) throw new Error("Choose an image file");
  if (!file.type.startsWith("image/")) throw new Error("That's not an image file");
  if (file.size > MAX_LOGO_BYTES) throw new Error("Keep the logo under 1.5MB");

  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();
  const bytes = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${file.type};base64,${bytes.toString("base64")}`;

  await prisma.workspace.update({ where: { id: workspace.id }, data: { logoImage: dataUrl } });
  revalidatePath("/settings");
}

export async function removeLogo() {
  await requirePermission("canManageWorkspace");
  const workspace = await requireWorkspace();
  await prisma.workspace.update({ where: { id: workspace.id }, data: { logoImage: null } });
  revalidatePath("/settings");
}

export async function resendVerificationEmail() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return;

  const allowed = await checkRateLimit(`resend-verify:${email.toLowerCase()}`, 3, 60 * 60 * 1000);
  if (!allowed) return;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.emailVerifiedAt) return;

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await prisma.emailVerificationToken.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
  });

  try {
    await sendVerificationEmail({
      to: email,
      verifyUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/verify-email/${rawToken}`,
    });
  } catch (err) {
    console.error("Failed to resend verification email", err);
  }
}

export async function requestUpgrade(formData: FormData) {
  const note = String(formData.get("note") ?? "").trim() || null;
  const workspace = await requireWorkspace();

  const existing = await prisma.upgradeRequest.findFirst({ where: { workspaceId: workspace.id, status: "pending" } });
  if (!existing) {
    await prisma.upgradeRequest.create({ data: { workspaceId: workspace.id, note } });
  }

  revalidatePath("/settings");
}

// Problems come back on the page's own error banner: a thrown message
// would reach the user only as a digest in production.
function domainError(message: string): never {
  redirect(`/settings?error=${encodeURIComponent(message)}`);
}

export async function updateAllowedDomain(formData: FormData) {
  const raw = String(formData.get("domain") ?? "").trim().toLowerCase();
  const domain = raw.replace(/^@/, "") || null;
  if (domain && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    domainError("That doesn't look like a domain, e.g. yourcompany.com");
  }

  const user = await requirePermission("canManageWorkspace");
  // Nothing proves a workspace owns its domain yet, and SSO sign-in finds
  // the workspace by it, so a domain stays with the first workspace that
  // set it.
  if (domain) {
    const taken = await prisma.workspace.findFirst({ where: { allowedEmailDomain: domain, id: { not: user.workspaceId } }, select: { id: true } });
    if (taken) domainError("Another SealMe workspace already uses that domain. Contact SealMe support if it's yours");
  }
  await prisma.workspace.update({ where: { id: user.workspaceId }, data: { allowedEmailDomain: domain } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "workspace.domain_restriction_updated", metadata: { domain } });

  revalidatePath("/settings");
}

// Returns the raw token exactly once — only the hash is ever stored, same
// pattern as every other long-lived credential in this app. Generating a
// new one immediately invalidates whatever the IdP was using before, so
// this is also how a leaked token gets revoked: generate a fresh one.
export async function generateScimToken(): Promise<string> {
  const user = await requirePermission("canManageWorkspace");
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await prisma.workspace.update({ where: { id: user.workspaceId }, data: { scimTokenHash: tokenHash } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "workspace.scim_token_generated" });

  revalidatePath("/settings");
  return rawToken;
}

export async function revokeScimToken(): Promise<void> {
  const user = await requirePermission("canManageWorkspace");
  await prisma.workspace.update({ where: { id: user.workspaceId }, data: { scimTokenHash: null } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "workspace.scim_token_revoked" });

  revalidatePath("/settings");
}

export async function updateSsoConfig(formData: FormData) {
  const issuer = String(formData.get("issuer") ?? "").trim().replace(/\/+$/, "");
  const clientId = String(formData.get("clientId") ?? "").trim();
  const clientSecret = String(formData.get("clientSecret") ?? "").trim();
  if (issuer && !/^https:\/\//.test(issuer)) {
    throw new Error("Issuer must be an https:// URL, e.g. https://mycompany.okta.com");
  }

  const user = await requirePermission("canManageWorkspace");
  await prisma.workspace.update({
    where: { id: user.workspaceId },
    data: {
      ssoIssuer: issuer || null,
      ssoClientId: clientId || null,
      // Blank means "leave the existing secret alone" — the field is
      // never pre-filled with the real value, so an empty submit isn't
      // distinguishable from "didn't mean to change it".
      ...(clientSecret ? { ssoClientSecret: clientSecret } : {}),
    },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "workspace.sso_config_updated" });
  revalidatePath("/settings");
}

export async function toggleSso(): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId } });

  if (!workspace.ssoEnabled) {
    if (!workspace.ssoIssuer || !workspace.ssoClientId || !workspace.ssoClientSecret) {
      return { error: "Set an issuer, client ID, and client secret before enabling SSO" };
    }
    if (!workspace.allowedEmailDomain) {
      return { error: "Set an allowed email domain above first. It's how sign-ins get matched to this workspace" };
    }
    const shared = await prisma.workspace.count({ where: { allowedEmailDomain: workspace.allowedEmailDomain, id: { not: workspace.id } } });
    if (shared > 0) {
      return { error: "Another SealMe workspace uses the same email domain, so SSO can't tell them apart. Contact SealMe support" };
    }
  }

  await prisma.workspace.update({ where: { id: user.workspaceId }, data: { ssoEnabled: !workspace.ssoEnabled } });

  const session = await auth();
  await logAudit({
    workspaceId: user.workspaceId,
    actorEmail: session?.user?.email,
    action: workspace.ssoEnabled ? "workspace.sso_disabled" : "workspace.sso_enabled",
  });
  revalidatePath("/settings");
  return {};
}
