import { randomBytes, createHash } from "crypto";
import { encode as encodeJwt, decode as decodeJwt } from "next-auth/jwt";
import { createRemoteJWKSet, jwtVerify } from "jose";

const SSO_STATE_SALT = "sso-state"; // deliberately distinct from the real session cookie's salt (its own name) — never decryptable as a session token even if replayed as one
const SSO_STATE_MAX_AGE = 10 * 60; // the whole redirect-to-IdP-and-back round trip has to finish inside this

function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured");
  return secret;
}

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

export function ssoCallbackUrl(): string {
  return `${appUrl()}/api/sso/callback`;
}

export type OidcConfig = { authorization_endpoint: string; token_endpoint: string; jwks_uri: string };

export async function discoverOidcConfig(issuer: string): Promise<OidcConfig> {
  const wellKnownUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
  const res = await fetch(wellKnownUrl);
  if (!res.ok) throw new Error(`Couldn't reach the identity provider's discovery document (${res.status})`);
  const config = (await res.json()) as Partial<OidcConfig>;
  if (!config.authorization_endpoint || !config.token_endpoint || !config.jwks_uri) {
    throw new Error("The identity provider's discovery document is missing required fields");
  }
  return config as OidcConfig;
}

export function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

// tokenEndpoint/jwksUri/issuer/clientId ride along too, discovered once at
// /start — the callback trusts this snapshot rather than re-running
// discovery, so the two legs of one login attempt can never disagree about
// which endpoints to use. Nothing here is secret enough to avoid putting
// in an *encrypted* JWT (this is JWE, not just a signed token) but the
// client secret itself still isn't included — that's re-read from the DB
// at callback time instead of riding through a browser redirect twice.
export type SsoState = {
  workspaceId: string;
  nonce: string;
  codeVerifier: string;
  tokenEndpoint: string;
  jwksUri: string;
  issuer: string;
  clientId: string;
};

// The whole in-flight login attempt (which workspace, the OIDC nonce, the
// PKCE verifier) rides in the signed `state` param instead of a server-side
// session store — there's no separate table for it, and a signed JWT is
// exactly as tamper-proof as a DB row would be for something this
// short-lived.
export async function signSsoState(state: SsoState): Promise<string> {
  return encodeJwt({ token: state, secret: authSecret(), salt: SSO_STATE_SALT, maxAge: SSO_STATE_MAX_AGE });
}

export async function verifySsoState(token: string): Promise<SsoState | null> {
  try {
    const payload = await decodeJwt<SsoState>({ token, secret: authSecret(), salt: SSO_STATE_SALT });
    if (!payload || typeof payload.workspaceId !== "string" || typeof payload.nonce !== "string" || typeof payload.codeVerifier !== "string") {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export async function verifyIdToken(idToken: string, jwksUri: string, issuer: string, clientId: string, nonce: string) {
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  const { payload } = await jwtVerify(idToken, jwks, { issuer, audience: clientId });
  if (payload.nonce !== nonce) throw new Error("ID token nonce mismatch. Possible replay");
  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) throw new Error("ID token has no email claim");
  const name = typeof payload.name === "string" ? payload.name : email;
  return { email: email.toLowerCase(), name };
}

// Mints a session cookie in exactly the shape/encryption Auth.js v5 itself
// uses (same salt convention: the cookie's own name), so every existing
// auth()/session() call in the app reads an SSO-issued session no
// differently than one NextAuth minted itself.
export async function mintSessionCookie(user: { id: string; name: string; email: string; workspaceId: string; sessionVersion: number }) {
  const useSecureCookies = appUrl().startsWith("https://");
  const cookieName = useSecureCookies ? "__Secure-authjs.session-token" : "authjs.session-token";
  const maxAge = 30 * 24 * 60 * 60; // matches Auth.js's own default session length

  const token = await encodeJwt({
    token: { name: user.name, email: user.email, picture: null, sub: user.id, workspaceId: user.workspaceId, sessionVersion: user.sessionVersion },
    secret: authSecret(),
    salt: cookieName,
    maxAge,
  });

  return {
    name: cookieName,
    value: token,
    options: {
      httpOnly: true,
      sameSite: "lax" as const,
      path: "/",
      secure: useSecureCookies,
      maxAge,
    },
  };
}
