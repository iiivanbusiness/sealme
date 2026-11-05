import { prisma } from "@/lib/db";
import { authenticateScimRequest, scimError, scimJson, toScimUser } from "@/lib/scim";

function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "";
}

// Deactivating someone also signs them out everywhere: a session signed
// with an older sessionVersion stops working. Updating and deactivating
// people who are already here works whether or not the workspace has
// verified its domain; only creating new ones needs that (see ../route.ts).
const END_SESSIONS = { sessionVersion: { increment: 1 } };

// Refuses to deactivate the workspace's last teammate who can manage the
// team — same safety net the manual "remove teammate" flow already
// enforces, applied here too since an IdP-driven offboarding queue can hit
// this exact case (a departing admin) just as easily as a person clicking
// a button. Returns a scimError response to send back, or null if the
// deactivation is safe to proceed.
async function guardLastTeamManager(userId: string, workspaceId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user?.role?.canManageTeam) return null;
  const others = await prisma.user.count({
    where: { workspaceId, id: { not: userId }, deactivatedAt: null, role: { canManageTeam: true } },
  });
  if (others === 0) return scimError(409, "This is the only active teammate who can manage the team. Reassign that role before deactivating them");
  return null;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const workspace = await authenticateScimRequest(req);
  if (!workspace) return scimError(401, "Invalid or missing bearer token");

  const { id } = await params;
  const user = await prisma.user.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!user) return scimError(404, "User not found");

  return scimJson(toScimUser(user, appUrl()));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const workspace = await authenticateScimRequest(req);
  if (!workspace) return scimError(401, "Invalid or missing bearer token");

  const { id } = await params;
  const existing = await prisma.user.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!existing) return scimError(404, "User not found");

  let body: { name?: { formatted?: string }; displayName?: string; active?: boolean; externalId?: string };
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON body");
  }

  const deactivating = body.active === false && !existing.deactivatedAt;
  if (deactivating) {
    const blocked = await guardLastTeamManager(id, workspace.id);
    if (blocked) return blocked;
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      name: body.name?.formatted || body.displayName || existing.name,
      scimExternalId: body.externalId ?? existing.scimExternalId,
      deactivatedAt: body.active === false ? (existing.deactivatedAt ?? new Date()) : body.active === true ? null : existing.deactivatedAt,
      ...(deactivating ? END_SESSIONS : {}),
    },
  });

  return scimJson(toScimUser(user, appUrl()));
}

type PatchOp = { op?: string; path?: string; value?: unknown };

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const workspace = await authenticateScimRequest(req);
  if (!workspace) return scimError(401, "Invalid or missing bearer token");

  const { id } = await params;
  const existing = await prisma.user.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!existing) return scimError(404, "User not found");

  let body: { Operations?: PatchOp[] };
  try {
    body = await req.json();
  } catch {
    return scimError(400, "Invalid JSON body");
  }

  // Two shapes float around in the wild for the same "set active" intent:
  // {op, path: "active", value: false} and {op, value: {active: false}}
  // with no path at all. Look for either.
  let active: boolean | undefined;
  let name: string | undefined;
  for (const operation of body.Operations ?? []) {
    const path = operation.path?.toLowerCase();
    if (path === "active" && typeof operation.value === "boolean") {
      active = operation.value;
    } else if (!path && typeof operation.value === "object" && operation.value !== null) {
      const v = operation.value as Record<string, unknown>;
      if (typeof v.active === "boolean") active = v.active;
      if (typeof v.displayName === "string") name = v.displayName;
    }
  }

  const deactivating = active === false && !existing.deactivatedAt;
  if (deactivating) {
    const blocked = await guardLastTeamManager(id, workspace.id);
    if (blocked) return blocked;
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      name: name ?? existing.name,
      deactivatedAt: active === false ? (existing.deactivatedAt ?? new Date()) : active === true ? null : existing.deactivatedAt,
      ...(deactivating ? END_SESSIONS : {}),
    },
  });

  return scimJson(toScimUser(user, appUrl()));
}

// SCIM's DELETE technically means "remove the resource," but doing that
// unattended from an automated protocol call is a hard-to-undo action —
// this deactivates instead, same as PATCH/PUT active:false. A workspace
// admin can still hard-remove someone by hand from Settings if they
// actually want the record gone.
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const workspace = await authenticateScimRequest(req);
  if (!workspace) return scimError(401, "Invalid or missing bearer token");

  const { id } = await params;
  const existing = await prisma.user.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!existing) return scimError(404, "User not found");

  if (!existing.deactivatedAt) {
    const blocked = await guardLastTeamManager(id, workspace.id);
    if (blocked) return blocked;
    await prisma.user.update({ where: { id }, data: { deactivatedAt: new Date(), ...END_SESSIONS } });
  }

  return new Response(null, { status: 204 });
}
