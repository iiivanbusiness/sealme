import { describe, expect, it } from "vitest";
import { randomBytes } from "crypto";
import {
  googleSignInChanges,
  googleSignInRefusal,
  isSessionCurrent,
  normalizeEmail,
  pickSsoWorkspace,
  sessionVersionOf,
  signSessionReissue,
  verifySessionReissue,
} from "./auth-rules";

const now = new Date("2026-11-04T10:00:00Z");
const account = {
  name: "Ana Petrović",
  email: "ana@firma.com",
  passwordHash: null as string | null,
  emailVerifiedAt: new Date("2026-10-01T00:00:00Z") as Date | null,
  twoFactorEnabled: false,
  deactivatedAt: null as Date | null,
};

describe("normalizeEmail", () => {
  it("matches the lowercased address signup stored", () => {
    expect(normalizeEmail("  Ivan@Firma.com ")).toBe("ivan@firma.com");
    expect(normalizeEmail(undefined)).toBe("");
    expect(normalizeEmail(42)).toBe("");
  });
});

describe("googleSignInRefusal", () => {
  it("lets new and ordinary accounts in", () => {
    expect(googleSignInRefusal(null)).toBeNull();
    expect(googleSignInRefusal(account)).toBeNull();
  });
  it("turns away deactivated accounts", () => {
    expect(googleSignInRefusal({ ...account, deactivatedAt: now })).toBe("AccountDeactivated");
  });
  it("sends a verified account with 2FA to the password form", () => {
    expect(googleSignInRefusal({ ...account, twoFactorEnabled: true })).toBe("Google2fa");
  });
  it("doesn't let an unverified account's 2FA lock the address owner out", () => {
    expect(googleSignInRefusal({ ...account, emailVerifiedAt: null, twoFactorEnabled: true })).toBeNull();
  });
});

describe("googleSignInChanges", () => {
  it("changes nothing on a verified account with a real name", () => {
    expect(googleSignInChanges({ ...account, passwordHash: "hash" }, "Ana P.", now)).toBeNull();
  });
  it("verifies an invited teammate and takes Google's name", () => {
    const invited = { ...account, name: "ana@firma.com", emailVerifiedAt: null };
    expect(googleSignInChanges(invited, "Ana Petrović", now)).toEqual({ emailVerifiedAt: now, name: "Ana Petrović" });
  });
  it("keeps the email as the name when Google has none", () => {
    const invited = { ...account, name: "ana@firma.com", emailVerifiedAt: null };
    expect(googleSignInChanges(invited, "  ", now)).toEqual({ emailVerifiedAt: now });
  });
  it("drops a password and 2FA nobody proved the address for, and signs out their sessions", () => {
    const squatted = { ...account, emailVerifiedAt: null, passwordHash: "attacker", twoFactorEnabled: true };
    expect(googleSignInChanges(squatted, "Ana Petrović", now)).toEqual({
      emailVerifiedAt: now,
      passwordHash: null,
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: null,
      sessionVersion: { increment: 1 },
    });
  });
  it("signs nobody out when there was no password to drop", () => {
    const invited = { ...account, name: "ana@firma.com", emailVerifiedAt: null };
    expect(googleSignInChanges(invited, "Ana", now)).not.toHaveProperty("sessionVersion");
  });
});

describe("pickSsoWorkspace", () => {
  const a = { id: "ws-a" };
  const b = { id: "ws-b" };
  it("uses the workspace the person is already on", () => {
    expect(pickSsoWorkspace([a], "ws-a")).toEqual({ workspace: a });
    expect(pickSsoWorkspace([a, b], "ws-b")).toEqual({ workspace: b });
  });
  it("sends nobody else to a workspace's identity provider", () => {
    expect(pickSsoWorkspace([a], null)).toEqual({ error: "SsoNotInvited" });
    expect(pickSsoWorkspace([a, b], null)).toEqual({ error: "SsoNotInvited" });
    expect(pickSsoWorkspace([a], "ws-other")).toEqual({ error: "SsoNotInvited" });
  });
  it("says SSO isn't set up when nobody claims the domain", () => {
    expect(pickSsoWorkspace([], "ws-a")).toEqual({ error: "SsoNotConfigured" });
  });
});

describe("isSessionCurrent", () => {
  it("keeps sessions from before versions existed on accounts that never changed", () => {
    expect(isSessionCurrent(undefined, 0)).toBe(true);
  });
  it("signs out those same sessions once the password or 2FA changes", () => {
    expect(isSessionCurrent(undefined, 1)).toBe(false);
  });
  it("only lets in the account's current version", () => {
    expect(isSessionCurrent(2, 2)).toBe(true);
    expect(isSessionCurrent(1, 2)).toBe(false);
    expect(isSessionCurrent(3, 2)).toBe(false);
  });
  it("counts anything that isn't a whole version as 0", () => {
    for (const raw of ["2", null, -1, 1.5, Number.NaN, {}]) expect(sessionVersionOf(raw)).toBe(0);
    expect(isSessionCurrent("2", 2)).toBe(false);
  });
});

describe("session reissue", () => {
  const key = randomBytes(32);
  const at = now.getTime();
  const reissue = signSessionReissue(key, "ana@firma.com", 3, at);

  it("moves the session that made the change to the new version", () => {
    expect(verifySessionReissue(key, reissue, "ana@firma.com", at)).toBe(3);
    expect(verifySessionReissue(key, reissue, "Ana@Firma.com", at + 59_000)).toBe(3);
  });
  it("works for nobody else's session", () => {
    expect(verifySessionReissue(key, reissue, "eve@firma.com", at)).toBeNull();
  });
  it("can't be made up or edited without the server's key", () => {
    expect(verifySessionReissue(key, { ...reissue, version: 4 }, "ana@firma.com", at)).toBeNull();
    expect(verifySessionReissue(key, { ...reissue, issuedAt: at - 1 }, "ana@firma.com", at)).toBeNull();
    expect(verifySessionReissue(randomBytes(32), reissue, "ana@firma.com", at)).toBeNull();
    expect(verifySessionReissue(key, { version: 3, issuedAt: at, signature: "x" }, "ana@firma.com", at)).toBeNull();
  });
  it("is only good for a minute", () => {
    expect(verifySessionReissue(key, reissue, "ana@firma.com", at + 61_000)).toBeNull();
    expect(verifySessionReissue(key, reissue, "ana@firma.com", at - 1)).toBeNull();
  });
  it("ignores update data that isn't a reissue", () => {
    for (const raw of [undefined, null, "3", 3, {}, { version: 3 }]) expect(verifySessionReissue(key, raw, "ana@firma.com", at)).toBeNull();
  });
});
