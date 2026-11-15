import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { isAdminEmail } from "@/lib/admin";
import { navGroupsFor, mobilePrimaryItems } from "@/lib/nav-config";
import { isPhoneApp } from "@/lib/phone-app-server";
import ThemeToggle from "./ThemeToggle";
import CompanionToggleButton from "./CompanionToggleButton";
import BrandLogo from "./BrandLogo";
import MobileNav from "./MobileNav";
import AppFooter from "./AppFooter";
import SidebarNav from "./SidebarNav";
import ScreenLabel from "./ScreenLabel";
import GlassPanel from "./GlassPanel";
import EmailVerifyBanner from "./EmailVerifyBanner";
import LocalCaptureBanner from "./LocalCaptureBanner";
import TimezoneSync from "./TimezoneSync";
import AiDisclosureModal from "./AiDisclosureModal";
import FaqChatWidget from "./FaqChatWidget";
import NotificationBell from "./NotificationBell";
import GuideTip from "./GuideTip";
import RecordingBanner from "./RecordingBanner";
import { Suspense } from "react";
import Link from "next/link";
import { getUnreadNotifications } from "@/app/(app)/notifications/actions";

const NAV_ICONS: Record<string, () => React.ReactNode> = {
  "/dashboard": DashboardIcon,
  "/leads": LeadsIcon,
  "/team": TeamIcon,
  "/calendar": CalendarIcon,
  "/analytics": AnalyticsIcon,
  "/templates": TemplatesIcon,
  "/feedback": FeedbackIcon,
  "/settings": SettingsIcon,
  "/admin": AdminIcon,
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export default async function AppShell({ children }: { children: React.ReactNode }) {
  const [workspace, session, phone] = await Promise.all([requireWorkspace(), auth(), isPhoneApp()]);
  const workspaceName = workspace.name;
  const isAdmin = isAdminEmail(session?.user?.email);

  const currentUser = session?.user?.email
    ? await prisma.user.findUnique({ where: { email: session.user.email }, select: { aiDisclosureAcknowledgedAt: true, timezone: true, role: { select: { canManageTeam: true } } } })
    : null;
  const manager = Boolean(currentUser?.role?.canManageTeam);
  // How many people are in the workspace, for whether Team is in the menu.
  // Only someone who'd see it needs the count.
  const [{ unreadCount, items: notificationItems }, members] = await Promise.all([
    getUnreadNotifications(),
    manager ? prisma.user.count({ where: { workspaceId: workspace.id, deactivatedAt: null } }) : 0,
  ]);
  const groups = navGroupsFor({ admin: isAdmin, manager, members, phone });
  const withIcon = (item: { href: string; label: string }) => {
    const Icon = NAV_ICONS[item.href];
    return { href: item.href, label: item.label, icon: <Icon /> };
  };
  const navGroups = groups.map((g) => ({ label: g.label, collapsible: g.collapsible, items: g.items.map(withIcon) }));
  const mobileItems = mobilePrimaryItems(groups, { phone }).map(withIcon);

  const navLinks = <SidebarNav groups={navGroups} />;

  const workspaceFooter = (
    <div className="mt-3 flex flex-col gap-2.5 border-t pt-3" style={{ borderColor: "var(--hairline-soft)" }}>
      <div className="flex items-center gap-2.5 px-2">
        <div
          className="flex h-[29px] w-[29px] flex-none items-center justify-center rounded-full font-display text-[12px] font-semibold"
          style={{ background: "var(--surface-2)", color: "var(--ink)" }}
        >
          {initials(workspaceName)}
        </div>
        <span className="truncate text-[13px] font-medium" style={{ color: "var(--ink)" }}>{workspaceName}</span>
      </div>
      {/* Brings the setup guide back after it was hidden. Setting up is
          done on a computer, so the iPhone app has no guide. */}
      {!phone && (
        <Link href="/dashboard?guide=open#setup" className="rounded-[10px] px-3 py-2 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
          Setup guide
        </Link>
      )}
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/login" });
        }}
      >
        <button type="submit" className="w-full rounded-[10px] px-3 py-2 text-left text-[13px] font-medium transition-colors" style={{ color: "var(--ink-muted)" }}>
          Sign out
        </button>
      </form>
    </div>
  );

  return (
    <div className="sm-theme min-h-dvh" style={{ background: "var(--canvas)" }}>
      <div className="grid min-h-dvh grid-cols-1 md:grid-cols-[232px_1fr]">
        <GlassPanel
          as="nav"
          className="m-3.5 hidden rounded-[28px] px-3.5 py-[22px] md:flex md:sticky md:top-3.5 md:h-[calc(100dvh-28px)] md:self-start"
        >
          <div className="mb-5 px-2">
            <BrandLogo height={20} />
          </div>
          {navLinks}
          {workspaceFooter}
        </GlassPanel>

        <div className="flex min-w-0 flex-col">
          <header
            className="m-3.5 flex items-center justify-between rounded-[20px] px-3.5 py-[13px] md:px-[22px]"
            style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <ScreenLabel />
            </div>
            <div className="flex items-center gap-1">
              <NotificationBell initialUnreadCount={unreadCount} initialItems={notificationItems} />
              <CompanionToggleButton />
              <ThemeToggle />
            </div>
          </header>

          {phone && <RecordingBanner />}
          <EmailVerifyBanner />
          <LocalCaptureBanner />

          <main className="mx-auto w-full max-w-[1180px] flex-1 px-3.5 pt-2 md:px-6">
            <Suspense fallback={null}>
              <GuideTip />
            </Suspense>
            {children}
          </main>
          {/* The website's footer; the iPhone app goes without. */}
          {!phone && <AppFooter />}
        </div>
      </div>

      {currentUser && <AiDisclosureModal show={!currentUser.aiDisclosureAcknowledgedAt} />}
      <TimezoneSync stored={currentUser?.timezone ?? null} />

      {/* Over the content on a phone screen; the app has Feedback in the menu. */}
      {!phone && <FaqChatWidget prospecting />}

      <MobileNav
        items={mobileItems}
        drawerContent={
          <>
            <div className="mb-7 px-1">
              <BrandLogo height={20} />
            </div>
            <SidebarNav groups={navGroups} expandAll />
            {workspaceFooter}
          </>
        }
      />
    </div>
  );
}

function iconProps() {
  return { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.6, width: 19, height: 19 } as const;
}

function DashboardIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="3" width="6.5" height="6.5" rx="1.4" />
      <rect x="10.5" y="3" width="6.5" height="4.2" rx="1.4" />
      <rect x="10.5" y="8.7" width="6.5" height="8.3" rx="1.4" />
      <rect x="3" y="11" width="6.5" height="6" rx="1.4" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="4.5" width="14" height="12" rx="1.6" />
      <path d="M3 8.5h14M7 2.5v3M13 2.5v3" />
    </svg>
  );
}

function AnalyticsIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M4 16V9M10 16V4M16 16v-6.5" />
      <path d="M2.5 16h15" />
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="10" cy="6.2" r="2.4" />
      <circle cx="4.6" cy="8.4" r="1.8" />
      <circle cx="15.4" cy="8.4" r="1.8" />
      <path d="M5.6 16.4c.4-2.7 2.2-4.2 4.4-4.2s4 1.5 4.4 4.2" />
      <path d="M1.8 15.2c.3-1.8 1.4-2.8 2.8-2.8M18.2 15.2c-.3-1.8-1.4-2.8-2.8-2.8" />
    </svg>
  );
}

function LeadsIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="8" cy="6.6" r="2.7" />
      <path d="M3 16.2c.5-3 2.6-4.6 5-4.6 1.2 0 2.3.4 3.1 1.1" />
      <path d="M14.6 11.2v6M11.6 14.2h6" />
    </svg>
  );
}

function TemplatesIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="4.5" y="2.5" width="11" height="15" rx="1.4" />
      <path d="M7 7h6M7 10h6M7 13h3.5" />
    </svg>
  );
}

function FeedbackIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M3 5.5c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2v6.2c0 1.1-.9 2-2 2H9.4L5.5 17v-3.3H5c-1.1 0-2-.9-2-2V5.5z" />
      <circle cx="7.3" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="10.6" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.9" cy="8.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="10" cy="6" r="1.6" />
      <circle cx="10" cy="14" r="1.6" />
      <path d="M4 6h3.4M12.6 6H16M4 14h3.4M12.6 14H16M10 7.6v4.8" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M10 2.5l6 2.4v4.4c0 4-2.6 6.6-6 8.2-3.4-1.6-6-4.2-6-8.2V4.9l6-2.4z" />
      <path d="M7.4 10l1.9 1.9L12.7 8" />
    </svg>
  );
}
