// Sign-in decisions kept out of auth.ts and the SSO routes, so they can be
// tested without NextAuth or the database.

import { createHmac, timingSafeEqual } from "crypto";

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
  sessionVersion?: { increment: 1 };
  name?: string;
};

// What a Google sign-in changes on an account that already has this
// address, or null for nothing. Google just proved the address, so it gets
// verified. If the account also has a password, whoever set it never
// proved the address (anyone can sign up with someone else's email and
// wait for the owner to arrive), so the password and 2FA go, and with them
// every session signed in with that password; the owner can set their own
// with Forgot password. An invite leaves the email as the name, and
// Google's name replaces it.
export function googleSignInChanges(user: AccountForGoogle, profileName: string | null | undefined, now: Date): GoogleSignInChanges | null {
  const changes: GoogleSignInChanges = {};
  if (!user.emailVerifiedAt) {
    changes.emailVerifiedAt = now;
    if (user.passwordHash || user.twoFactorEnabled) {
      Object.assign(changes, {
        passwordHash: null,
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorBackupCodes: null,
        sessionVersion: { increment: 1 },
      });
    }
  }
  const name = profileName?.trim();
  if (name && user.name === user.email) changes.name = name.slice(0, 100);
  return Object.keys(changes).length ? changes : null;
}

// Every account's sessionVersion goes up when its password or 2FA changes
// (or Google wipes them, or the account is deleted), and a session only
// works while it carries the account's current one, so each change signs
// out every session made before it. Sessions from before versions existed
// carry none and count as 0, the version every account starts at, so
// adding them signed nobody out.
export function sessionVersionOf(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

export function isSessionCurrent(tokenVersion: unknown, accountVersion: number): boolean {
  return sessionVersionOf(tokenVersion) === accountVersion;
}

// Someone who changes their own password or 2FA stays signed in on the
// device they did it from: the server moves that one session to the new
// version. That travels as Auth.js session-update data, which anyone with
// a session can also send (POST /api/auth/session), so it's signed with a
// key only the server has, for one address and version, and is only good
// for a minute.
export type SessionReissue = { version: number; issuedAt: number; signature: string };

const SESSION_REISSUE_MAX_AGE_MS = 60_000;

function sessionReissueSignature(key: Buffer, email: string, version: number, issuedAt: number): string {
  return createHmac("sha256", key).update(`session-reissue:${normalizeEmail(email)}:${version}:${issuedAt}`).digest("base64url");
}

export function signSessionReissue(key: Buffer, email: string, version: number, now: number): SessionReissue {
  return { version, issuedAt: now, signature: sessionReissueSignature(key, email, version, now) };
}

// The version a session update moves this session to, or null when it
// isn't a reissue this server signed for this address in the last minute.
export function verifySessionReissue(key: Buffer, raw: unknown, email: string, now: number): number | null {
  if (!raw || typeof raw !== "object") return null;
  const { version, issuedAt, signature } = raw as Record<string, unknown>;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) return null;
  if (typeof issuedAt !== "number" || issuedAt > now || now - issuedAt > SESSION_REISSUE_MAX_AGE_MS) return null;
  if (typeof signature !== "string") return null;
  const expected = Buffer.from(sessionReissueSignature(key, email, version, issuedAt));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected) ? version : null;
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
