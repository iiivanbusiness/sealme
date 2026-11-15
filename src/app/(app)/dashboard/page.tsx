import { Suspense } from "react";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { isPhoneApp } from "@/lib/phone-app-server";
import { currentUserWithRole } from "@/lib/permissions";
import { leadAccess } from "@/lib/lead-visibility";
import { cookieTimeZone } from "@/lib/viewer-time";
import { isTelnyxConfigured } from "@/lib/telnyx";
import { getStartedSteps, hasCrm } from "@/lib/get-started";
import { dashboardData, guideDeals } from "@/lib/dashboard-data";
import GetStarted from "@/components/dashboard/GetStarted";
import GuideTip from "@/components/GuideTip";
import StartCallCard from "@/components/dashboard/StartCallCard";
import NeedsYou from "@/components/dashboard/NeedsYou";
import WaitingOnAnswer from "@/components/dashboard/WaitingOnAnswer";
import ComingUp from "@/app/(app)/dashboard/coming-up";
import { hideGetStarted } from "./actions";
import { todaySection } from "./today";

// The Dashboard, top to bottom: the day in one sentence, the setup guide
// while it's needed, Start a call, today's meetings (Coming up), what needs
// the viewer (with their to-do list as Reminders), and what's out with
// clients (Waiting on an answer). The day's numbers are on Analytics.
// Whoever hands out work sees the team's to-dos by default, everyone else
// (and anyone alone in the workspace) their own.
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ todo?: string; queue?: string; guide?: string }> }) {
  const now = new Date();
  const [workspaceId, session, user, params, tz, phone] = await Promise.all([requireWorkspaceId(), auth(), currentUserWithRole(), searchParams, cookieTimeZone(), isPhoneApp()]);
  const firstName = session?.user?.name?.trim().split(/\s+/)[0] ?? null;
  const hello = firstName ? `Hello, ${firstName}` : "Dashboard";
  const { canAssign } = await leadAccess(user);

  // The setup guide until every step this person can do is done, or they
  // hide it. "Setup guide" in the menu (?guide=open) brings it back. It
  // stays on the computer, like contracts (see phone-app.ts).
  let getStarted: React.ReactNode = null;
  let phoneInGuide = false;
  if (!phone && (!user.getStartedHiddenAt || params.guide === "open")) {
    const canManageWorkspace = Boolean(user.role?.canManageWorkspace);
    const canManageTeam = Boolean(user.role?.canManageTeam);
    const [deals, crm, teammates, lastCall] = await Promise.all([
      guideDeals(workspaceId, user),
      canManageWorkspace ? prisma.workspace.findUnique({ where: { id: workspaceId }, select: { hubspotAccessToken: true, salesforceRefreshToken: true, ghlAccessToken: true } }) : null,
      canManageTeam ? prisma.user.count({ where: { workspaceId, deactivatedAt: null, id: { not: user.id } } }) : 0,
      prisma.phoneCall.findFirst({ where: { workspaceId, userId: user.id, status: "processed" }, select: { leadId: true }, orderBy: { processedAt: "desc" } }),
    ]);
    const steps = getStartedSteps({
      ...deals,
      hasCall: Boolean(lastCall),
      callLeadId: lastCall?.leadId ?? null,
      phoneCalls: isTelnyxConfigured(),
      hasPhone: Boolean(user.phoneVerifiedAt),
      canManageWorkspace,
      crmConnected: hasCrm(crm),
      canManageTeam,
      hasTeammate: teammates > 0,
    });
    if (steps.some((s) => !s.done)) {
      getStarted = <GetStarted steps={steps} userId={user.id} hideAction={hideGetStarted} />;
      // The guide already asks for the phone number; once is enough.
      phoneInGuide = steps.some((s) => s.id === "phone" && !s.done);
    }
  }

  const [today, data] = await Promise.all([
    todaySection({ workspaceId, me: user, tz, view: params.todo, queue: params.queue === "1", canAssign }),
    dashboardData({ workspaceId, me: user, tz, now, phone }),
  ]);
  const subtitle = `${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz }).format(now)} · ${today.sentence}`;
  const phoneNotice = isTelnyxConfigured() && !user.phoneVerifiedAt && !phoneInGuide;

  const needsYou = (
    <NeedsYou
      data={data.needs}
      phoneNotice={phoneNotice}
      reminders={
        // The setup guide's "Check your reminders" lands here.
        <div id="todo" className="scroll-mt-4">
          <Suspense fallback={null}>
            <GuideTip at="todo" />
          </Suspense>
          {today.block}
        </div>
      }
    />
  );
  const header = (
    <div>
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>{hello}</h1>
      <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>{subtitle}</div>
    </div>
  );

  // The iPhone app: its own Record a meeting and Upload, the day's meetings,
  // and what needs the viewer that a phone can do. Proposals and contracts
  // stay on the computer (see phone-app.ts).
  if (phone) {
    return (
      <>
        <div className="mb-6 flex flex-wrap items-baseline justify-between gap-4">
          {header}
          <div className="flex gap-2.5">
            <Link href="/record" className="btn record-button gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#fff" }} />
              Record a meeting
            </Link>
            <Link href="/deals/new" className="btn btn-secondary">
              Upload
            </Link>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <ComingUp workspaceId={workspaceId} userId={user.id} tz={tz} />
          {needsYou}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="mb-6">{header}</div>
      {getStarted}
      <div className="flex min-w-0 flex-col gap-6">
        <StartCallCard />
        <ComingUp workspaceId={workspaceId} userId={user.id} tz={tz} />
        {needsYou}
        {data.waiting && <WaitingOnAnswer data={data.waiting} />}
      </div>
    </>
  );
}
