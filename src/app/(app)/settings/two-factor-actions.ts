"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth, keepThisSession } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";
import { logAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  generateTwoFactorSecret,
  generateQrCodeDataUrl,
  verifyTotpCode,
  generateBackupCodes,
  type BackupCode,
} from "@/lib/two-factor";

async function currentUser() {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) throw new Error("Not signed in");
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error("Not signed in");
  return user;
}

// Step 1: generate a new (unconfirmed) secret and return the QR code for the
// user to scan. Storing it here — before it's confirmed — is safe because
// twoFactorEnabled stays false, so this secret alone can't be used to log in.
export async function startTwoFactorSetup(): Promise<{ qrCodeDataUrl: string; secret: string }> {
  const user = await currentUser();
  // Never over the secret already in use, or anyone with the session could
  // swap in their own app's and break the owner's codes.
  if (user.twoFactorEnabled) throw new Error("2FA is already on");
  const secret = generateTwoFactorSecret();
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret } });
  const qrCodeDataUrl = await generateQrCodeDataUrl(user.email, secret);
  return { qrCodeDataUrl, secret };
}

// Step 2: the user enters a code from their authenticator app to prove the
// secret actually works before we turn 2FA on for their account.
export async function confirmTwoFactorSetup(formData: FormData): Promise<{ error?: string; backupCodes?: string[] }> {
  const code = String(formData.get("code") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!code) return { error: "Enter the 6-digit code from your app" };

  const user = await currentUser();
  if (!user.twoFactorSecret) return { error: "Start setup again" };

  const allowed = await checkRateLimit(`2fa-confirm:${user.id}`, 10, 15 * 60 * 1000);
  if (!allowed) return { error: "Too many attempts. Try again later" };

  // The password, like turning it off: otherwise a stolen cookie alone could
  // turn 2FA on with the thief's own app, keep their session (see below)
  // and sign the owner out of a login they can no longer finish.
  if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) return { error: "That password is incorrect" };

  const valid = await verifyTotpCode(code, user.twoFactorSecret);
  if (!valid) return { error: "That code didn't match. Check the time on your phone and try again" };

  // Turning 2FA on is what someone does when they think their password got
  // out, so it signs out every other session; this one carries on.
  const { raw, stored } = generateBackupCodes();
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: true, twoFactorBackupCodes: JSON.stringify(stored), sessionVersion: { increment: 1 } },
    select: { email: true, sessionVersion: true },
  });
  await keepThisSession(updated.email, updated.sessionVersion);
  await logAudit({ workspaceId: user.workspaceId, actorEmail: user.email, action: "2fa.enabled" });
  revalidatePath("/settings");
  return { backupCodes: raw };
}

export async function disableTwoFactor(formData: FormData): Promise<{ error?: string }> {
  const password = String(formData.get("password") ?? "");
  const user = await currentUser();

  if (!user.passwordHash) return { error: "Your account has no password set. Contact support to disable 2FA" };

  const allowed = await checkRateLimit(`2fa-disable:${user.id}`, 5, 15 * 60 * 1000);
  if (!allowed) return { error: "Too many attempts. Try again later" };

  if (!verifyPassword(password, user.passwordHash)) return { error: "That password is incorrect" };

  // Same as turning it on: every other session is signed out, this one stays.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null, sessionVersion: { increment: 1 } },
    select: { email: true, sessionVersion: true },
  });
  await keepThisSession(updated.email, updated.sessionVersion);
  await logAudit({ workspaceId: user.workspaceId, actorEmail: user.email, action: "2fa.disabled" });
  revalidatePath("/settings");
  return {};
}

export async function regenerateBackupCodes(formData: FormData): Promise<{ error?: string; backupCodes?: string[] }> {
  const password = String(formData.get("password") ?? "");
  const user = await currentUser();
  if (!user.twoFactorEnabled) return { error: "2FA isn't enabled" };
  if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) return { error: "That password is incorrect" };

  const { raw, stored } = generateBackupCodes();
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: JSON.stringify(stored) } });
  await logAudit({ workspaceId: user.workspaceId, actorEmail: user.email, action: "2fa.backup_codes_regenerated" });
  return { backupCodes: raw };
}

export type { BackupCode };
