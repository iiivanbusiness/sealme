import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { exchangeCodeForTokens, getUserEmail, hasCalendarScope, revokeGoogleToken } from "@/lib/google-calendar";
import { requireWorkspaceId } from "@/lib/workspace";
import { requirePermission } from "@/lib/permissions";
import { isValidOAuthState } from "@/lib/oauth-state";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/calendar?error=google_${error}`, req.url));
  }
  if (!code) {
    return NextResponse.redirect(new URL("/calendar?error=google_no_code", req.url));
  }
  // Checked again here, before the code is traded for tokens, since the
  // callback can be reached without going through Connect.
  try {
    await requirePermission("canManageWorkspace");
  } catch {
    return NextResponse.redirect(new URL("/calendar?error=google_no_permission", req.url));
  }

  try {
    const workspaceId = await requireWorkspaceId();
    if (!(await isValidOAuthState("google-calendar", url.searchParams.get("state"), workspaceId))) {
      return NextResponse.redirect(new URL("/calendar?error=google_invalid_state", req.url));
    }
    const tokens = await exchangeCodeForTokens(code);
    if (!hasCalendarScope(tokens.scope)) {
      // Signed in but left calendar access unticked: keep nothing, so the
      // page doesn't claim a connection that can't read any events.
      await revokeGoogleToken(tokens.refresh_token ?? tokens.access_token);
      return NextResponse.redirect(new URL("/calendar?error=google_calendar_not_shared", req.url));
    }
    const email = await getUserEmail(tokens.access_token);

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) throw new Error("No workspace found");

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token ?? workspace.googleRefreshToken,
        googleTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        googleAccountEmail: email,
      },
    });

    return NextResponse.redirect(new URL("/calendar?connected=1", req.url));
  } catch {
    return NextResponse.redirect(new URL("/calendar?error=google_token_exchange", req.url));
  }
}
