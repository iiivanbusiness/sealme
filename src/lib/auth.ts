import { cache } from "react";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { authConfig } from "@/lib/auth.config";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { buildDefaultTemplates } from "@/lib/default-templates";
import { attachOnboardingProfile } from "@/lib/onboarding";
import { createOwnerRole } from "@/lib/permissions";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { notifySignup } from "@/lib/signup-alert";
import { verifyTotpCode, consumeBackupCode, type BackupCode } from "@/lib/two-factor";
import { googleSignInChanges, googleSignInRefusal, normalizeEmail } from "@/lib/auth-rules";

const findSessionAccount = cache((email: string) =>
  prisma.user.findUnique({ where: { email }, select: { workspaceId: true, deactivatedAt: true } })
);

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        code: { label: "2FA code", type: "text" },
      },
      authorize: async (credentials) => {
        const email = normalizeEmail(credentials?.email);
        const password = credentials?.password as string | undefined;
        const code = (credentials?.code as string | undefined)?.trim();
        if (!email || !password) return null;

        const allowed = await checkRateLimit(`login:${email}`, 10, 15 * 60 * 1000);
        if (!allowed) {
          await logAudit({ actorEmail: email, action: "login.rate_limited" });
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) {
          await logAudit({ actorEmail: email, action: "login.failure", metadata: { reason: "no_such_account" } });
          return null;
        }
        if (user.deactivatedAt) {
          await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "login.failure", metadata: { reason: "deactivated" } });
          return null;
        }

        const valid = verifyPassword(password, user.passwordHash);
        if (!valid) {
          await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "login.failure", metadata: { reason: "wrong_password" } });
          return null;
        }

        if (user.twoFactorEnabled) {
          if (!code) {
            await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "login.failure", metadata: { reason: "missing_2fa_code" } });
            return null;
          }

          const totpValid = user.twoFactorSecret ? await verifyTotpCode(code, user.twoFactorSecret) : false;
          if (!totpValid) {
            // Not a valid TOTP code — try it as a one-time backup code instead.
            const stored: BackupCode[] = user.twoFactorBackupCodes ? JSON.parse(user.twoFactorBackupCodes) : [];
            const updated = consumeBackupCode(code, stored);
            if (!updated) {
              await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "login.failure", metadata: { reason: "invalid_2fa_code" } });
              return null;
            }
            await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: JSON.stringify(updated) } });
            await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "login.success", metadata: { provider: "credentials", via: "backup_code" } });
            return { id: user.id, name: user.name, email: user.email, workspaceId: user.workspaceId };
          }
        }

        await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "login.success", metadata: { provider: "credentials" } });
        return { id: user.id, name: user.name, email: user.email, workspaceId: user.workspaceId };
      },
    }),
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Runs before jwt on every sign-in. Passwords are checked in authorize
    // and SSO in its own route, so only Google needs a gate here, and
    // returning a /login URL lets the page say why.
    async signIn({ account, profile }) {
      if (account?.provider !== "google") return true;
      if (!profile?.email || profile.email_verified === false) return "/login?error=GoogleUnverified";
      const email = normalizeEmail(profile.email);
      const user = await prisma.user.findUnique({
        where: { email },
        select: { workspaceId: true, emailVerifiedAt: true, twoFactorEnabled: true, deactivatedAt: true },
      });
      const refusal = googleSignInRefusal(user);
      if (refusal) {
        await logAudit({
          workspaceId: user?.workspaceId,
          actorEmail: email,
          action: "login.failure",
          metadata: { reason: refusal === "Google2fa" ? "2fa_required" : "deactivated", provider: "google" },
        });
        return `/login?error=${refusal}`;
      }
      return true;
    },
    // Runs on every request that touches a session, but `account`/`profile` are
    // only present right after a provider's sign-in exchange — everywhere else
    // this is just decoding the existing token, so the DB lookup below only
    // ever fires on an actual Google sign-in, never on routine session reads.
    async jwt(params) {
      const token = await authConfig.callbacks.jwt(params);
      const { account, profile } = params;

      if (account?.provider === "google" && !token.workspaceId && profile?.email) {
        const email = normalizeEmail(profile.email);
        let user = await prisma.user.findUnique({ where: { email } });

        if (!user) {
          const name = (profile.name as string | undefined) ?? email;
          const workspace = await prisma.workspace.create({ data: { name: `${name}'s Workspace` } });
          const ownerRole = await createOwnerRole(workspace.id);
          user = await prisma.user.create({
            data: { workspaceId: workspace.id, name, email, passwordHash: null, emailVerifiedAt: new Date(), roleId: ownerRole.id },
          });
          const templates = buildDefaultTemplates(workspace.name);
          await prisma.contractTemplate.createMany({
            data: templates.map((t) => ({ ...t, workspaceId: workspace.id })),
          });
          await attachOnboardingProfile(workspace.id);
          await logAudit({ workspaceId: workspace.id, actorEmail: email, action: "workspace.created", metadata: { provider: "google" } });
          notifySignup({ name, email, workspaceName: workspace.name, how: "Started a workspace with Google" });
        } else {
          // An invited teammate has no password, so Google is their only way
          // in — every sign-in already re-confirms the address with Google,
          // so there's no separate "click a link" step for them to do.
          const firstTime = !user.emailVerifiedAt;
          const hadPassword = Boolean(user.passwordHash);
          const changes = googleSignInChanges(user, profile.name, new Date());
          if (changes) user = await prisma.user.update({ where: { id: user.id }, data: changes });
          if (firstTime && hadPassword) {
            await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "account.unverified_password_removed", metadata: { provider: "google" } });
          } else if (firstTime) {
            // Their first time in: an invite accepted.
            const joined = await prisma.workspace.findUnique({ where: { id: user.workspaceId }, select: { name: true } });
            notifySignup({ name: user.name, email, workspaceName: joined?.name ?? "", how: "Joined by invite, with Google" });
          }
        }

        // Deactivated accounts were already turned away in signIn.
        await logAudit({ workspaceId: user.workspaceId, actorEmail: email, action: "login.success", metadata: { provider: "google" } });
        token.workspaceId = user.workspaceId;
        // The session check below looks the account up by this address.
        token.email = user.email;
      }

      // Deactivation, removal, and self-deletion are otherwise only enforced at
      // sign-in, and a JWT lives for 30 days. Returning null clears the cookie.
      if (typeof token.email === "string") {
        const account = await findSessionAccount(token.email);
        if (!account || account.deactivatedAt) return null;
        if (token.workspaceId && token.workspaceId !== account.workspaceId) return null;
      }

      return token;
    },
  },
});
