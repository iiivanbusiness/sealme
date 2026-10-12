import type { NextAuthConfig } from "next-auth";
import { NextResponse } from "next/server";
import { isPhoneAppUserAgent, phoneAppRedirect } from "@/lib/phone-app";

export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt" },
  providers: [],
  callbacks: {
    jwt({ token, user }) {
      if (user) token.workspaceId = user.workspaceId;
      return token;
    },
    session({ session, token }) {
      if (typeof token.workspaceId === "string") session.user.workspaceId = token.workspaceId;
      return session;
    },
    authorized({ auth, request }) {
      const isPublic =
        request.nextUrl.pathname === "/" ||
        request.nextUrl.pathname.startsWith("/login") ||
        request.nextUrl.pathname.startsWith("/sign") ||
        request.nextUrl.pathname.startsWith("/portal") ||
        request.nextUrl.pathname.startsWith("/onboarding") ||
        request.nextUrl.pathname.startsWith("/verify-email") ||
        request.nextUrl.pathname.startsWith("/forgot-password") ||
        request.nextUrl.pathname.startsWith("/reset-password") ||
        request.nextUrl.pathname.startsWith("/api/contracts") ||
        request.nextUrl.pathname.startsWith("/api/local-capture") ||
        request.nextUrl.pathname.startsWith("/updates") ||
        request.nextUrl.pathname.startsWith("/api/cron") ||
        request.nextUrl.pathname.startsWith("/api/scim") ||
        request.nextUrl.pathname.startsWith("/api/sso") ||
        request.nextUrl.pathname.startsWith("/api/v1") ||
        request.nextUrl.pathname.startsWith("/api/docusign/webhook") ||
        request.nextUrl.pathname.startsWith("/api/hubspot/webhook") ||
        request.nextUrl.pathname.startsWith("/api/salesforce/webhook") ||
        request.nextUrl.pathname.startsWith("/api/telnyx/webhook") ||
        request.nextUrl.pathname.startsWith("/developers") ||
        request.nextUrl.pathname === "/api/health" ||
        request.nextUrl.pathname.startsWith("/security") ||
        request.nextUrl.pathname.startsWith("/terms") ||
        request.nextUrl.pathname.startsWith("/privacy") ||
        request.nextUrl.pathname.startsWith("/support") ||
        request.nextUrl.pathname.startsWith("/api/client-error");
      if (isPublic) return true;
      if (!auth?.user) return false;
      // What only works on a computer isn't in the iPhone app.
      const phoneTo = isPhoneAppUserAgent(request.headers.get("user-agent")) ? phoneAppRedirect(request.nextUrl.pathname) : null;
      return phoneTo ? NextResponse.redirect(new URL(phoneTo, request.nextUrl)) : true;
    },
  },
} satisfies NextAuthConfig;
