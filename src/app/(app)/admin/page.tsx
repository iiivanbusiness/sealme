import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { formatMinutes, formatUsd, NO_USAGE, totalUsage, usageBy } from "@/lib/admin-usage";
import { isTestEmail, NOT_TEST_EMAIL } from "@/lib/test-emails";
import { applyPlanChange, dismissUpgradeRequest } from "./actions";

function startOfMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// Someone who joined in the last two days is flagged as new.
function isRecent(date: Date): boolean {
  return Date.now() - date.getTime() < 2 * 24 * 60 * 60 * 1000;
}

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

// The admin tables have to fit beside the sidebar at any window width,
// not just full screen: lower-priority columns drop out as the window
// narrows instead of pushing the table off the edge.
// When someone signed up is in New sign-ups, so it isn't repeated here.
const COLUMN_SHOW = {
  owner: "hidden lg:table-cell",
  plan: "hidden 2xl:table-cell",
  minutes: "hidden xl:table-cell",
  cost: "hidden lg:table-cell",
  deals: "hidden xl:table-cell",
  lastActivity: "hidden 2xl:table-cell",
};

const WORKSPACE_COLUMNS = [
  { label: "Workspace", show: "" },
  { label: "Owner", show: COLUMN_SHOW.owner },
  { label: "Plan", show: COLUMN_SHOW.plan },
  { label: "Calls written up", show: "" },
  { label: "Minutes", show: COLUMN_SHOW.minutes },
  { label: "Cost", show: COLUMN_SHOW.cost },
  { label: "Deals", show: COLUMN_SHOW.deals },
  { label: "Last activity", show: COLUMN_SHOW.lastActivity },
];

// New sign-ups: who joined, how, whether they came back, and what they've used.
const SIGNUP_SHOW = {
  workspace: "hidden xl:table-cell",
  how: "hidden 2xl:table-cell",
  lastIn: "hidden xl:table-cell",
  minutes: "hidden lg:table-cell",
  cost: "hidden xl:table-cell",
};

const SIGNUP_COLUMNS = [
  { label: "Person", show: "" },
  { label: "Workspace", show: SIGNUP_SHOW.workspace },
  { label: "Joined", show: "" },
  { label: "How", show: SIGNUP_SHOW.how },
  { label: "Last sign-in", show: SIGNUP_SHOW.lastIn },
  { label: "Calls written up", show: "" },
  { label: "Minutes", show: SIGNUP_SHOW.minutes },
  { label: "Cost", show: SIGNUP_SHOW.cost },
];

const SIGNUPS_SHOWN = 50;

const PROFILE_SHOW = {
  role: "hidden lg:table-cell",
  calls: "hidden xl:table-cell",
  handoff: "hidden xl:table-cell",
  signedUp: "hidden md:table-cell",
};

const PROFILE_COLUMNS = [
  { label: "Workspace", show: "" },
  { label: "Role", show: PROFILE_SHOW.role },
  { label: "Calls / month", show: PROFILE_SHOW.calls },
  { label: 'After a "yes"', show: PROFILE_SHOW.handoff },
  { label: "Biggest problem", show: "" },
  { label: "Signed up", show: PROFILE_SHOW.signedUp },
];

const AUDIT_SHOW = {
  workspace: "hidden xl:table-cell",
  actor: "hidden lg:table-cell",
  details: "hidden lg:table-cell",
};

const AUDIT_COLUMNS = [
  { label: "When", show: "" },
  { label: "Workspace", show: AUDIT_SHOW.workspace },
  { label: "Actor", show: AUDIT_SHOW.actor },
  { label: "Event", show: "" },
  { label: "Details", show: AUDIT_SHOW.details },
];

// One short label for every action logAudit records (grep logAudit( to
// check). Anything missing shows its raw name.
const AUDIT_ACTION_LABEL: Record<string, string> = {
  "login.success": "Signed in",
  "login.failure": "Failed sign-in",
  "login.rate_limited": "Sign-in rate-limited",
  "password.reset": "Password reset",
  "2fa.enabled": "2FA turned on",
  "2fa.disabled": "2FA turned off",
  "2fa.backup_codes_regenerated": "New 2FA backup codes",
  "account.self_deleted": "Account deleted",
  "account.unverified_password_removed": "Unverified password removed",
  "workspace.created": "Workspace created",
  "workspace.domain_verified": "Domain verified",
  "workspace.domain_restriction_updated": "Domain restriction changed",
  "workspace.sso_enabled": "SSO turned on",
  "workspace.sso_disabled": "SSO turned off",
  "workspace.sso_config_updated": "SSO settings changed",
  "workspace.scim_token_generated": "SCIM token made",
  "workspace.scim_token_revoked": "SCIM token revoked",
  "teammate.invited": "Teammate invited",
  "teammate.joined": "Teammate joined",
  "teammate.removed": "Teammate removed",
  "teammate.sso_provisioned": "Teammate added by SSO",
  "team.created": "Team created",
  "team.deleted": "Team deleted",
  "team.member_assigned": "Moved to a team",
  "role.created": "Role created",
  "role.updated": "Role changed",
  "role.deleted": "Role deleted",
  "role.assigned": "Role assigned",
  "review_chain.created": "Review chain created",
  "review_chain.deleted": "Review chain deleted",
  "review_chain_step.added": "Review step added",
  "review_chain_step.removed": "Review step removed",
  "approval_delegate.created": "Approvals delegated",
  "approval_delegate.revoked": "Delegation ended",
  "proposal.sent": "Proposal sent",
  "proposal.reminder_sent": "Proposal reminder sent",
  "proposal.reminder_link_copied": "Reminder link copied",
  "proposal.link_shared": "Proposal link shared",
  "proposal.link_updated": "Proposal link updated",
  "deal.contract_from_proposal": "Contract from proposal",
  "deal.renewal_started": "Renewal started",
  "deal.restored": "Restored from trash",
  "deals.trash_emptied": "Trash emptied",
  "deal.local_capture_transcribed": "Desktop recording transcribed",
  "call.local_capture_transcribed": "Desktop recording transcribed",
  "call.deleted": "Call deleted",
  "lead.deleted": "Lead deleted",
  "client.updated": "Client edited",
  "template.locked": "Template locked",
  "template.unlocked": "Template unlocked",
  "contract.sent": "Contract sent",
  "contract.sent_for_review": "Sent for review",
  "contract.approval_requested": "Approval requested",
  "contract.approval_approved": "Approved",
  "contract.approval_rejected": "Approval rejected",
  "contract.clause_change_requested": "Client asked for changes",
  "contract.client_signed": "Client signed",
  "contract.countersigned": "Counter-signed",
  "contract.countersign_declined": "Counter-sign declined",
  "contract.signed": "Contract signed",
  "contract.marked_not_signed": "Marked not signed",
  "contract.expired": "Contract expired",
  "contract.docusign_declined": "Declined in DocuSign",
  "contract.docusign_voided": "Voided in DocuSign",
  "api_key.created": "API key created",
  "api_key.revoked": "API key revoked",
  "webhook.created": "Webhook added",
  "webhook.deleted": "Webhook removed",
  "sandbox.reset": "Sandbox reset",
  "sandbox.deleted": "Sandbox deleted",
  "data.bulk_imported": "Data imported",
  "hubspot.connected": "HubSpot connected",
  "hubspot.disconnected": "HubSpot disconnected",
  "hubspot.deal_stages.saved": "HubSpot deal stages set",
  "hubspot.deal_stages.off": "HubSpot deal stages off",
  "hubspot.lead_import.on": "HubSpot lead import on",
  "hubspot.lead_import.off": "HubSpot lead import off",
  "hubspot.webhook_secret.saved": "HubSpot secret saved",
  "hubspot.webhook_secret.cleared": "HubSpot secret cleared",
  "salesforce.connected": "Salesforce connected",
  "salesforce.disconnected": "Salesforce disconnected",
  "salesforce.lead_import.on": "Salesforce lead import on",
  "salesforce.lead_import.off": "Salesforce lead import off",
  "salesforce.webhook_key.created": "Salesforce key made",
  "salesforce.webhook_key.removed": "Salesforce key removed",
  "gohighlevel.connected": "GoHighLevel connected",
  "gohighlevel.disconnected": "GoHighLevel disconnected",
  "docusign.connected": "DocuSign connected",
  "docusign.disconnected": "DocuSign disconnected",
  "slack.connected": "Slack connected",
  "slack.disconnected": "Slack disconnected",
  "slack.channel_set": "Slack channel set",
  "admin.plan_changed": "Plan changed",
};

const AUDIT_ACTION_CHIP: Record<string, string> = {
  "login.failure": "chip-warn",
  "login.rate_limited": "chip-warn",
  "contract.signed": "chip-success",
  "contract.marked_not_signed": "chip-warn",
  "contract.expired": "chip-warn",
  "workspace.created": "chip-success",
};

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
        {label}
      </div>
      <div className="font-mono-tab mt-2 text-[26px] font-medium">{value}</div>
      {sub && <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>{sub}</div>}
    </div>
  );
}

export default async function AdminPage() {
  await requireAdmin();

  const monthStart = startOfMonth();
  const [workspaces, pendingRequests, onboardingProfiles, auditLogs, newUsers, byWorkspace, byWorkspaceMonth, byUser] = await Promise.all([
    // Sandboxes belong to a customer's workspace; they aren't customers.
    prisma.workspace.findMany({
      where: { sandboxOfId: null },
      include: { users: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.upgradeRequest.findMany({
      where: { status: "pending" },
      include: { workspace: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.onboardingProfile.findMany({
      include: { workspace: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.auditLog.findMany({
      include: { workspace: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.user.findMany({
      where: { workspace: { sandboxOfId: null }, NOT: NOT_TEST_EMAIL },
      select: { id: true, name: true, email: true, createdAt: true, workspaceId: true, workspace: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: SIGNUPS_SHOWN,
    }),
    usageBy("workspaceId"),
    usageBy("workspaceId", monthStart),
    usageBy("userId"),
  ]);

  // Whether someone started their workspace (its first person) or was invited.
  const founderOf = new Map(
    workspaces.map((w) => [w.id, [...w.users].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]?.id ?? null]),
  );
  const lastSignIns = await prisma.auditLog.groupBy({
    by: ["actorEmail"],
    where: { action: "login.success", actorEmail: { in: newUsers.map((u) => u.email) } },
    _max: { createdAt: true },
  });
  const lastSignIn = new Map(lastSignIns.map((r) => [r.actorEmail, r._max.createdAt]));
  const usageAll = totalUsage(byWorkspace);
  const usageMonth = totalUsage(byWorkspaceMonth);

  const activity = await Promise.all(
    workspaces.map((w) =>
      prisma.deal.aggregate({ where: { workspaceId: w.id }, _max: { updatedAt: true }, _count: true })
    )
  );

  const totalUsers = workspaces.reduce((sum, w) => sum + w.users.filter((u) => !isTestEmail(u.email)).length, 0);
  const totalDeals = activity.reduce((sum, a) => sum + a._count, 0);
  const totalCallsUsed = workspaces.reduce((sum, w) => sum + w.callsUsedThisMonth, 0);

  return (
    <>
    <div className="mb-6">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Admin</h1>
      <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
        Platform-wide view across every workspace
      </div>
    </div>

    <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      <StatCard label="Workspaces" value={String(workspaces.length)} sub={`${totalDeals.toLocaleString("en-US")} deals, ${totalCallsUsed} calls used this month`} />
      <StatCard label="Signed-up users" value={String(totalUsers)} sub={`${newUsers.filter((u) => isRecent(u.createdAt)).length} in the last 2 days`} />
      <StatCard label="Calls written up" value={usageAll.calls.toLocaleString("en-US")} sub={`${usageMonth.calls.toLocaleString("en-US")} this month`} />
      <StatCard label="Minutes transcribed" value={formatMinutes(usageAll.sttSeconds)} sub={`${formatMinutes(usageMonth.sttSeconds)} this month`} />
      <StatCard label="Usage cost" value={formatUsd(usageAll.costUsd)} sub={`${formatUsd(usageMonth.costUsd)} this month`} />
    </div>

    <div className="card mb-6 overflow-hidden">
      <div className="border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">New sign-ups</h2>
        <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          Newest first, with what each person has used: calls written up into notes, minutes transcribed, and what it cost. Last {SIGNUPS_SHOWN}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {SIGNUP_COLUMNS.map((col) => (
                <th
                  key={col.label}
                  className={`whitespace-nowrap border-b px-4 py-3 text-left text-[12px] font-medium uppercase tracking-wide ${col.show}`}
                  style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {newUsers.map((u) => {
              const used = byUser.get(u.id) ?? NO_USAGE;
              const signedIn = lastSignIn.get(u.email);
              const cell = "border-b px-4 py-3.5 text-[13px]";
              const border = { borderColor: "var(--hairline-soft)" };
              const muted = { ...border, color: "var(--ink-muted)" };
              return (
                <tr key={u.id} className="row-hover transition-colors">
                  <td className={cell} style={border}>
                    <div className="max-w-[180px] truncate font-medium" title={u.name}>{u.name}</div>
                    <div className="max-w-[180px] truncate text-[12px]" style={{ color: "var(--ink-muted)" }} title={u.email}>{u.email}</div>
                  </td>
                  <td className={`${cell} ${SIGNUP_SHOW.workspace}`} style={muted}>
                    <div className="max-w-[160px] truncate" title={u.workspace.name}>{u.workspace.name}</div>
                  </td>
                  <td className={`whitespace-nowrap ${cell}`} style={muted}>
                    {isRecent(u.createdAt) && <span className="chip chip-success mr-1.5">New</span>}
                    <span title={u.createdAt.toISOString()}>{u.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
                  </td>
                  <td className={`whitespace-nowrap ${cell} ${SIGNUP_SHOW.how}`} style={muted}>
                    {founderOf.get(u.workspaceId) === u.id ? "Started a workspace" : "Invited"}
                  </td>
                  <td className={`whitespace-nowrap ${cell} ${SIGNUP_SHOW.lastIn}`} style={muted}>
                    {signedIn ? timeAgo(signedIn) : "-"}
                  </td>
                  <td className={`font-mono-tab ${cell}`} style={border}>{used.calls}</td>
                  <td className={`font-mono-tab ${cell} ${SIGNUP_SHOW.minutes}`} style={border}>{formatMinutes(used.sttSeconds)}</td>
                  <td className={`font-mono-tab ${cell} ${SIGNUP_SHOW.cost}`} style={border}>{formatUsd(used.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>

    {pendingRequests.length > 0 && (
      <div className="mb-6">
        <h2 className="mb-2.5 text-[15px] font-medium">Upgrade requests</h2>
        <div className="flex flex-col gap-3">
          {pendingRequests.map((req) => (
            <div key={req.id} className="card flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="text-[13.5px] font-medium">{req.workspace.name}</div>
                {req.note && (
                  <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
                    &ldquo;{req.note}&rdquo;
                  </div>
                )}
                <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
                  Requested {timeAgo(req.createdAt)}. Currently {req.workspace.plan}, {req.workspace.callsUsedThisMonth} of {req.workspace.callsLimit} calls
                </div>
              </div>
              <form action={applyPlanChange.bind(null, req.workspaceId, req.id)} className="flex flex-none flex-wrap items-center gap-2">
                <input name="plan" defaultValue={req.workspace.plan} className="input" style={{ width: 110, fontSize: 13, padding: "7px 10px" }} />
                <input name="callsLimit" type="number" min={1} defaultValue={req.workspace.callsLimit} className="input" style={{ width: 80, fontSize: 13, padding: "7px 10px" }} />
                <button type="submit" className="btn btn-primary btn-sm">Apply</button>
              </form>
              <form action={dismissUpgradeRequest.bind(null, req.id)}>
                <button type="submit" className="text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>
                  Dismiss
                </button>
              </form>
            </div>
          ))}
        </div>
      </div>
    )}

    {onboardingProfiles.length > 0 && (
      <div className="card mb-6 overflow-hidden">
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Client profiles</h2>
          <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            Onboarding answers. Raw material for figuring out who your ideal customer actually is
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {PROFILE_COLUMNS.map((col) => (
                  <th
                    key={col.label}
                    className={`whitespace-nowrap border-b px-4 py-3 text-left text-[12px] font-medium uppercase tracking-wide ${col.show}`}
                    style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {onboardingProfiles.map((p) => (
                <tr key={p.id} className="row-hover transition-colors">
                  <td className="border-b px-4 py-3.5 font-medium" style={{ borderColor: "var(--hairline-soft)" }}>
                    <div className="max-w-[160px] truncate" title={p.workspace.name}>{p.workspace.name}</div>
                  </td>
                  <td className={`border-b px-4 py-3.5 text-[13px] ${PROFILE_SHOW.role}`} style={{ borderColor: "var(--hairline-soft)" }}>{p.role}</td>
                  <td className={`border-b px-4 py-3.5 text-[13px] ${PROFILE_SHOW.calls}`} style={{ borderColor: "var(--hairline-soft)" }}>{p.callVolume}</td>
                  <td className={`border-b px-4 py-3.5 text-[13px] ${PROFILE_SHOW.handoff}`} style={{ borderColor: "var(--hairline-soft)" }}>{p.handoff}</td>
                  <td className="border-b px-4 py-3.5 text-[13px]" style={{ borderColor: "var(--hairline-soft)" }}>{p.biggestProblem}</td>
                  <td className={`whitespace-nowrap border-b px-4 py-3.5 text-[13px] ${PROFILE_SHOW.signedUp}`} style={{ borderColor: "var(--hairline-soft)", color: "var(--ink-muted)" }}>
                    {timeAgo(p.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}

    <div className="card overflow-hidden">
      <div className="border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">Workspaces</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {WORKSPACE_COLUMNS.map((col) => (
                <th
                  key={col.label}
                  className={`whitespace-nowrap border-b px-4 py-3 text-left text-[12px] font-medium uppercase tracking-wide ${col.show}`}
                  style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {workspaces.map((w, i) => {
              const stats = activity[i];
              const cell = "border-b px-4 py-3.5 text-[13px]";
              const border = { borderColor: "var(--hairline-soft)" };
              const muted = { ...border, color: "var(--ink-muted)" };
              return (
                <tr key={w.id} className="row-hover transition-colors">
                  <td className="border-b px-4 py-3.5 font-medium" style={border}>
                    <div className="max-w-[160px] truncate" title={w.name}>{w.name}</div>
                  </td>
                  <td className={`${cell} ${COLUMN_SHOW.owner}`} style={muted}>
                    <div className="max-w-[170px] truncate" title={w.users[0]?.email}>{w.users[0]?.email ?? "-"}</div>
                  </td>
                  <td className={`${cell} ${COLUMN_SHOW.plan}`} style={border}>{w.plan}</td>
                  <td className={`font-mono-tab whitespace-nowrap ${cell}`} style={border}>
                    {(byWorkspace.get(w.id) ?? NO_USAGE).calls}
                    {(byWorkspaceMonth.get(w.id)?.calls ?? 0) > 0 && (
                      <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>{byWorkspaceMonth.get(w.id)!.calls} this month</div>
                    )}
                  </td>
                  <td className={`font-mono-tab whitespace-nowrap ${cell} ${COLUMN_SHOW.minutes}`} style={border}>
                    {formatMinutes((byWorkspace.get(w.id) ?? NO_USAGE).sttSeconds)}
                  </td>
                  <td className={`font-mono-tab whitespace-nowrap ${cell} ${COLUMN_SHOW.cost}`} style={border}>
                    {formatUsd((byWorkspace.get(w.id) ?? NO_USAGE).costUsd)}
                  </td>
                  <td className={`font-mono-tab ${cell} ${COLUMN_SHOW.deals}`} style={border}>{stats._count}</td>
                  <td className={`whitespace-nowrap ${cell} ${COLUMN_SHOW.lastActivity}`} style={muted}>
                    {stats._max.updatedAt ? timeAgo(stats._max.updatedAt) : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>

    {auditLogs.length > 0 && (
      <div className="card mt-6 overflow-hidden">
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Recent activity</h2>
          <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            Security-relevant events across every workspace. Last 100
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {AUDIT_COLUMNS.map((col) => (
                  <th
                    key={col.label}
                    className={`whitespace-nowrap border-b px-3 py-3 text-left text-[12px] font-medium uppercase tracking-wide ${col.show}`}
                    style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {auditLogs.map((entry) => {
                let details = "";
                if (entry.metadata) {
                  try {
                    const parsed = JSON.parse(entry.metadata) as Record<string, unknown>;
                    details = Object.entries(parsed)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(", ");
                  } catch {
                    // ignore malformed metadata
                  }
                }
                return (
                  <tr key={entry.id} className="row-hover transition-colors">
                    <td className="whitespace-nowrap border-b px-3 py-3.5 text-[13px]" style={{ borderColor: "var(--hairline-soft)", color: "var(--ink-muted)" }}>
                      {timeAgo(entry.createdAt)}
                    </td>
                    <td className={`border-b px-3 py-3.5 text-[13px] font-medium ${AUDIT_SHOW.workspace}`} style={{ borderColor: "var(--hairline-soft)" }}>
                      <div className="max-w-[140px] truncate" title={entry.workspace?.name}>{entry.workspace?.name ?? "-"}</div>
                    </td>
                    <td className={`border-b px-3 py-3.5 text-[13px] ${AUDIT_SHOW.actor}`} style={{ borderColor: "var(--hairline-soft)", color: "var(--ink-muted)" }}>
                      <div className="max-w-[170px] truncate" title={entry.actorEmail ?? undefined}>{entry.actorEmail ?? "-"}</div>
                    </td>
                    <td className="whitespace-nowrap border-b px-3 py-3.5" style={{ borderColor: "var(--hairline-soft)" }}>
                      <span className={`chip ${AUDIT_ACTION_CHIP[entry.action] ?? "chip-neutral"}`}>
                        <span className="chip-dot" />
                        {AUDIT_ACTION_LABEL[entry.action] ?? entry.action}
                      </span>
                    </td>
                    <td className={`min-w-[140px] border-b px-3 py-3.5 text-[12.5px] [overflow-wrap:anywhere] ${AUDIT_SHOW.details}`} style={{ borderColor: "var(--hairline-soft)", color: "var(--ink-muted)" }}>
                      {details}
                      {entry.ip ? ` · ${entry.ip}` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    )}
    </>
  );
}
