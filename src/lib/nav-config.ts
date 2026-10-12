export type NavItem = { href: string; label: string };
// collapsible: shown folded under its label until opened (or until the
// page you're on is in it).
export type NavGroup = { label: string; items: NavItem[]; collapsible?: boolean };

// The sidebar, in sections by kind of work: the day (Dashboard, Calendar)
// on top, then Prospecting (finding and calling clients), Closing (deals,
// clients and the contracts they're built from), and Workspace (how it's
// going, the team and the settings). Without prospecting there's no
// Prospecting section. Team is for people who assign the work, Admin for
// platform admins.
const ITEM = {
  leads: { href: "/leads", label: "Leads" },
  calls: { href: "/calls", label: "Calls" },
  notes: { href: "/notes", label: "Notes" },
  deals: { href: "/deals", label: "Deals" },
  dashboard: { href: "/dashboard", label: "Dashboard" },
  calendar: { href: "/calendar", label: "Calendar" },
  clients: { href: "/clients", label: "Clients" },
  templates: { href: "/templates", label: "Templates" },
  analytics: { href: "/analytics", label: "Analytics" },
  team: { href: "/team", label: "Team" },
  feedback: { href: "/feedback", label: "Feedback" },
  settings: { href: "/settings", label: "Settings" },
} satisfies Record<string, NavItem>;
export const ADMIN_ITEM: NavItem = { href: "/admin", label: "Admin" };

export function navGroupsFor({ prospecting, admin, manager = false, phone = false }: { prospecting: boolean; admin: boolean; manager?: boolean; phone?: boolean }): NavGroup[] {
  // The Dashboard is the day (a rep's tasks, or the team's for managers),
  // so there's no separate Today.
  const people = [...(prospecting && manager ? [ITEM.team] : []), ITEM.settings, ITEM.feedback, ...(admin ? [ADMIN_ITEM] : [])];
  // The iPhone app is for calls, notes, leads and how it's going (the
  // Dashboard). Contracts, the calendar and the deal analytics stay on the
  // computer (see phone-app.ts).
  if (phone) {
    return [
      { label: "", items: [ITEM.dashboard, ...(prospecting ? [ITEM.notes] : [])] },
      ...(prospecting ? [{ label: "Prospecting", items: [ITEM.leads, ITEM.calls] }] : []),
      { label: "Workspace", items: people },
    ];
  }
  const workspace = [ITEM.analytics, ...people];
  return [
    { label: "", items: [ITEM.dashboard, ITEM.calendar] },
    ...(prospecting ? [{ label: "Prospecting", items: [ITEM.leads, ITEM.calls] }] : []),
    // Notes first: the write-up of a sales meeting, for teams that want
    // only that. It needs leads, so it's there with prospecting.
    { label: "Closing", items: [...(prospecting ? [ITEM.notes] : []), ITEM.deals, ITEM.clients, ITEM.templates] },
    // Folded until opened (or until you're on one of its pages), so the
    // everyday sections fit a laptop screen without scrolling.
    { label: "Workspace", items: workspace, collapsible: true },
  ];
}

// The phone's bottom bar has room for four buttons plus "More". Reps live
// in prospecting on the phone, so those come first when it's on; anything
// not built yet is skipped and the next item fills its spot.
// In the iPhone app, Notes (record or upload a call) comes right after the
// Dashboard.
const MOBILE_PRIORITY_PROSPECTING = ["/dashboard", "/leads", "/calls", "/deals"];
const MOBILE_PRIORITY_DEFAULT = ["/dashboard", "/deals", "/calendar", "/clients"];
const MOBILE_PRIORITY_PHONE_APP = ["/dashboard", "/notes", "/leads", "/calls"];

export function mobilePrimaryItems(groups: NavGroup[], { prospecting, phone = false }: { prospecting: boolean; phone?: boolean }, count = 4): NavItem[] {
  const all = groups.flatMap((g) => g.items);
  const priority = phone ? MOBILE_PRIORITY_PHONE_APP : prospecting ? MOBILE_PRIORITY_PROSPECTING : MOBILE_PRIORITY_DEFAULT;
  const picked = priority.map((href) => all.find((i) => i.href === href)).filter((i): i is NavItem => Boolean(i));
  for (const item of all) if (picked.length < count && !picked.includes(item)) picked.push(item);
  return picked.slice(0, count);
}

const SCREEN_LABELS: { test: (path: string) => boolean; label: string }[] = [
  { test: (p) => p === "/dashboard", label: "Dashboard" },
  { test: (p) => p === "/today", label: "Today" },
  { test: (p) => p === "/team", label: "Team" },
  { test: (p) => p === "/calls", label: "Calls" },
  { test: (p) => p === "/notes", label: "Notes" },
  { test: (p) => p === "/deals/new", label: "Start a call" },
  { test: (p) => /^\/deals\/[^/]+\/contract$/.test(p), label: "Contract review" },
  { test: (p) => /^\/deals\/[^/]+\/send$/.test(p), label: "Send contract" },
  { test: (p) => /^\/deals\/[^/]+$/.test(p), label: "Deal" },
  { test: (p) => p === "/deals", label: "Deals" },
  { test: (p) => p === "/leads/new", label: "New lead" },
  { test: (p) => p === "/leads/import", label: "Import leads" },
  { test: (p) => /^\/leads\/[^/]+$/.test(p), label: "Lead" },
  { test: (p) => p === "/leads", label: "Leads" },
  { test: (p) => p === "/calendar/new", label: "New event" },
  { test: (p) => p === "/calendar", label: "Calendar" },
  { test: (p) => p === "/analytics", label: "Analytics" },
  { test: (p) => p === "/clients", label: "Clients" },
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
