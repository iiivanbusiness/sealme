import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { workspaceCampaigns } from "@/lib/campaigns";
import { requireProspecting } from "@/lib/prospecting";
import { isPhoneApp } from "@/lib/phone-app-server";
import { currentUserWithRole } from "@/lib/permissions";
import { leadAccess } from "@/lib/lead-visibility";
import { isPipelineStage, LEAD_TABS, leadTabWhere, PIPELINE_STAGE_CHIP, PIPELINE_STAGE_LABEL, type LeadTab } from "@/lib/lead-pipeline";
import { parseLeadTab, stageFitsTab, tabForStage } from "@/lib/lead-tab-stage";
import { formatPhone } from "@/lib/phone";
import LeadsFilterBar from "@/components/LeadsFilterBar";
import LeadsTable from "@/components/LeadsTable";
import MoreMenu, { type MoreMenuItem } from "@/components/MoreMenu";
import { assignLeadTasks } from "./task-actions";
import { deleteLeads } from "./actions";
import { syncCrmLeadsIfDue } from "@/lib/crm-lead-autosync";
import { cookieTimeZone } from "@/lib/viewer-time";
import { dayLabel } from "@/lib/day-label";
import RefreshWhile from "@/components/RefreshWhile";

// The CRM catch-up below runs after the page is sent, within this budget.
export const maxDuration = 60;

const TAB_LABEL: Record<LeadTab, string> = { active: "Active", clients: "Clients", inactive: "Inactive", all: "All" };

const EMPTY: Record<LeadTab, { title: string; body: string }> = {
  active: { title: "No active leads", body: "Everyone you've talked to in the last 30 days shows here, until they sign or go quiet." },
  clients: { title: "No clients yet", body: "A lead becomes a client when they sign a contract." },
  inactive: { title: "Nothing inactive", body: "Lost leads, contracts that went unsigned and leads with nothing new for 30 days show here." },
  all: { title: "No leads match", body: "Try a different search or clear the filters." },
};

// The first sentence of the last call's summary: enough to remember who
// this is without opening them.
function firstSentence(text: string | null): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const m = t.match(/^.+?[.!?](?=\s|$)/);
  return (m ? m[0] : t).slice(0, 220);
}

// A search that's only digits and phone punctuation also looks at phone
// numbers; "Suite 300" or an email with a year in it doesn't.
function phoneDigits(q: string): string | null {
  const t = q.trim();
  if (!/^[\d\s().+-]+$/.test(t)) return null;
  const digits = t.replace(/[^\d]/g, "");
  return digits.length >= 3 ? digits : null;
}

// The list's own filters, carried from tab to tab. A one-off notice
// (deleted, added) or a guide isn't.
const KEPT = ["q", "stage", "owner", "campaign", "sort"] as const;

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; stage?: string; owner?: string; campaign?: string; sort?: string; deleted?: string; added?: string }>;
}) {
  const workspace = await requireProspecting();
  const user = await currentUserWithRole();
  const params = await searchParams;
  const stage = isPipelineStage(params.stage) ? params.stage : null;

  // A tab's link with the list's own filters. A stage that can't be on that
  // tab (Lost on Active, Client on Inactive) is left off: clicking the tab
  // asks for what's on it, and keeping the stage would only ever show
  // nothing.
  const tabHref = (t: LeadTab) => {
    const next = new URLSearchParams();
    for (const k of KEPT) if (params[k]) next.set(k, params[k]);
    if (!stageFitsTab(stage, t)) next.delete("stage");
    if (t !== "active") next.set("tab", t);
    return next.size ? `/leads?${next.toString()}` : "/leads";
  };

  // A stage picked where it can't be (a typed or old link: the filter bar
  // switches the tab itself) opens on the tab its leads are on, so the
  // filter always shows them.
  const asked = parseLeadTab(params.tab);
  const tab = tabForStage(stage, asked);
  if (tab !== asked) redirect(tabHref(tab));

  // Opening Leads pulls anything new from a connected CRM (when it's due),
  // after the page has gone out so it never slows the page down.
  after(() => syncCrmLeadsIfDue(workspace, { budgetMs: 40_000 }));
  const [access, phone, members, timeZone] = await Promise.all([
    leadAccess(user),
    isPhoneApp(),
    prisma.user.findMany({ where: { workspaceId: workspace.id, deactivatedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    cookieTimeZone(),
  ]);
  const digits = phoneDigits(params.q ?? "");
  // Who it's assigned to only matters on a team: a rep sees their own leads
  // anyway, and someone working alone owns every lead.
  const team = access.canViewAll && members.length >= 2;
  const owner = team ? (params.owner ?? "") : "";
  const { q, campaign } = params;
  const byLastCall = params.sort === "lastcall";
  const now = new Date();

  // AND, not a spread: the visibility rule, the tab and the search are all ORs.
  const base = [
    access.where,
    owner === "mine" ? { ownerId: user.id } : owner === "none" ? { ownerId: null } : owner ? { ownerId: owner } : {},
    campaign ? { campaign } : {},
    q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" as const } },
            { company: { contains: q, mode: "insensitive" as const } },
            { email: { contains: q, mode: "insensitive" as const } },
            ...(digits ? [{ phone: { contains: digits } }] : []),
          ],
        }
      : {},
  ];
  // The stage only where it can be, the same as tabHref: so a tab's count is
  // what clicking it shows.
  const whereFor = (t: LeadTab) => ({
    workspaceId: workspace.id,
    AND: [...base, stage && stageFitsTab(stage, t) ? { pipelineStage: stage } : {}, leadTabWhere(t, now)],
  });

  const [leads, counts, total, campaigns, writing, live] = await Promise.all([
    prisma.lead.findMany({
      where: whereFor(tab),
      select: {
        id: true,
        name: true,
        title: true,
        company: true,
        email: true,
        phone: true,
        pipelineStage: true,
        isClient: true,
        summary: true,
        campaign: true,
        lastActivityAt: true,
        lastContactedAt: true,
        owner: { select: { name: true } },
        _count: { select: { phoneCalls: { where: { status: "processed" } } } },
      },
      orderBy: byLastCall
        ? [{ lastContactedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }]
        : [{ lastActivityAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      take: 500,
    }),
    Promise.all(LEAD_TABS.map((t) => prisma.lead.count({ where: whereFor(t) }))),
    prisma.lead.count({ where: { workspaceId: workspace.id, ...access.where } }),
    workspaceCampaigns(workspace.id),
    // Just started a call with someone new: the list catches up by itself
    // once the call is written up and SealMe knows who it was with. Only a
    // call that moved in the last 15 minutes (a live call's words come in
    // every minute): one left recording by a crashed app would keep the
    // page refreshing for a day.
    params.added
      ? prisma.phoneCall.count({ where: { workspaceId: workspace.id, userId: user.id, status: { in: ["processing", "recording"] }, updatedAt: { gte: new Date(now.getTime() - 15 * 60 * 1000) } } })
      : 0,
    // Leads the desktop app is recording a call with right now, for the
    // "Recording now" mark on their row. Only a call the app sent words for
    // in the last 15 minutes (it does every minute), by the same rule as
    // above. Only rows already on the list are marked, so this needs no
    // visibility rule of its own.
    prisma.phoneCall.findMany({
      where: { workspaceId: workspace.id, source: "desktop", status: "recording", leadId: { not: null }, updatedAt: { gte: new Date(now.getTime() - 15 * 60 * 1000) } },
      select: { leadId: true },
      take: 200,
    }),
  ]);
  const countFor = Object.fromEntries(LEAD_TABS.map((t, i) => [t, counts[i]])) as Record<LeadTab, number>;
  const recordingNow = new Set(live.map((c) => c.leadId));
  const anyRecording = leads.some((lead) => recordingNow.has(lead.id));

  // Adding by hand, bringing in a list and the trash: now-and-then jobs.
  // Importing a spreadsheet, and digging through the trash, are for a computer.
  const more: MoreMenuItem[] = [
    { label: "+ Add lead", href: "/leads/new" },
    ...(phone ? [] : [{ label: "Import a list", href: "/leads/import" }, { label: "Trash", href: "/deals/trash" }]),
  ];
  const empty = total === 0 ? null : EMPTY[q || stage || campaign || owner ? "all" : tab];

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Leads</h1>
          <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
            {/* "The team" only when there's one: someone working alone sees
                their own list. */}
            {team ? "Everyone the team talks to, and where each one stands." : "Everyone you talk to, and where each one stands."}
          </div>
        </div>
        <MoreMenu items={more} label="More lead actions" />
      </div>

      {total > 0 && (
        <nav className="mb-3.5 flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Lead lists">
          {LEAD_TABS.map((t) => (
            <Link
              key={t}
              href={tabHref(t)}
              aria-current={tab === t ? "page" : undefined}
              className="btn btn-sm flex-none gap-1.5"
              style={tab === t ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
            >
              {TAB_LABEL[t]}
              <span className="tabular-nums" style={{ opacity: 0.7 }}>{countFor[t].toLocaleString("en-US")}</span>
            </Link>
          ))}
        </nav>
      )}

      {params.deleted && (
        <div className="chip chip-success mb-3 w-full justify-start px-4 py-2.5 text-[12.5px]" role="status">Lead deleted.</div>
      )}
      {params.added && (
        <div className="chip chip-success mb-3 w-full justify-start whitespace-normal px-4 py-2.5 text-[12.5px]" role="status">
          {writing > 0 ? "Call saved. SealMe is writing it up, and it shows on the lead it was with in a minute or two." : "Call saved. It's on the lead it was with."}
        </div>
      )}
      {/* Keeps up while a call is being written up, or (more slowly) while a
          lead on the list is on a call, so "Recording now" goes once it ends. */}
      {params.added && writing > 0 ? <RefreshWhile everyMs={5000} /> : anyRecording && <RefreshWhile everyMs={15000} />}

      {total > 0 && <LeadsFilterBar owners={team ? members : []} showOwnerFilter={team} campaigns={campaigns} />}

      {total === 0 ? (
        <div className="card flex flex-col items-start gap-3 p-6">
          <div className="text-[14.5px] font-medium">No leads yet</div>
          <div className="max-w-[460px] text-[13px]" style={{ color: "var(--ink-muted)" }}>
            Every call you start lands on a lead. You can also add someone by hand, or bring in a list from a spreadsheet.
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/deals/new" className="btn btn-primary btn-sm">Start a call</Link>
            <Link href="/leads/new" className="btn btn-secondary btn-sm">+ Add lead</Link>
            {!phone && <Link href="/leads/import" className="btn btn-secondary btn-sm">Import a list</Link>}
          </div>
        </div>
      ) : leads.length === 0 && empty ? (
        <div className="card flex flex-col items-start gap-2 p-6">
          <div className="text-[14.5px] font-medium">{empty.title}</div>
          <div className="max-w-[460px] text-[13px]" style={{ color: "var(--ink-muted)" }}>{empty.body}</div>
        </div>
      ) : (
        <>
          <LeadsTable
            // A new list starts with nothing picked: a selection left from
            // another tab or search would act on leads that aren't showing.
            key={[tab, q, stage, owner, campaign, params.sort].join("|")}
            showOwner={team}
            canAssign={access.canAssign}
            assignees={access.canAssign ? members : []}
            assignAction={assignLeadTasks}
            deleteAction={access.canAssign ? deleteLeads : undefined}
            rows={leads.map((lead) => {
              // The date the list is sorted by.
              const last = byLastCall ? lead.lastContactedAt : (lead.lastActivityAt ?? lead.lastContactedAt);
              return {
                id: lead.id,
                name: lead.name,
                company: lead.company,
                campaign: lead.campaign,
                line: firstSentence(lead.summary) || lead.title || lead.email || formatPhone(lead.phone) || "",
                stageLabel: PIPELINE_STAGE_LABEL[lead.pipelineStage] ?? lead.pipelineStage,
                stageChip: PIPELINE_STAGE_CHIP[lead.pipelineStage] ?? "chip-neutral",
                isClient: lead.isClient,
                owner: lead.owner?.name ?? "Unassigned",
                calls: lead._count.phoneCalls,
                recording: recordingNow.has(lead.id),
                lastContact: last ? dayLabel(last, timeZone, now) : null,
              };
            })}
          />
          {leads.length === 500 && (
            <div className="mt-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>Showing the first 500. Search or filter to narrow it down.</div>
          )}
        </>
      )}
    </>
  );
}
