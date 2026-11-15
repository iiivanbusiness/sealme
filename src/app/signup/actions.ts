"use server";

import { randomBytes, createHash } from "crypto";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { prisma } from "@/lib/db";
import { signIn } from "@/lib/auth";
import { hashPassword } from "@/lib/password";
import { createOwnerRole } from "@/lib/permissions";
import { buildDefaultTemplates, buildSampleProposalTemplate } from "@/lib/default-templates";
import { attachOnboardingProfile } from "@/lib/onboarding";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { sendVerificationEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";
import { notifySignup } from "@/lib/signup-alert";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function signup(formData: FormData) {
  const companyName = String(formData.get("companyName") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!companyName || !name || !email || !password) {
    redirect(`/signup?error=${encodeURIComponent("All fields are required.")}`);
  }
  if (password.length < 8) {
    redirect(`/signup?error=${encodeURIComponent("Password must be at least 8 characters.")}`);
  }

  const ip = await getClientIp();
  const allowed = await checkRateLimit(`signup:${ip}`, 5, 60 * 60 * 1000);
  if (!allowed) {
    redirect(`/signup?error=${encodeURIComponent("Too many signups from this connection. Try again in a bit.")}`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    redirect(`/signup?error=${encodeURIComponent("An account with that email already exists.")}`);
  }

  const workspace = await prisma.workspace.create({
    data: { name: companyName },
  });
  const ownerRole = await createOwnerRole(workspace.id);

  const user = await prisma.user.create({
    data: { workspaceId: workspace.id, name, email, passwordHash: hashPassword(password), roleId: ownerRole.id },
  });

  const templates = [...buildDefaultTemplates(companyName), buildSampleProposalTemplate(companyName)];
  await prisma.contractTemplate.createMany({
    data: templates.map((t) => ({ ...t, workspaceId: workspace.id })),
  });
  await attachOnboardingProfile(workspace.id);
  await logAudit({ workspaceId: workspace.id, actorEmail: email, action: "workspace.created", ip, metadata: { provider: "credentials" } });
  notifySignup({ name, email, workspaceName: companyName, how: "Started a workspace with email and password" });

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  await prisma.emailVerificationToken.create({
    data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
  });
  try {
    await sendVerificationEmail({
      to: email,
      verifyUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/verify-email/${rawToken}`,
    });
  } catch (err) {
    console.error("Failed to send verification email", err);
  }

  try {
    await signIn("credentials", { email, password, redirectTo: "/dashboard" });
  } catch (err) {
    if (err instanceof AuthError) {
      redirect("/login");
    }
    throw err;
  }
}
