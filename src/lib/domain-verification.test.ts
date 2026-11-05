import { describe, expect, it } from "vitest";
import {
  domainVerificationRecord,
  emailInDomain,
  isValidDomain,
  newDomainVerificationToken,
  normalizeDomain,
  pickSsoWorkspaceForDomain,
  txtRecordsMatch,
} from "./domain-verification";

describe("normalizeDomain", () => {
  it("lowercases and trims", () => {
    expect(normalizeDomain("  Acme.COM ")).toBe("acme.com");
  });

  it("drops what people paste around the domain", () => {
    expect(normalizeDomain("@acme.com")).toBe("acme.com");
    expect(normalizeDomain("ivan@acme.com")).toBe("acme.com");
    expect(normalizeDomain("https://acme.com/")).toBe("acme.com");
    expect(normalizeDomain("http://acme.com/about?x=1")).toBe("acme.com");
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
    expect(normalizeDomain("acme.com:443")).toBe("acme.com");
  });

  it("keeps subdomains", () => {
    expect(normalizeDomain("Mail.Acme.co.uk")).toBe("mail.acme.co.uk");
  });

  it("leaves an empty field empty", () => {
    expect(normalizeDomain("   ")).toBe("");
  });
});

describe("isValidDomain", () => {
  it("accepts ordinary domains", () => {
    expect(isValidDomain("acme.com")).toBe(true);
    expect(isValidDomain("mail.acme.co.uk")).toBe(true);
    expect(isValidDomain("my-company.io")).toBe(true);
    expect(isValidDomain("xn--80ak6aa92e.xn--p1ai")).toBe(true);
  });

  it("refuses things that aren't domains", () => {
    expect(isValidDomain("")).toBe(false);
    expect(isValidDomain("localhost")).toBe(false);
    expect(isValidDomain("acme")).toBe(false);
    expect(isValidDomain("-acme.com")).toBe(false);
    expect(isValidDomain("acme-.com")).toBe(false);
    expect(isValidDomain("acme..com")).toBe(false);
    expect(isValidDomain("acme.c")).toBe(false);
    expect(isValidDomain("ac me.com")).toBe(false);
    expect(isValidDomain("acme.com/x")).toBe(false);
  });
});

describe("emailInDomain", () => {
  it("matches the exact domain only", () => {
    expect(emailInDomain("ivan@acme.com", "acme.com")).toBe(true);
    expect(emailInDomain("Ivan@ACME.com", "acme.com")).toBe(true);
    expect(emailInDomain("ivan@sub.acme.com", "acme.com")).toBe(false);
    expect(emailInDomain("ivan@notacme.com", "acme.com")).toBe(false);
    expect(emailInDomain("acme.com", "acme.com")).toBe(false);
  });

  it("matches nothing without a domain", () => {
    expect(emailInDomain("ivan@acme.com", null)).toBe(false);
    expect(emailInDomain("ivan@acme.com", "")).toBe(false);
  });
});

describe("txtRecordsMatch", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const record = domainVerificationRecord(token);

  it("finds the record among others", () => {
    expect(record).toBe(`sealme-verification=${token}`);
    expect(txtRecordsMatch([["v=spf1 include:_spf.google.com ~all"], [record]], token)).toBe(true);
  });

  it("joins a record split into chunks", () => {
    expect(txtRecordsMatch([["sealme-verification=", token]], token)).toBe(true);
  });

  it("tolerates pasted quotes and spaces", () => {
    expect(txtRecordsMatch([[` "${record}" `]], token)).toBe(true);
  });

  it("refuses another workspace's token or a partial value", () => {
    expect(txtRecordsMatch([[domainVerificationRecord("ffffffffffffffffffffffffffffffff")]], token)).toBe(false);
    expect(txtRecordsMatch([[`${record}x`]], token)).toBe(false);
    expect(txtRecordsMatch([[token]], token)).toBe(false);
    expect(txtRecordsMatch([], token)).toBe(false);
  });

  it("makes a fresh token each time", () => {
    const a = newDomainVerificationToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newDomainVerificationToken()).not.toBe(a);
  });
});

describe("pickSsoWorkspaceForDomain", () => {
  const verifiedAt = new Date("2026-11-01T00:00:00Z");
  const owner = { id: "ws-owner", ssoEnabled: true, allowedEmailDomainVerifiedAt: verifiedAt };
  const squatter = { id: "ws-squatter", ssoEnabled: true, allowedEmailDomainVerifiedAt: null };

  it("sends everyone to the workspace that verified the domain", () => {
    expect(pickSsoWorkspaceForDomain([squatter, owner], null)).toEqual({ workspace: owner });
    expect(pickSsoWorkspaceForDomain([squatter, owner], "ws-squatter")).toEqual({ workspace: owner });
    expect(pickSsoWorkspaceForDomain([owner], "ws-elsewhere")).toEqual({ workspace: owner });
  });

  it("says SSO isn't set up when the verified workspace has it off", () => {
    const off = { ...owner, ssoEnabled: false };
    expect(pickSsoWorkspaceForDomain([squatter, off], "ws-squatter")).toEqual({ error: "SsoNotConfigured" });
  });

  it("prefers the earliest verification if two ever exist", () => {
    const later = { id: "ws-later", ssoEnabled: true, allowedEmailDomainVerifiedAt: new Date("2026-11-03T00:00:00Z") };
    expect(pickSsoWorkspaceForDomain([later, owner], null)).toEqual({ workspace: owner });
  });

  it("without a verified workspace, only lets members through to their own", () => {
    const other = { id: "ws-other", ssoEnabled: true, allowedEmailDomainVerifiedAt: null };
    expect(pickSsoWorkspaceForDomain([squatter, other], "ws-other")).toEqual({ workspace: other });
    expect(pickSsoWorkspaceForDomain([squatter], null)).toEqual({ error: "SsoNotInvited" });
    expect(pickSsoWorkspaceForDomain([squatter], "ws-elsewhere")).toEqual({ error: "SsoNotInvited" });
  });

  it("ignores unverified workspaces with SSO off", () => {
    const off = { id: "ws-off", ssoEnabled: false, allowedEmailDomainVerifiedAt: null };
    expect(pickSsoWorkspaceForDomain([off], "ws-off")).toEqual({ error: "SsoNotConfigured" });
    expect(pickSsoWorkspaceForDomain([], null)).toEqual({ error: "SsoNotConfigured" });
  });
});
