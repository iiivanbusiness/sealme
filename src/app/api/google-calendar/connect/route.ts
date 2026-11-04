import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireWorkspaceId } from "@/lib/workspace";
import { requirePermission } from "@/lib/permissions";
import { signOAuthState } from "@/lib/oauth-state";
import { buildAuthorizeUrl, isGoogleCalendarConfigured } from "@/lib/google-calendar";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  // The whole workspace syncs from this one Google account.
  try {
    await requirePermission("canManageWorkspace");
  } catch {
    return NextResponse.redirect(new URL("/calendar?error=google_no_permission", req.url));
  }
  if (!isGoogleCalendarConfigured()) {
    return NextResponse.redirect(new URL("/calendar?error=google_not_configured", req.url));
  }
  const workspaceId = await requireWorkspaceId();
  return NextResponse.redirect(buildAuthorizeUrl(await signOAuthState("google-calendar", workspaceId)));
}
