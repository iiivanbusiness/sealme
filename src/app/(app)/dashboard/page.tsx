import { Fragment, Suspense } from "react";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseFee } from "@/lib/money";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { STATUS_LABEL, BOARD_COLUMNS } from "@/lib/deal-status";
import GlassStatCard from "@/components/GlassStatCard";
import DealStatusFolders from "@/components/dashboard/DealStatusFolders";
import DealValueHeroCard from "@/components/dashboard/DealValueHeroCard";
import GlowRingStat from "@/components/dashboard/GlowRingStat";
import DashboardGrid from "@/components/dashboard/DashboardGrid";
import { isPhoneApp } from "@/lib/phone-app-server";
import { currentUserWithRole } from "@/lib/permissions";
import { normalizeDashboard } from "@/lib/dashboard-widgets";
import { hideGetStarted, saveDashboardLayout } from "./actions";
import { leadAccess } from "@/lib/lead-visibility";
import { cookieTimeZone } from "@/lib/viewer-time";
import GetStarted from "@/components/dashboard/GetStarted";
import GuideTip from "@/components/GuideTip";
import { getStartedSteps } from "@/lib/get-started";
import { todaySection } from "./today";
import { isTelnyxConfigured } from "@/lib/telnyx";

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatEventDay(date: Date): string {
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return "Today";
  if (sameDay(date, tomorrow)) return "Tomorrow";
  return date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function formatEventTime(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

// Chip-tone map kept local — only used for the Recent deals table below.
const STATUS_CHIP: Record<string, string> = {
  processing: "chip-neutral chip-live",
  missing_info: "chip-warn",
  extraction_failed: "chip-warn",
  ready: "chip-active",
  pending_approval: "chip-neutral",
  changes_requested: "chip-warn",
  sent: "chip-neutral",
  signed: "chip-success",
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ todo?: string; queue?: string; guide?: string }> }) {
  const now = new Date();
  const [workspaceId, session, user] = await Promise.all([requireWorkspaceId(), auth(), currentUserWithRole()]);
  const firstName = session?.user?.name?.trim().split(/\s+/)[0] ?? null;
  const hello = firstName ? `Hello, ${firstName}` : "Dashboard";

  // With prospecting on, the to-do list and the day's numbers sit above
  // the widgets: whoever hands out work sees the team's day by default,
  // everyone else their own.
  const prospecting = (await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { prospectingEnabled: true } }))?.prospectingEnabled ?? false;
  const canAssign = prospecting ? (await leadAccess(user)).canAssign : false;
  const tz = prospecting ? await cookieTimeZone() : "UTC";
  let subtitle = "Everything happening across your workspace";

  // The iPhone app: how the day is going and the to-do list. Contracts and
  // the setup guide stay on the computer (see phone-app.ts).
  if (await isPhoneApp()) {
    const params = await searchParams;
    const today = prospecting
      ? await todaySection({ workspaceId, me: user, tz, view: params.todo, queue: params.queue === "1", canAssign, phoneInGuide: false, phone: true })
      : null;
    if (today) subtitle = `${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(now)} · ${today.sentence}`;
    return (
      <>
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>{hello}</h1>
            <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>{subtitle}</div>
          </div>
          {prospecting && (
            <div className="flex gap-2.5">
              <Link href="/record" className="btn record-button gap-2">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#fff" }} />
                Record a meeting
              </Link>
              <Link href="/notes" className="btn btn-secondary">
                Upload
              </Link>
            </div>
          )}
        </div>
        {today && <div id="todo">{today.block}</div>}
      </>
    );
  }

  const { where: visibility } = await dealVisibilityFilter();

  const in90Days = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
  const staleCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [deals, clientCount, upcomingEvents, renewalsAtRisk, staleDeals] = await Promise.all([
    // Only the columns this page shows: a full Deal row carries the whole
    // call transcript, and this runs over every deal on each dashboard load.
    prisma.deal.findMany({
      where: { workspaceId, ...visibility },
      select: { id: true, status: true, service: true, feeDisplay: true, createdAt: true, updatedAt: true, client: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.client.count({ where: { workspaceId } }),
    prisma.calendarEvent.findMany({ where: { workspaceId, startTime: { gte: now } }, orderBy: { startTime: "asc" }, take: 10 }),
    prisma.contract.findMany({
      where: { status: "signed", renewalDate: { gte: now, lte: in90Days }, deal: { workspaceId, ...visibility } },
      select: { id: true, dealId: true, autoRenews: true, renewalDate: true, deal: { select: { feeDisplay: true, client: { select: { name: true } } } } },
      orderBy: { renewalDate: "asc" },
    }),
    prisma.deal.findMany({
      where: { workspaceId, status: { in: ["ready", "missing_info"] }, updatedAt: { lte: staleCutoff }, ...visibility },
      select: { id: true, status: true, updatedAt: true, client: { select: { name: true } } },
      orderBy: { updatedAt: "asc" },
    }),
  ]);

  const revenueAtRisk = renewalsAtRisk.reduce((sum, c) => sum + parseFee(c.deal.feeDisplay), 0);
  // Widgets can be made taller now, and their lists scroll, so they carry
  // more rows than the five that used to fit.
  const upcomingRenewals = renewalsAtRisk.slice(0, 15);

  const signedCount = deals.filter((d) => d.status === "signed").length;
  const combinedValue = deals.reduce((sum, d) => sum + parseFee(d.feeDisplay), 0);
  const newClientsThisMonth = deals.filter(
    (d) => d.createdAt.getMonth() === now.getMonth() && d.createdAt.getFullYear() === now.getFullYear()
  ).length;

  const months: { key: string; label: string; value: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: "short" }), value: 0 });
  }
  for (const deal of deals) {
    const key = `${deal.createdAt.getFullYear()}-${deal.createdAt.getMonth()}`;
    const bucket = months.find((m) => m.key === key);
    if (bucket) bucket.value += parseFee(deal.feeDisplay);
  }
  const maxMonthValue = Math.max(...months.map((m) => m.value), 1);
  const currentMonthKey = `${now.getFullYear()}-${now.getMonth()}`;
  const signedRate = deals.length > 0 ? Math.round((signedCount / deals.length) * 100) : 0;
  const newClientsPct = clientCount > 0 ? Math.round((newClientsThisMonth / clientCount) * 100) : 0;

  const recentDeals = deals.slice(0, 15);

  // The setup guide until every step this person can do is done, or they
  // hide it. "Setup guide" in the menu (?guide=open) brings it back.
  let getStarted: React.ReactNode = null;
  let phoneInGuide = false;
  const reopened = (await searchParams).guide === "open";
  if (!user.getStartedHiddenAt || reopened) {
    const canManageWorkspace = Boolean(user.role?.canManageWorkspace);
    const canManageTeam = Boolean(user.role?.canManageTeam);
    const [crm, teammates, lastCall] = await Promise.all([
      canManageWorkspace ? prisma.workspace.findUnique({ where: { id: workspaceId }, select: { hubspotAccessToken: true, salesforceRefreshToken: true } }) : null,
      canManageTeam ? prisma.user.count({ where: { workspaceId, deactivatedAt: null, id: { not: user.id } } }) : 0,
      prospecting
        ? prisma.phoneCall.findFirst({ where: { workspaceId, userId: user.id, status: "processed" }, select: { leadId: true }, orderBy: { processedAt: "desc" } })
        : null,
    ]);
    const steps = getStartedSteps({
      hasDeal: deals.length > 0,
      hasSentContract: deals.some((d) => d.status === "sent" || d.status === "signed"),
      readyDealId: deals.find((d) => d.status === "ready" || d.status === "pending_approval" || d.status === "changes_requested")?.id ?? null,
      prospecting,
      hasCall: Boolean(lastCall),
      callLeadId: lastCall?.leadId ?? null,
      phoneCalls: isTelnyxConfigured(),
      hasPhone: Boolean(user.phoneVerifiedAt),
      canManageWorkspace,
      crmConnected: Boolean(crm?.hubspotAccessToken || crm?.salesforceRefreshToken),
      canManageTeam,
      hasTeammate: teammates > 0,
    });
    if (steps.some((s) => !s.done)) {
      getStarted = <GetStarted steps={steps} hideAction={hideGetStarted} />;
      // The guide already asks for the phone number; once is enough.
      phoneInGuide = steps.some((s) => s.id === "phone" && !s.done);
    }
  }

  let todayBlock: React.ReactNode = null;
  if (prospecting) {
    const params = await searchParams;
    const today = await todaySection({ workspaceId, me: user, tz, view: params.todo, queue: params.queue === "1", canAssign, phoneInGuide });
    subtitle = `${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(now)} · ${today.sentence}`;
    todayBlock = today.block;
  }

  // Folders-by-status — reuses the `deals` array already fetched above
  // (dealVisibilityFilter already applied to it), no new query. Always all
  // 8 statuses, in canonical order, so a status with zero deals still
  // renders (dimmed) rather than silently disappearing from the grid.
  const statusCounts = new Map<string, number>();
  for (const col of BOARD_COLUMNS) statusCounts.set(col, 0);
  for (const deal of deals) statusCounts.set(deal.status, (statusCounts.get(deal.status) ?? 0) + 1);
  const statusFolderCounts = BOARD_COLUMNS.map((status) => ({ status, count: statusCounts.get(status) ?? 0 }));


  // Shared frame for the list widgets: fills its grid cell, list scrolls.
  const listCard = (title: string, extra: React.ReactNode, body: React.ReactNode) => (
    <div className="glass-card glass-card-solid card-hover flex h-full flex-col p-5">
      <div className="mb-4 flex flex-none items-center justify-between gap-3">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {extra}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
  const dayChip = (text: string) => (
    <div className="font-mono-tab flex w-[64px] flex-none flex-col items-start rounded-[8px] px-2 py-1 text-[11.5px] font-medium" style={{ background: "var(--surface-2)" }}>
      {text}
    </div>
  );
  const empty = (text: string) => (
    <div className="py-6 text-center text-[13px]" style={{ color: "var(--ink-muted)" }}>
      {text}
    </div>
  );

  const widgets: Record<string, React.ReactNode> = {
    "stat-value": <GlassStatCard className="h-full" label="Combined deal value" value={`$${combinedValue.toLocaleString()}`} sub="Across all deals" />,
    "stat-active": <GlassStatCard className="h-full" label="Active deals" value={String(deals.length)} sub={`${newClientsThisMonth} started this month`} />,
    "stat-signed": <GlassStatCard className="h-full" label="Contracts signed" value={String(signedCount)} sub={`of ${deals.length} deals`} />,
    "stat-clients": <GlassStatCard className="h-full" label="Clients" value={String(clientCount)} sub="Total on file" />,
    "stat-renewals": (
      <GlassStatCard
        className="h-full"
        label="Renewals at risk"
        value={String(renewalsAtRisk.length)}
        sub={renewalsAtRisk.length > 0 ? `$${revenueAtRisk.toLocaleString()} in 90 days` : "None in the next 90 days"}
      />
    ),
    "stat-stuck": <GlassStatCard className="h-full" label="Stuck deals" value={String(staleDeals.length)} sub={staleDeals.length > 0 ? "Untouched 7+ days" : "Nothing sitting idle"} />,
    "status-folders": (
      <div className="glass-card glass-card-solid flex h-full flex-col p-5">
        <h2 className="mb-3 flex-none text-[13px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
          Deals by status
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <DealStatusFolders counts={statusFolderCounts} />
        </div>
      </div>
    ),
    "deal-value": (
      <DealValueHeroCard months={months} maxMonthValue={maxMonthValue} currentMonthKey={currentMonthKey} signedRate={signedRate} signedCount={signedCount} dealCount={deals.length} />
    ),
    "upcoming-calls": listCard(
      "Upcoming calls",
      <Link href="/calendar" className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
        View all
      </Link>,
      upcomingEvents.length === 0 ? (
        empty("Nothing scheduled yet.")
      ) : (
        <div className="flex flex-col gap-1">
          {upcomingEvents.map((event) => (
            <div key={event.id} className="flex items-center gap-3 border-t py-2.5 first:border-t-0" style={{ borderColor: "var(--hairline-soft)" }}>
              {dayChip(formatEventDay(event.startTime))}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{event.title}</div>
                <div className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
                  {formatEventTime(event.startTime)} · {event.clientName ?? "No client"}
                </div>
              </div>
            </div>
          ))}
        </div>
      ),
    ),
    "upcoming-renewals": listCard(
      "Upcoming renewals",
      renewalsAtRisk.length > 0 && (
        <span className="chip chip-warn flex-none" style={{ fontSize: 11 }}>
          ${revenueAtRisk.toLocaleString()} in 90 days
        </span>
      ),
      upcomingRenewals.length === 0 ? (
        empty("No contracts renewing soon.")
      ) : (
        <div className="flex flex-col gap-1">
          {upcomingRenewals.map((contract) => (
            <Link key={contract.id} href={`/deals/${contract.dealId}/contract`} className="flex items-center gap-3 border-t py-2.5 first:border-t-0" style={{ borderColor: "var(--hairline-soft)", color: "inherit" }}>
              {dayChip(`${daysUntil(contract.renewalDate as Date)}d`)}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{contract.deal.client.name}</div>
                <div className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
                  {contract.autoRenews ? "Auto-renews" : "Term ends"} {(contract.renewalDate as Date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </div>
              </div>
            </Link>
          ))}
          {renewalsAtRisk.length > upcomingRenewals.length && (
            <div className="pt-2 text-center text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
              +{renewalsAtRisk.length - upcomingRenewals.length} more in the next 90 days
            </div>
          )}
        </div>
      ),
    ),
    "stuck-deals": listCard(
      "Stuck deals",
      staleDeals.length > 0 && (
        <span className="chip chip-warn flex-none" style={{ fontSize: 11 }}>
          {staleDeals.length} untouched 7+ days
        </span>
      ),
      staleDeals.length === 0 ? (
        empty("Nothing sitting idle. Nice.")
      ) : (
        <div className="flex flex-col gap-1">
          {staleDeals.slice(0, 15).map((deal) => (
            <Link key={deal.id} href={`/deals/${deal.id}`} className="flex items-center gap-3 border-t py-2.5 first:border-t-0" style={{ borderColor: "var(--hairline-soft)", color: "inherit" }}>
              {dayChip(timeAgo(deal.updatedAt))}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{deal.client.name}</div>
                <div className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
                  {STATUS_LABEL[deal.status] ?? deal.status}
                </div>
              </div>
            </Link>
          ))}
          {staleDeals.length > 15 && (
            <div className="pt-2 text-center text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
              +{staleDeals.length - 15} more
            </div>
          )}
        </div>
      ),
    ),
    "this-month": (
      <div className="flex h-full flex-col gap-3">
        <h2 className="flex-none text-[15px] font-medium">This month</h2>
        <GlowRingStat pct={signedRate} value={`${signedRate}%`} label="Signed rate" />
        <GlowRingStat pct={newClientsPct} value={String(newClientsThisMonth)} label="New clients this month" />
      </div>
    ),
    "recent-deals": (
      <div className="glass-card glass-card-solid card-hover flex h-full flex-col overflow-hidden">
        <div className="flex flex-none items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Recent deals</h2>
          <Link href="/deals" className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
            View all
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {["Client", "Value", "Status", "Updated"].map((h) => (
                  <th key={h} className="border-b px-5 py-3 text-left text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentDeals.map((deal) => (
                <tr key={deal.id} className="row-hover transition-colors">
                  <td className="border-b px-5 py-3.5" style={{ borderColor: "var(--hairline-soft)" }}>
                    <Link href={`/deals/${deal.id}`} className="flex flex-col gap-0.5" style={{ color: "inherit" }}>
                      <span className="font-medium" style={{ color: "var(--ink)" }}>{deal.client.name}</span>
                      <span className="text-[13px]" style={{ color: "var(--ink-muted)" }}>{deal.service}</span>
                    </Link>
                  </td>
                  <td className="font-mono-tab border-b px-5 py-3.5 font-medium" style={{ borderColor: "var(--hairline-soft)", color: "var(--ink)" }}>
                    {deal.feeDisplay}
                  </td>
                  <td className="border-b px-5 py-3.5" style={{ borderColor: "var(--hairline-soft)" }}>
                    <span className={`chip ${STATUS_CHIP[deal.status] ?? "chip-neutral"}`}>
                      <span className="chip-dot" />
                      {STATUS_LABEL[deal.status] ?? deal.status}
                    </span>
                  </td>
                  <td className="border-b px-5 py-3.5 text-[13px]" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline-soft)" }}>
                    {timeAgo(deal.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ),
  };

  return (
    <>
    <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
      <div>
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>
          {hello}
        </h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
          {subtitle}
        </div>
      </div>
      <div className="flex gap-2.5">
        <a href="https://meet.google.com" target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm not-on-phone-app">
          Google Meet
        </a>
        <a href="https://zoom.us" target="_blank" rel="noreferrer" className="btn btn-secondary btn-sm not-on-phone-app">
          Zoom
        </a>
        <Link href="/deals/new" className="btn btn-primary">
          + Start a call
        </Link>
      </div>
    </div>

    {getStarted}

    {/* The setup guide's "Check your to-do list" lands here. */}
    {todayBlock && (
      <div id="todo" className="scroll-mt-4">
        <Suspense fallback={null}>
          <GuideTip at="todo" />
        </Suspense>
        {todayBlock}
      </div>
    )}

    {/* Keyed, since the grid puts each one in a list next to its resize handle. */}
    <DashboardGrid
      widgets={Object.fromEntries(Object.entries(widgets).map(([id, w]) => [id, <Fragment key={id}>{w}</Fragment>]))}
      saved={normalizeDashboard(user.dashboardLayout)}
      saveAction={saveDashboardLayout}
    />
    </>
  );
}
