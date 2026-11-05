import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { mintSessionCookie, ssoCallbackUrl, verifyIdToken, verifySsoState } from "@/lib/sso";
import { logAudit } from "@/lib/audit";
import { notifySignup } from "@/lib/signup-alert";
import { emailInDomain } from "@/lib/domain-verification";

// A code from the login page's ERROR_MESSAGE list.
function loginError(code: string): NextResponse {
  return NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/login?error=${code}`);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const idpError = url.searchParams.get("error");
  if (idpError) {
    console.error("SSO sign-in returned an error from the identity provider", idpError);
    return loginError("SsoCancelled");
  }

  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  if (!code || !stateParam) return loginError("SsoExpired");

  const state = await verifySsoState(stateParam);
  if (!state) return loginError("SsoExpired");

  const workspace = await prisma.workspace.findUnique({ where: { id: state.workspaceId } });
  if (!workspace || !workspace.ssoEnabled || !workspace.ssoClientSecret || !workspace.allowedEmailDomain) {
    return loginError("SsoDisabled");
  }
  // SSO that was turned on before domains had to be verified keeps working
  // for the people already on the workspace, until another workspace
  // proves the domain is theirs. From then on it belongs to that one.
  const domainVerified = Boolean(workspace.allowedEmailDomainVerifiedAt);
  if (!domainVerified) {
    const claimed = await prisma.workspace.count({
      where: { allowedEmailDomain: workspace.allowedEmailDomain, allowedEmailDomainVerifiedAt: { not: null }, id: { not: workspace.id } },
    });
    if (claimed > 0) return loginError("SsoDisabled");
  }

  // Exchange the authorization code for an ID token — server-to-server,
  // the client secret never touches the browser.
  let tokenResponse: { id_token?: string };
  try {
    const res = await fetch(state.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: ssoCallbackUrl(),
        client_id: state.clientId,
        client_secret: workspace.ssoClientSecret,
        code_verifier: state.codeVerifier,
      }),
    });
    if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
    tokenResponse = await res.json();
  } catch (err) {
    console.error("SSO token exchange failed", err);
    return loginError("SsoFailed");
  }
  if (!tokenResponse.id_token) return loginError("SsoFailed");

  let claims: { email: string; name: string };
  try {
    claims = await verifyIdToken(tokenResponse.id_token, state.jwksUri, state.issuer, state.clientId, state.nonce);
  } catch (err) {
    console.error("SSO ID token verification failed", err);
    return loginError("SsoFailed");
  }

  if (!emailInDomain(claims.email, workspace.allowedEmailDomain)) {
    return loginError("SsoWrongDomain");
  }

  let user = await prisma.user.findUnique({ where: { email: claims.email } });
  if (user && user.workspaceId !== workspace.id) {
    return loginError("SsoOtherWorkspace");
  }

  const idpName = claims.name.trim().slice(0, 100);
  const hasIdpName = Boolean(idpName) && idpName !== claims.email;

  if (!user) {
    // Without a verified domain, only people already on the workspace
    // (invited, or provisioned over SCIM): the identity provider it points
    // at could claim any address there, and letting that create accounts
    // would hand them out for other people's emails.
    if (!domainVerified) {
      await logAudit({ workspaceId: workspace.id, actorEmail: claims.email, action: "login.failure", metadata: { reason: "not_invited", provider: "sso" } });
      return loginError("SsoNotInvited");
    }
    // The workspace proved it owns the domain and this is its own identity
    // provider, so the address is vouched for and there's no separate
    // invite step. No role yet; an admin assigns one afterward, same as a
    // manually invited teammate.
    user = await prisma.user.create({
      data: {
        workspaceId: workspace.id,
        name: hasIdpName ? idpName : claims.email,
        email: claims.email,
        passwordHash: null,
        emailVerifiedAt: new Date(),
      },
    });
    await logAudit({ workspaceId: workspace.id, actorEmail: claims.email, action: "teammate.sso_provisioned" });
    notifySignup({ name: user.name, email: claims.email, workspaceName: workspace.name, how: "Joined with company single sign-on" });
  } else {
    if (user.deactivatedAt) {
      await logAudit({ workspaceId: workspace.id, actorEmail: claims.email, action: "login.failure", metadata: { reason: "deactivated", provider: "sso" } });
      return loginError("AccountDeactivated");
    }

    // An invite leaves the email as the name, so this is their first SSO
    // sign-in: take the name from the identity provider. The address only
    // counts as verified when the workspace has proven the domain.
    const firstSignIn = user.name === user.email && hasIdpName;
    const verifyEmail = domainVerified && !user.emailVerifiedAt;
    if (firstSignIn || verifyEmail) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { ...(firstSignIn ? { name: idpName } : {}), ...(verifyEmail ? { emailVerifiedAt: new Date() } : {}) },
      });
    }
    if (firstSignIn) {
      notifySignup({ name: user.name, email: claims.email, workspaceName: workspace.name, how: "Joined with company single sign-on" });
    }
  }

  // The cookie carries sessionVersion, so the session check accepts it
  // until the next password or 2FA change.
  const sessionUser = { id: user.id, name: user.name, email: user.email, workspaceId: workspace.id, sessionVersion: user.sessionVersion };
  const cookie = await mintSessionCookie(sessionUser);
  await logAudit({ workspaceId: workspace.id, actorEmail: claims.email, action: "login.success", metadata: { provider: "sso" } });

  const response = NextResponse.redirect(`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/`);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
