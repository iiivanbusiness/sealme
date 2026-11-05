import { prisma } from "@/lib/db";
import { authenticateScimRequest, parseUserNameEqFilter, scimError, scimJson, scimListResponse, toScimUser } from "@/lib/scim";
import { sendTeammateInviteEmail } from "@/lib/email";
import { emailInDomain } from "@/lib/domain-verification";

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

// GET /api/scim/v2/Users — list (paginated) or, when the IdP sends
// ?filter=userName eq "...", look up exactly one person. Okta/Azure both
// issue a filtered GET before every create, to check whether the person
// already exists — this has to return an empty (not error) ListResponse
// when they don't, or provisioning fails on step one.
export async function GET(req: Request) {
  const workspace = await authenticateScimRequest(req);
  if (!workspace) return scimError(401, "Invalid or missing bearer token");

  const url = new URL(req.url);
  const filterUserName = parseUserNameEqFilter(url.searchParams.get("filter"));
  const startIndex = Math.max(1, parseInt(url.searchParams.get("startIndex") ?? "1", 10) || 1);
  const count = Math.min(100, Math.max(1, parseInt(url.searchParams.get("count") ?? "20", 10) || 20));

  if (filterUserName) {
    const user = await prisma.user.findFirst({ where: { workspaceId: workspace.id, email: filterUserName.toLowerCase() } });
    const resources = user ? [toScimUser(user, appUrl())] : [];
    return scimJson(scimListResponse(resources, resources.length, 1));
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" }, skip: startIndex - 1, take: count }),
    prisma.user.count({ where: { workspaceId: workspace.id } }),
  ]);

  return scimJson(scimListResponse(users.map((u) => toScimUser(u, appUrl())), total, startIndex));
}

// POST /api/scim/v2/Users — provisions a new teammate, same shape as
// inviting one by hand (no password, email pre-verified since the IdP
// already vouches for their identity, no role until an admin assigns one).
// Only for addresses at the domain this workspace proved it owns: anyone
// can generate a SCIM token for their own workspace, so without that an
// attacker could create accounts for other companies' people and hold on
// to their addresses.
export async function POST(req: Request) {
  const workspace = await authenticateScimRequest(req);
  if (!workspace) return scimError(401, "Invalid or missing bearer token");

  let body: {
    userName?: string;
    externalId?: string;
    name?: { formatted?: string };
    displayName?: string;
    emails?: { value?: string; primary?: boolean }[];
    active?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON body");
  }

  const email = (body.userName || body.emails?.[0]?.value || "").trim().toLowerCase();
  if (!email) return scimError(400, "userName (or an email) is required");

  if (!workspace.allowedEmailDomain || !workspace.allowedEmailDomainVerifiedAt) {
    return scimError(403, "Verify this workspace's email domain in SealMe Settings (Access & provisioning) before provisioning new users");
  }
  if (!emailInDomain(email, workspace.allowedEmailDomain)) {
    return scimError(400, `This workspace only accepts @${workspace.allowedEmailDomain} email addresses`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return scimError(409, "A user with this email already exists");

  const name = body.name?.formatted || body.displayName || email;
  const user = await prisma.user.create({
    data: {
      workspaceId: workspace.id,
      name,
      email,
      passwordHash: null,
      emailVerifiedAt: new Date(),
      scimExternalId: body.externalId ?? null,
      deactivatedAt: body.active === false ? new Date() : null,
    },
  });

  try {
    await sendTeammateInviteEmail({
      to: email,
      inviterName: `${workspace.name}'s IT team`,
      workspaceName: workspace.name,
      loginUrl: `${appUrl()}/login`,
    });
  } catch (err) {
    console.error("Failed to send SCIM-provisioned invite email", err);
  }

  return scimJson(toScimUser(user, appUrl()), 201);
}
