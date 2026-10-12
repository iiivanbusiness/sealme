import Link from "next/link";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { workspaceCampaigns } from "@/lib/campaigns";
import { requireProspecting } from "@/lib/prospecting";
import { isPhoneApp } from "@/lib/phone-app-server";
import { currentUserWithRole } from "@/lib/permissions";
import { leadAccess } from "@/lib/lead-visibility";
import { isLeadStage, LEAD_INTEREST_LABEL, LEAD_STAGE_CHIP, LEAD_STAGE_LABEL } from "@/lib/lead-stages";
import { formatPhone } from "@/lib/phone";
import LeadsFilterBar from "@/components/LeadsFilterBar";
import LeadsTable from "@/components/LeadsTable";
import { assignLeadTasks } from "./task-actions";
import { deleteLeads } from "./actions";
import { syncCrmLeadsIfDue } from "@/lib/crm-lead-autosync";

// The CRM catch-up below runs after the page is sent, within this budget.
export const maxDuration = 60;

const TABS = [
  { key: "", label: "All" },
  { key: "mine", label: "Mine" },
  { key: "unassigned", label: "Unassigned" },
] as const;

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// Next-step dates are stored as UTC midnight (see leads/actions.ts), so
// formatting in UTC shows the day that was picked, for every viewer.
function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string; stage?: string; owner?: string; campaign?: string; sort?: string; deleted?: string }>;
}) {
  const workspace = await requireProspecting();
  const user = await currentUserWithRole();
  // Opening Leads pulls anything new from a connected CRM (when it's due),
  // after the page has gone out so it never slows the page down.
  after(() => syncCrmLeadsIfDue(workspace, { budgetMs: 40_000 }));
  const [access, phone] = await Promise.all([leadAccess(user), isPhoneApp()]);
  const params = await searchParams;
  // A rep only ever sees their own leads, so the tabs and owner filter are
  // a manager's view.
  const tab = access.canViewAll ? (params.tab ?? "") : "";
  const { q, stage, owner, campaign } = params;
  // "Last call": the clients talked to most recently first.
  const byLastCall = params.sort === "lastcall";

  // AND, not a spread: the visibility rule and the search are both ORs.
  const where = {
    workspaceId: workspace.id,
    AND: [
      access.where,
      tab === "mine" ? { ownerId: user.id } : tab === "unassigned" ? { ownerId: null } : {},
      stage && isLeadStage(stage) ? { stage } : {},
      owner && tab === "" ? { ownerId: owner } : {},
      campaign ? { campaign } : {},
      q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" as const } },
              { company: { contains: q, mode: "insensitive" as const } },
              { email: { contains: q, mode: "insensitive" as const } },
              { phone: { contains: q.replace(/[^\d+]/g, "") || q } },
            ],
          }
        : {},
    ],
  };

  const [leads, members, total, campaigns] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: {
        id: true,
        name: true,
        title: true,
        company: true,
        email: true,
        phone: true,
        stage: true,
        interest: true,
        nextStep: true,
        nextStepAt: true,
        campaign: true,
        updatedAt: true,
        lastContactedAt: true,
        owner: { select: { name: true } },
        _count: { select: { phoneCalls: { where: { status: "processed" } } } },
      },
      orderBy: byLastCall ? [{ lastContactedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }] : { updatedAt: "desc" },
      take: 500,
    }),
    access.canViewAll || access.canAssign
      ? prisma.user.findMany({ where: { workspaceId: workspace.id, deactivatedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
    prisma.lead.count({ where: { workspaceId: workspace.id, ...access.where } }),
    workspaceCampaigns(workspace.id),
  ]);

  const tabHref = (key: string) => (key ? `/leads?tab=${key}` : "/leads");

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Leads</h1>
          <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
            {total.toLocaleString("en-US")} {total === 1 ? "lead" : "leads"}. {phone ? (access.canViewAll ? "The team's clients and prospects" : "Your clients and prospects") : access.canViewAll ? "Prospects you call before they become deals" : "Your prospects, before they become deals"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Importing a spreadsheet is a job for a computer. */}
          {!phone && (
            <Link href="/leads/import" className="btn btn-secondary">
              Import
            </Link>
          )}
          <Link href="/leads/new" className="btn btn-primary">
            + Add lead
          </Link>
        </div>
      </div>

      {access.canViewAll && (
      <div className="mb-3.5 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={tabHref(t.key)}
            className="btn btn-sm"
            style={tab === t.key ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
          >
            {t.label}
          </Link>
        ))}
      </div>
      )}

      {params.deleted && (
        <div className="chip chip-success mb-3 w-full justify-start px-4 py-2.5 text-[12.5px]" role="status">Lead deleted.</div>
      )}

      <LeadsFilterBar owners={access.canViewAll ? members : []} showOwnerFilter={access.canViewAll && tab === ""} campaigns={campaigns} />

      {leads.length === 0 ? (
        <div className="card flex flex-col items-start gap-3 p-6">
          <div className="text-[14.5px] font-medium">{total === 0 ? "No leads yet" : "No leads match"}</div>
          <div className="text-[13px]" style={{ color: "var(--ink-muted)" }}>
            {total === 0 ? "Add your first lead by hand, or bring in a list from a spreadsheet or CSV." : "Try a different search or clear the filters."}
          </div>
          {total === 0 && (
            <div className="flex flex-wrap gap-2">
              <Link href="/leads/new" className="btn btn-primary btn-sm">
                + Add lead
              </Link>
              <Link href="/leads/import" className="btn btn-secondary btn-sm">
                Import a list
              </Link>
            </div>
          )}
        </div>
      ) : (
        <>
          <LeadsTable
            showOwner={access.canViewAll}
            canAssign={access.canAssign}
            assignees={access.canAssign ? members : []}
            assignAction={assignLeadTasks}
            deleteAction={access.canAssign ? deleteLeads : undefined}
            rows={leads.map((lead) => {
              const next = [lead.nextStepAt ? formatDay(lead.nextStepAt) : null, lead.nextStep].filter(Boolean).join(" · ");
              return {
                id: lead.id,
                name: lead.name,
                subtitle: [lead.campaign, lead.title, lead.company].filter(Boolean).join(" · ") || lead.email || formatPhone(lead.phone) || "",
                secondary: lead.title || lead.email || formatPhone(lead.phone) || "",
                company: lead.company,
                campaign: lead.campaign,
                stageLabel: LEAD_STAGE_LABEL[lead.stage] ?? lead.stage,
                stageChip: LEAD_STAGE_CHIP[lead.stage] ?? "chip-neutral",
                interest: lead.interest ? LEAD_INTEREST_LABEL[lead.interest] : "-",
                owner: lead.owner?.name ?? "Unassigned",
                next,
                updated: timeAgo(lead.updatedAt),
                calls: lead._count.phoneCalls,
                lastCall: lead.lastContactedAt ? lead.lastContactedAt.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null,
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
