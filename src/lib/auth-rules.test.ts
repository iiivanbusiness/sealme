import { describe, expect, it } from "vitest";
import { googleSignInChanges, googleSignInRefusal, normalizeEmail, pickSsoWorkspace } from "./auth-rules";

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
  it("drops a password and 2FA nobody proved the address for", () => {
    const squatted = { ...account, emailVerifiedAt: null, passwordHash: "attacker", twoFactorEnabled: true };
    expect(googleSignInChanges(squatted, "Ana Petrović", now)).toEqual({
      emailVerifiedAt: now,
      passwordHash: null,
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: null,
    });
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
