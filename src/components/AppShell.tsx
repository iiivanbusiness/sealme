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
import { Suspense } from "react";
import Link from "next/link";
import { getUnreadNotifications } from "@/app/(app)/notifications/actions";

const NAV_ICONS: Record<string, () => React.ReactNode> = {
  "/dashboard": DashboardIcon,
  "/deals": DealsIcon,
  "/today": TodayIcon,
  "/leads": LeadsIcon,
  "/calls": CallsIcon,
  "/notes": NotesIcon,
  "/team": TeamIcon,
  "/calendar": CalendarIcon,
  "/analytics": AnalyticsIcon,
  "/clients": ClientsIcon,
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
  const { unreadCount, items: notificationItems } = await getUnreadNotifications();
  const groups = navGroupsFor({ prospecting: workspace.prospectingEnabled, admin: isAdmin, manager: Boolean(currentUser?.role?.canManageTeam), phone });
  const withIcon = (item: { href: string; label: string }) => {
    const Icon = NAV_ICONS[item.href];
    return { href: item.href, label: item.label, icon: <Icon /> };
  };
  const navGroups = groups.map((g) => ({ label: g.label, collapsible: g.collapsible, items: g.items.map(withIcon) }));
  const mobileItems = mobilePrimaryItems(groups, { prospecting: workspace.prospectingEnabled, phone }).map(withIcon);

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
      {!phone && <FaqChatWidget prospecting={workspace.prospectingEnabled} />}

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

function DealsIcon() {
  return (
    <svg {...iconProps()}>
      <rect x="3" y="3.5" width="14" height="4.2" rx="1.2" />
      <rect x="3" y="9.2" width="14" height="4.2" rx="1.2" />
      <rect x="3" y="14.9" width="9" height="2.6" rx="1.2" />
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

function TodayIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 2.6v1.8M10 15.6v1.8M2.6 10h1.8M15.6 10h1.8M4.8 4.8l1.3 1.3M13.9 13.9l1.3 1.3M4.8 15.2l1.3-1.3M13.9 6.1l1.3-1.3" />
    </svg>
  );
}

function NotesIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M5.5 2.8h6.2l3.8 3.8v9.6c0 .6-.4 1-1 1H5.5c-.6 0-1-.4-1-1V3.8c0-.6.4-1 1-1Z" />
      <path d="M11.5 2.9v3.9h3.9" />
      <path d="M7.4 10.3h5.2M7.4 13.3h3.6" />
    </svg>
  );
}

function CallsIcon() {
  return (
    <svg {...iconProps()}>
      <path d="M6.6 3.2 4.4 3.6c-.9.2-1.5 1-1.4 1.9.6 5.3 4.8 9.5 10.1 10.1.9.1 1.7-.5 1.9-1.4l.4-2.2c.1-.6-.2-1.2-.8-1.5l-2.3-1c-.5-.2-1.1-.1-1.5.3l-.9.9c-1.6-.8-2.9-2.1-3.7-3.7l.9-.9c.4-.4.5-1 .3-1.5l-1-2.3c-.3-.6-.9-.9-1.5-.8Z" />
      <path d="M12.6 3.4c2.1.4 3.6 1.9 4 4" />
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

function ClientsIcon() {
  return (
    <svg {...iconProps()}>
      <circle cx="7.2" cy="6.8" r="2.6" />
      <circle cx="13.4" cy="8" r="2.1" />
      <path d="M2.6 16.2c.5-2.8 2.4-4.4 4.6-4.4s4.1 1.6 4.6 4.4" />
      <path d="M12.3 12.4c1.7.2 3 1.6 3.4 3.8" />
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
