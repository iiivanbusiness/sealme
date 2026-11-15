export type NavItem = { href: string; label: string };
// collapsible: shown folded under its label until opened (or until the
// page you're on is in it).
export type NavGroup = { label: string; items: NavItem[]; collapsible?: boolean };

// The sidebar: the everyday screens on top (the day, the leads with every
// call, proposal and contract on them, the calendar, the templates they're
// made from), then Workspace, folded until opened: how it's going, the team
// and the settings. Team is for people who assign the work, once there's
// more than one person in the workspace; Admin for platform admins.
const ITEM = {
  dashboard: { href: "/dashboard", label: "Dashboard" },
  leads: { href: "/leads", label: "Leads" },
  calendar: { href: "/calendar", label: "Calendar" },
  templates: { href: "/templates", label: "Templates" },
  analytics: { href: "/analytics", label: "Analytics" },
  team: { href: "/team", label: "Team" },
  feedback: { href: "/feedback", label: "Feedback" },
  settings: { href: "/settings", label: "Settings" },
} satisfies Record<string, NavItem>;
export const ADMIN_ITEM: NavItem = { href: "/admin", label: "Admin" };

// members: active people in the workspace. Someone working alone has no
// one to hand work to, so Team would only be a page about themselves. The
// page stays at /team, and inviting people is in Settings (the setup
// guide's "Invite your team" goes there), so Team turns up once they have.
export function navGroupsFor({ admin, manager = false, members = 1, phone = false }: { admin: boolean; manager?: boolean; members?: number; phone?: boolean }): NavGroup[] {
  const people = [...(manager && members >= 2 ? [ITEM.team] : []), ITEM.settings, ITEM.feedback, ...(admin ? [ADMIN_ITEM] : [])];
  // The iPhone app is for calls and leads: the Dashboard records or uploads
  // a call, Leads has everything that came of them. Templates, the calendar
  // and the analytics stay on the computer (see phone-app.ts).
  if (phone) {
    return [
      { label: "", items: [ITEM.dashboard, ITEM.leads] },
      { label: "Workspace", items: people },
    ];
  }
  return [
    { label: "", items: [ITEM.dashboard, ITEM.leads, ITEM.calendar, ITEM.templates] },
    // Folded until opened (or until you're on one of its pages).
    { label: "Workspace", items: [ITEM.analytics, ...people], collapsible: true },
  ];
}

// The phone's bottom bar: the everyday screens, then "More" for the rest.
const MOBILE_PRIORITY = ["/dashboard", "/leads", "/calendar", "/templates"];
const MOBILE_PRIORITY_PHONE_APP = ["/dashboard", "/leads"];

export function mobilePrimaryItems(groups: NavGroup[], { phone = false }: { phone?: boolean } = {}): NavItem[] {
  const all = groups.flatMap((g) => g.items);
  return (phone ? MOBILE_PRIORITY_PHONE_APP : MOBILE_PRIORITY).map((href) => all.find((i) => i.href === href)).filter((i): i is NavItem => Boolean(i));
}

// The menu item lit up for a page: its own, or the one it belongs under. A
// proposal or contract opens from its lead's call (and a deleted one goes
// to the trash in the Leads menu), so the /deals pages light up Leads.
// Start a call is on the Dashboard.
export function activeNavHref(pathname: string, hrefs: string[]): string | undefined {
  const own = hrefs.find((href) => pathname === href || pathname.startsWith(href + "/"));
  if (own) return own;
  const home = pathname === "/deals/new" ? "/dashboard" : pathname === "/deals" || pathname.startsWith("/deals/") ? "/leads" : null;
  return home && hrefs.includes(home) ? home : undefined;
}

const SCREEN_LABELS: { test: (path: string) => boolean; label: string }[] = [
  { test: (p) => p === "/dashboard", label: "Dashboard" },
  { test: (p) => p === "/today", label: "Today" },
  { test: (p) => p === "/team", label: "Team" },
  { test: (p) => p === "/calls", label: "Calls" },
  { test: (p) => p === "/record", label: "Record" },
  { test: (p) => p === "/deals/new", label: "Start a call" },
  { test: (p) => p === "/deals/trash", label: "Trash" },
  { test: (p) => /^\/deals\/[^/]+\/contract$/.test(p), label: "Review" },
  { test: (p) => /^\/deals\/[^/]+\/send$/.test(p), label: "Send" },
  { test: (p) => /^\/deals\/[^/]+$/.test(p), label: "Details" },
  { test: (p) => p === "/leads/new", label: "New lead" },
  { test: (p) => p === "/leads/import", label: "Import leads" },
  { test: (p) => /^\/leads\/[^/]+$/.test(p), label: "Lead" },
  { test: (p) => p === "/leads", label: "Leads" },
  { test: (p) => p === "/calendar/new", label: "New meeting" },
  { test: (p) => p === "/calendar", label: "Calendar" },
  { test: (p) => p === "/analytics", label: "Analytics" },
  { test: (p) => p === "/templates/new", label: "New template" },
  { test: (p) => p === "/templates/upload", label: "Upload template" },
  { test: (p) => /^\/templates\/[^/]+\/edit$/.test(p), label: "Edit template" },
  { test: (p) => /^\/templates\/[^/]+$/.test(p), label: "Template" },
  { test: (p) => p === "/templates", label: "Templates" },
  { test: (p) => p === "/feedback", label: "Feedback" },
  { test: (p) => p === "/settings", label: "Settings" },
  { test: (p) => p === "/admin", label: "Admin" },
];

export function getScreenLabel(pathname: string): string {
  return SCREEN_LABELS.find((entry) => entry.test(pathname))?.label ?? "SealMe";
}
