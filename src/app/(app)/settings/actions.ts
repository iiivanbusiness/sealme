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
import { isValidDomain, lookupDomainVerification, newDomainVerificationToken, normalizeDomain } from "@/lib/domain-verification";

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
        // Signs them out of every device they're still signed in on.
        sessionVersion: { increment: 1 },
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

// The domain only limits invites until the workspace proves it owns it
// (verifyAllowedDomain); SSO and SCIM need that proof. Several workspaces
// can type in the same domain, so someone squatting on a company's domain
// can't lock the company out, but once one has verified it, it's theirs.
// A new domain gets a new token and starts unverified, and since SSO is
// only for a verified domain, changing it turns SSO off.
export async function updateAllowedDomain(formData: FormData) {
  const domain = normalizeDomain(String(formData.get("domain") ?? "")) || null;
  if (domain && !isValidDomain(domain)) {
    domainError("That doesn't look like a domain, e.g. yourcompany.com");
  }

  const user = await requirePermission("canManageWorkspace");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId } });
  if (domain === workspace.allowedEmailDomain) {
    revalidatePath("/settings");
    return;
  }
  if (domain) {
    const taken = await prisma.workspace.findFirst({
      where: { allowedEmailDomain: domain, allowedEmailDomainVerifiedAt: { not: null }, id: { not: user.workspaceId } },
      select: { id: true },
    });
    if (taken) domainError("Another SealMe workspace has verified that domain. Contact SealMe support if it's yours");
  }
  await prisma.workspace.update({
    where: { id: user.workspaceId },
    data: {
      allowedEmailDomain: domain,
      domainVerificationToken: domain ? newDomainVerificationToken() : null,
      allowedEmailDomainVerifiedAt: null,
      ssoEnabled: false,
    },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "workspace.domain_restriction_updated", metadata: { domain } });
  if (workspace.ssoEnabled) {
    await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "workspace.sso_disabled", metadata: { reason: "domain_changed" } });
  }

  revalidatePath("/settings");
}

// A domain set before verification existed has no token yet; this gives it
// one so the TXT record can be shown. Never replaces an existing token, or
// a record the admin already added would stop matching.
export async function startDomainVerification(): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const updated = await prisma.workspace.updateMany({
    where: { id: user.workspaceId, allowedEmailDomain: { not: null }, domainVerificationToken: null },
    data: { domainVerificationToken: newDomainVerificationToken() },
  });
  if (updated.count === 0) {
    const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId }, select: { allowedEmailDomain: true } });
    if (!workspace.allowedEmailDomain) return { error: "Save an email domain first" };
  }
  revalidatePath("/settings");
  return {};
}

// Looks for the TXT record on the domain. Returns { error } as data for the
// same reason inviteTeammate does.
export async function verifyAllowedDomain(): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: user.workspaceId } });
  const domain = workspace.allowedEmailDomain;
  const token = workspace.domainVerificationToken;
  if (!domain || !token) return { error: "Save an email domain first" };
  if (workspace.allowedEmailDomainVerifiedAt) return {};

  const allowed = await checkRateLimit(`verify-domain:${workspace.id}`, 20, 60 * 60 * 1000);
  if (!allowed) return { error: "Too many checks in the last hour. Try again later" };

  const claimedElsewhere = () =>
    prisma.workspace.count({ where: { allowedEmailDomain: domain, allowedEmailDomainVerifiedAt: { not: null }, id: { not: workspace.id } } });
  if ((await claimedElsewhere()) > 0) {
    return { error: "Another SealMe workspace has already verified this domain. Contact SealMe support if it's yours" };
  }

  const result = await lookupDomainVerification(domain, token);
  if (result === "lookup_failed") return { error: `Couldn't look up the DNS records for ${domain}. Try again in a few minutes` };
  if (result === "missing") {
    return { error: `The TXT record isn't on ${domain} yet. DNS changes can take a while to show up, so try again in a few minutes` };
  }

  // Checked again after the lookup, since it can take a few seconds.
  if ((await claimedElsewhere()) > 0) {
    return { error: "Another SealMe workspace has already verified this domain. Contact SealMe support if it's yours" };
  }
  // Only if the domain and token are still the ones that were checked: an
  // admin could have changed the domain while the lookup ran.
  const updated = await prisma.workspace.updateMany({
    where: { id: workspace.id, allowedEmailDomain: domain, domainVerificationToken: token },
    data: { allowedEmailDomainVerifiedAt: new Date() },
  });
  if (updated.count === 0) return { error: "The domain changed while it was being checked. Check it again" };

  const session = await auth();
  await logAudit({ workspaceId: workspace.id, actorEmail: session?.user?.email, action: "workspace.domain_verified", metadata: { domain } });

  revalidatePath("/settings");
  return {};
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
    // Sign-ins are matched to a workspace by domain, so only one that has
    // proven it owns the domain gets them.
    if (!workspace.allowedEmailDomainVerifiedAt) {
      return { error: "Verify the email domain above first. SSO only works for a domain this workspace has proven it owns" };
    }
    const claimed = await prisma.workspace.count({
      where: { allowedEmailDomain: workspace.allowedEmailDomain, allowedEmailDomainVerifiedAt: { not: null }, id: { not: workspace.id } },
    });
    if (claimed > 0) {
      return { error: "Another SealMe workspace has also verified this email domain. Contact SealMe support" };
    }
  }

  // Only if nothing changed since the checks above: a domain saved in the
  // meantime turns SSO off and clears the verification, and this mustn't
  // turn it back on for the new, unverified domain.
  const updated = await prisma.workspace.updateMany({
    where: workspace.ssoEnabled
      ? { id: workspace.id, ssoEnabled: true }
      : { id: workspace.id, ssoEnabled: false, allowedEmailDomain: workspace.allowedEmailDomain, allowedEmailDomainVerifiedAt: { not: null } },
    data: { ssoEnabled: !workspace.ssoEnabled },
  });
  if (updated.count === 0) {
    revalidatePath("/settings");
    return { error: "These settings changed while saving. Check them and try again" };
  }

  const session = await auth();
  await logAudit({
    workspaceId: user.workspaceId,
    actorEmail: session?.user?.email,
    action: workspace.ssoEnabled ? "workspace.sso_disabled" : "workspace.sso_enabled",
  });
  revalidatePath("/settings");
  return {};
}
