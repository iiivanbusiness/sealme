import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { discoverOidcConfig, generatePkce, signSsoState, ssoCallbackUrl } from "@/lib/sso";
import { pickSsoWorkspaceForDomain } from "@/lib/domain-verification";
import { randomBytes } from "crypto";

// A code from the login page's ERROR_MESSAGE list.
function loginError(code: string): NextResponse {
  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/login?error=${code}`);
}

// There's no per-workspace vanity login URL, so the tenant is resolved the
// same way the rest of enterprise access control already works here: by
// matching the email's domain against the workspace's allowedEmailDomain.
// A workspace that proved it owns the domain takes everyone at it; before
// anyone has, only someone already on a workspace is sent there (see
// pickSsoWorkspaceForDomain).
export async function GET(req: Request) {
  const email = new URL(req.url).searchParams.get("email")?.trim().toLowerCase();
  const domain = email?.split("@")[1];
  if (!email || !domain) return loginError("SsoNoEmail");

  const [candidates, member] = await Promise.all([
    prisma.workspace.findMany({
      where: { allowedEmailDomain: domain, OR: [{ ssoEnabled: true }, { allowedEmailDomainVerifiedAt: { not: null } }] },
    }),
    prisma.user.findUnique({ where: { email }, select: { workspaceId: true } }),
  ]);
  const picked = pickSsoWorkspaceForDomain(candidates, member?.workspaceId);
  if ("error" in picked) return loginError(picked.error);
  const { workspace } = picked;
  if (!workspace.ssoIssuer || !workspace.ssoClientId) return loginError("SsoNotConfigured");

  let oidc;
  try {
    oidc = await discoverOidcConfig(workspace.ssoIssuer);
  } catch (err) {
    console.error("SSO discovery failed", err);
    return loginError("SsoIdpUnreachable");
  }

  const nonce = randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = generatePkce();

  const state = await signSsoState({
    workspaceId: workspace.id,
    nonce,
    codeVerifier,
    tokenEndpoint: oidc.token_endpoint,
    jwksUri: oidc.jwks_uri,
    issuer: workspace.ssoIssuer,
    clientId: workspace.ssoClientId,
  });

  const authorizeUrl = new URL(oidc.authorization_endpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", workspace.ssoClientId);
  authorizeUrl.searchParams.set("redirect_uri", ssoCallbackUrl());
  authorizeUrl.searchParams.set("scope", "openid email profile");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("nonce", nonce);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return NextResponse.redirect(authorizeUrl.toString());
}
