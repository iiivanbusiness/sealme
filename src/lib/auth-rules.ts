// Sign-in decisions kept out of auth.ts and the SSO routes, so they can be
// tested without NextAuth or the database.

// Signup, invites and password resets all store and look up the address
// lowercased, so a sign-in has to as well: a password manager that saved
// "Ivan@Firma.com" would otherwise never find the account.
export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

type AccountForGoogle = {
  name: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  twoFactorEnabled: boolean;
  deactivatedAt: Date | null;
};

// Why a Google sign-in is turned away, as a /login error code, or null to
// let it in. The Google button can't ask for a 2FA code, so someone who
// turned 2FA on signs in with their password and code instead. That only
// holds once the address is verified: an unverified password and 2FA could
// have been set up by anyone (see googleSignInChanges).
export function googleSignInRefusal(user: Pick<AccountForGoogle, "emailVerifiedAt" | "twoFactorEnabled" | "deactivatedAt"> | null): "AccountDeactivated" | "Google2fa" | null {
  if (!user) return null;
  if (user.deactivatedAt) return "AccountDeactivated";
  if (user.twoFactorEnabled && user.emailVerifiedAt) return "Google2fa";
  return null;
}

export type GoogleSignInChanges = {
  emailVerifiedAt?: Date;
  passwordHash?: null;
  twoFactorEnabled?: false;
  twoFactorSecret?: null;
  twoFactorBackupCodes?: null;
  name?: string;
};

// What a Google sign-in changes on an account that already has this
// address, or null for nothing. Google just proved the address, so it gets
// verified. If the account also has a password, whoever set it never
// proved the address (anyone can sign up with someone else's email and
// wait for the owner to arrive), so the password and 2FA go; the owner can
// set their own with Forgot password. An invite leaves the email as the
// name, and Google's name replaces it.
export function googleSignInChanges(user: AccountForGoogle, profileName: string | null | undefined, now: Date): GoogleSignInChanges | null {
  const changes: GoogleSignInChanges = {};
  if (!user.emailVerifiedAt) {
    changes.emailVerifiedAt = now;
    if (user.passwordHash || user.twoFactorEnabled) {
      Object.assign(changes, { passwordHash: null, twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null });
    }
  }
  const name = profileName?.trim();
  if (name && user.name === user.email) changes.name = name.slice(0, 100);
  return Object.keys(changes).length ? changes : null;
}

export type SsoPick<T> = { workspace: T } | { error: "SsoNotConfigured" | "SsoNotInvited" };

// Which workspace an SSO sign-in goes to, from the workspaces with SSO on
// for the email's domain: only the one this person is already on. The
// domain isn't proven to be theirs, so any workspace can claim it, and the
// callback only lets members in anyway; sending anyone else on would just
// hand them to an identity provider that may not be their company's. Being
// on another workspace gets the same answer as having no account, so this
// can't be used to look up who has one.
export function pickSsoWorkspace<T extends { id: string }>(candidates: T[], memberOfWorkspaceId: string | null | undefined): SsoPick<T> {
  if (candidates.length === 0) return { error: "SsoNotConfigured" };
  const theirs = candidates.find((w) => w.id === memberOfWorkspaceId);
  return theirs ? { workspace: theirs } : { error: "SsoNotInvited" };
}
