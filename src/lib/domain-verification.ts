import { randomBytes } from "crypto";
import { Resolver } from "dns/promises";
import { pickSsoWorkspace, type SsoPick } from "@/lib/auth-rules";

// Proving a workspace owns its allowedEmailDomain: the admin adds a DNS TXT
// record on the domain with a token only this workspace knows. Until then
// the domain only limits who can be invited; SSO and SCIM need it proven,
// or any workspace could claim a company's domain and catch its sign-ins.

const TXT_PREFIX = "sealme-verification=";

export function newDomainVerificationToken(): string {
  return randomBytes(16).toString("hex");
}

// What the admin pastes into their DNS provider as the TXT record's value.
export function domainVerificationRecord(token: string): string {
  return `${TXT_PREFIX}${token}`;
}

// Tidies what someone typed into the domain field: "@Acme.com",
// "https://acme.com/", "me@acme.com" and "acme.com." all mean acme.com.
export function normalizeDomain(raw: string): string {
  let domain = raw.trim().toLowerCase();
  domain = domain.replace(/^[a-z]+:\/\//, "");
  domain = domain.slice(domain.lastIndexOf("@") + 1);
  domain = domain.split(/[/?#:]/)[0];
  return domain.replace(/\.+$/, "");
}

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

export function isValidDomain(domain: string): boolean {
  return DOMAIN_PATTERN.test(domain);
}

// Exactly this domain: someone@sub.acme.com or someone@notacme.com aren't
// at acme.com.
export function emailInDomain(email: string, domain: string | null | undefined): boolean {
  if (!domain) return false;
  const at = email.lastIndexOf("@");
  return at > 0 && email.slice(at + 1).trim().toLowerCase() === domain.toLowerCase();
}

// resolveTxt hands back each record as the chunks it was stored in (long
// values get split into 255-byte strings), so they're joined before
// comparing. Some DNS panels keep the quotes people paste around the value.
export function txtRecordsMatch(records: string[][], token: string): boolean {
  const expected = domainVerificationRecord(token);
  return records.some((chunks) => chunks.join("").trim().replace(/^"(.*)"$/, "$1").trim() === expected);
}

export type DomainLookup = "verified" | "missing" | "lookup_failed";

// A short timeout, so a DNS server that never answers doesn't hold up the
// admin's click.
export async function lookupDomainVerification(domain: string, token: string): Promise<DomainLookup> {
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  try {
    const records = await resolver.resolveTxt(domain);
    return txtRecordsMatch(records, token) ? "verified" : "missing";
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return "missing";
    console.error("Domain verification DNS lookup failed", domain, err);
    return "lookup_failed";
  }
}

type SsoCandidate = { id: string; ssoEnabled: boolean; allowedEmailDomainVerifiedAt: Date | null };

// Which workspace an SSO sign-in for a domain goes to, from every workspace
// that has SSO on for it or has verified it. Once a workspace has proven
// the domain, it's the only one: anyone at the domain is sent to its
// identity provider (or told SSO isn't set up, if it's off there), and the
// callback can add people who aren't members yet. Before anyone has proven
// it, the old rule stands: only someone already on a workspace is sent to
// that workspace's provider (see pickSsoWorkspace).
export function pickSsoWorkspaceForDomain<T extends SsoCandidate>(
  workspaces: T[],
  memberOfWorkspaceId: string | null | undefined
): SsoPick<T> {
  const verified = workspaces
    .filter((w) => w.allowedEmailDomainVerifiedAt)
    .sort((a, b) => a.allowedEmailDomainVerifiedAt!.getTime() - b.allowedEmailDomainVerifiedAt!.getTime())[0];
  if (verified) return verified.ssoEnabled ? { workspace: verified } : { error: "SsoNotConfigured" };
  return pickSsoWorkspace(
    workspaces.filter((w) => w.ssoEnabled),
    memberOfWorkspaceId
  );
}
