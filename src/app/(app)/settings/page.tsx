import Link from "next/link";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireWorkspaceId } from "@/lib/workspace";
import { getSenderDomainStatus, type SenderDomainRecord } from "@/lib/sender-domain";
import TwoFactorSettings from "@/components/TwoFactorSettings";
import PhoneNumberSettings from "@/components/PhoneNumberSettings";
import { isTelnyxConfigured } from "@/lib/telnyx";
import { countryFromLocale } from "@/lib/phone-input";
import { headers } from "next/headers";
import { isPhoneApp } from "@/lib/phone-app-server";
import DeleteAccountSettings from "@/components/DeleteAccountSettings";
import RolesManager from "@/components/RolesManager";
import RoleSelect from "@/components/RoleSelect";
import TeamSelect from "@/components/TeamSelect";
import TeamsManager from "@/components/TeamsManager";
import ReviewChainManager from "@/components/ReviewChainManager";
import ApprovalDelegatesPanel from "@/components/ApprovalDelegatesPanel";
import InviteTeammateForm from "@/components/InviteTeammateForm";
import ScimSettingsPanel from "@/components/ScimSettingsPanel";
import SsoSettingsPanel from "@/components/SsoSettingsPanel";
import DeveloperSettingsLink from "@/components/DeveloperSettingsLink";
import SlackSettingsPanel from "@/components/SlackSettingsPanel";
import HubspotSettingsPanel from "@/components/HubspotSettingsPanel";
import GohighlevelSettingsPanel from "@/components/GohighlevelSettingsPanel";
import { listGhlPipelines, type GhlPipeline } from "@/lib/gohighlevel";
import DocusignSettingsPanel from "@/components/DocusignSettingsPanel";
import SalesforceSettingsPanel from "@/components/SalesforceSettingsPanel";
import CrmLeadImportPanel from "@/components/CrmLeadImportPanel";
import { readHubspotFilter, readSalesforceFilter } from "@/lib/crm-leads";
import { loadCrmLeadOptions, saveCrmLeadFilter, saveHubspotWebhookSecret, setCrmLeadImport, setSalesforceWebhookKey, syncCrmLeadsNow } from "./crm-lead-actions";
import { canConnectDocusign, isDocusignConfigured } from "@/lib/docusign";
import { canConnectSalesforce, isSalesforceConfigured } from "@/lib/salesforce";
import { listSlackChannels, isSlackConfigured } from "@/lib/slack";
import {
  checkSenderDomainVerification,
  connectSenderDomain,
  disconnectSenderDomain,
  generateScimToken,
  inviteTeammate,
  removeLogo,
  removeTeammate,
  revokeScimToken,
  toggleSso,
  toggleWorkspaceFlag,
  updateAllowedDomain,
  updateSigningTiming,
  updateSsoConfig,
  updateWorkspaceName,
  uploadLogo,
} from "./actions";
import { assignUserRole, createRole, deleteRole, updateRole } from "./roles-actions";
import { createTeam, deleteTeam, assignUserTeam } from "./team-actions";
import { createReviewChain, deleteReviewChain, moveReviewChain, addReviewChainStep, moveReviewChainStep, removeReviewChainStep } from "./review-chain-actions";
import { createDelegation, revokeDelegation } from "./delegation-actions";
import { setSlackChannel, toggleSlack, disconnectSlack } from "./slack-actions";
import { connectHubspot, toggleHubspot, disconnectHubspot } from "./hubspot-actions";
import { connectGohighlevel, disconnectGohighlevel, setGohighlevelPipeline, toggleGohighlevel } from "./gohighlevel-actions";
import { toggleDocusign, disconnectDocusign } from "./docusign-actions";
import { toggleSalesforce, disconnectSalesforce } from "./salesforce-actions";

function Toggle({ on, field }: { on: boolean; field: "requireApproval" | "notifyOnSigned" | "autoRemind" }) {
  return (
    <form action={toggleWorkspaceFlag.bind(null, field)}>
      <button
        type="submit"
        className="h-6 w-10 flex-none rounded-full"
        style={{ background: on ? "var(--surface-2)" : "var(--canvas)", border: "1px solid var(--hairline)" }}
      >
        <div
          className="h-[18px] w-[18px] rounded-full transition-transform"
          style={{ background: on ? "var(--primary)" : "var(--ink-muted)", transform: on ? "translate(19px, 2px)" : "translate(2px, 2px)" }}
        />
      </button>
    </form>
  );
}

// The person's own settings: their phone number (for calls), two-factor
// and deleting the account. All the iPhone app shows.
async function PersonalSettings({
  user,
  prospecting,
}: {
  user: { phone: string | null; phoneVerifiedAt: Date | null; passwordHash: string | null; twoFactorEnabled: boolean };
  prospecting: boolean;
}) {
  return (
    <>
      {prospecting && (
        <div id="phone" className="glass-card glass-card-solid card-hover mb-4 max-w-[600px] scroll-mt-24">
          <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
            <h2 className="text-[15px] font-medium">Your phone number</h2>
          </div>
          <div className="px-[22px] py-4">
            <PhoneNumberSettings
              phone={user.phone}
              verified={Boolean(user.phoneVerifiedAt)}
              canVerify={isTelnyxConfigured()}
              country={countryFromLocale((await headers()).get("accept-language")?.split(",")[0])?.code ?? "US"}
            />
          </div>
        </div>
      )}

      {user.passwordHash && (
        <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
          <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
            <h2 className="text-[15px] font-medium">Two-factor authentication</h2>
          </div>
          <div className="px-[22px] py-4">
            <TwoFactorSettings enabled={user.twoFactorEnabled} />
          </div>
        </div>
      )}

      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Delete account</h2>
        </div>
        <div className="px-[22px] py-4">
          <DeleteAccountSettings hasPassword={Boolean(user.passwordHash)} />
        </div>
      </div>
    </>
  );
}

// "Sync now" for CRM leads runs as an action on this page.
export const maxDuration = 60;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; error_detail?: string; slack_connected?: string }>;
}) {
  const { error: connectError, error_detail: connectErrorDetail, slack_connected } = await searchParams;
  const workspaceId = await requireWorkspaceId();
  const [workspace, session, roles, teams, reviewChains] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: workspaceId }, include: { users: { include: { role: true, team: true } } } }),
    auth(),
    prisma.role.findMany({ where: { workspaceId }, include: { _count: { select: { users: true } } }, orderBy: [{ isOwner: "desc" }, { createdAt: "asc" }] }),
    prisma.team.findMany({ where: { workspaceId }, include: { _count: { select: { users: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.reviewChain.findMany({
      where: { workspaceId },
      include: { team: true, steps: { include: { assignee: true }, orderBy: { order: "asc" } } },
      orderBy: { order: "asc" },
    }),
  ]);
  if (!workspace) return null;
  const currentUser = workspace.users.find((u) => u.email === session?.user?.email);
  // The iPhone app: only the person's own settings. The workspace, the team
  // and connected apps are set up on a computer.
  if (await isPhoneApp()) {
    return (
      <>
        <div className="mb-6">
          <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Settings</h1>
          <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
            Your account. The workspace, the team and connected apps are set up on a computer.
          </div>
        </div>
        {currentUser && <PersonalSettings user={currentUser} prospecting={workspace.prospectingEnabled} />}
      </>
    );
  }
  const canManageTeam = Boolean(currentUser?.role?.canManageTeam);
  const canManageWorkspacePerm = Boolean(currentUser?.role?.canManageWorkspace);
  const notifyEmail = workspace.users.map((u) => u.email).join(", ") || "your account email";
  const roleOptions = roles.map((r) => ({ id: r.id, name: r.name }));
  const teammateOptions = workspace.users.map((u) => ({ id: u.id, name: u.name }));
  const teamOptions = teams.map((t) => ({ id: t.id, name: t.name }));

  const delegationsRaw = await prisma.approvalDelegate.findMany({
    where: canManageWorkspacePerm ? { workspaceId } : { workspaceId, OR: [{ fromUserId: currentUser?.id }, { toUserId: currentUser?.id }] },
    include: { fromUser: { select: { name: true } }, toUser: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
  });
  const delegations = delegationsRaw.map((d) => ({
    id: d.id,
    fromUserId: d.fromUserId,
    fromName: d.fromUser.name,
    toUserId: d.toUserId,
    toName: d.toUser.name,
    endsAt: d.endsAt ? d.endsAt.toISOString() : null,
  }));

  let slackChannels: { id: string; name: string }[] = [];
  let slackChannelsError: string | null = null;
  if (workspace.slackAccessToken) {
    try {
      slackChannels = await listSlackChannels(workspace.slackAccessToken);
    } catch (err) {
      slackChannelsError = err instanceof Error ? err.message : "Unknown error";
    }
  }

  // The sub-account's pipelines, for picking where opportunities open.
  let ghlPipelines: GhlPipeline[] = [];
  let ghlPipelinesError: string | null = null;
  if (canManageWorkspacePerm && workspace.ghlAccessToken && workspace.ghlLocationId) {
    try {
      ghlPipelines = await listGhlPipelines(workspace.ghlAccessToken, workspace.ghlLocationId);
    } catch {
      ghlPipelinesError = "Couldn't load the pipelines from GoHighLevel right now.";
    }
  }

  let senderRecords: SenderDomainRecord[] = [];
  if (workspace.senderDomainId && workspace.senderDomainStatus !== "verified") {
    try {
      const live = await getSenderDomainStatus(workspace.senderDomainId);
      senderRecords = live.records;
    } catch {
      // Resend lookup failed — fall back to showing the last known status below
    }
  }

  return (
    <>
    <div className="mb-6">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Settings</h1>
      <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
        Workspace preferences for {workspace.name}
      </div>
    </div>

    {connectError && (
      <div className="chip chip-warn mb-4 max-w-[600px] flex-col items-start justify-start gap-1 whitespace-normal px-3.5 py-2.5 text-[12.5px]">
        <span>{connectError.replace(/_/g, " ")}</span>
        {connectErrorDetail && <span style={{ color: "var(--ink-muted)" }}>{connectErrorDetail}</span>}
      </div>
    )}
    {slack_connected && (
      <div className="chip chip-success mb-4 max-w-[600px] justify-start px-3.5 py-2.5 text-[12.5px]">
        Slack connected. Pick a channel below.
      </div>
    )}

    <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px] px-[22px] py-2">
      <div className="flex items-center justify-between gap-4 py-[15px]">
        <div className="w-full">
          <div className="text-[13.5px] font-medium">Workspace name</div>
          <form action={updateWorkspaceName} className="mt-2 flex gap-2">
            <input name="name" defaultValue={workspace.name} className="input flex-1" style={{ fontSize: "13px", padding: "8px 11px" }} />
            <button type="submit" className="btn btn-secondary btn-sm">Save</button>
          </form>
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 border-t py-[15px]" style={{ borderColor: "var(--hairline-soft)" }}>
        <div className="w-full">
          <div className="text-[13.5px] font-medium">Logo</div>
          <div className="mb-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Shown to clients on the sign page and the contract PDF instead of just your name.
          </div>
          {workspace.logoImage && (
            <div className="mb-2.5 flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={workspace.logoImage} alt="Workspace logo" style={{ height: 36, maxWidth: 160, objectFit: "contain" }} />
              <form action={removeLogo}>
                <button type="submit" className="text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>
                  Remove
                </button>
              </form>
            </div>
          )}
          <form action={uploadLogo} className="flex gap-2">
            {/* min-width:0 overrides the flex item's default min-width:auto —
                a native file input's own "Choose file" chrome otherwise
                refuses to shrink below its content width, pushing the
                Upload button off a narrow (mobile) viewport instead of
                letting the input itself truncate. */}
            <input name="logo" type="file" accept="image/*" required className="input min-w-0 flex-1" style={{ fontSize: "13px", padding: "7px 11px" }} />
            <button type="submit" className="btn btn-secondary btn-sm">{workspace.logoImage ? "Replace" : "Upload"}</button>
          </form>
        </div>
      </div>
    </div>

    <div id="team" className="glass-card glass-card-solid card-hover mb-4 max-w-[600px] scroll-mt-24">
      <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">Team</h2>
      </div>
      <div className="px-[22px] py-2">
        {workspace.users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-3.5 border-b py-3" style={{ borderColor: "var(--hairline-soft)" }}>
            <div>
              <div className="text-[13.5px] font-medium">{u.name}</div>
              <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>{u.email}</div>
            </div>
            <div className="flex items-center gap-3">
              {canManageTeam && teamOptions.length > 0 ? (
                <TeamSelect userId={u.id} currentTeamId={u.teamId} teams={teamOptions} action={assignUserTeam} />
              ) : (
                u.team && <span className="chip chip-neutral" style={{ fontSize: 11 }}>{u.team.name}</span>
              )}
              {canManageTeam && roleOptions.length > 0 ? (
                <RoleSelect userId={u.id} currentRoleId={u.roleId} roles={roleOptions} action={assignUserRole} />
              ) : (
                u.role && <span className="chip chip-neutral" style={{ fontSize: 11 }}>{u.role.name}</span>
              )}
              {workspace.users.length > 1 && canManageTeam && (
                <form action={removeTeammate.bind(null, u.id)}>
                  <button type="submit" className="text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>
                    Remove
                  </button>
                </form>
              )}
            </div>
          </div>
        ))}
        <InviteTeammateForm inviteAction={inviteTeammate} />
        <div className="pb-3 text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
          They&apos;ll get an email with a link to set their password. Teammates with a Google account can also just sign in with Google.
        </div>
      </div>
    </div>

    {canManageTeam && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Roles &amp; permissions</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Owner always has every permission. Custom roles control what teammates can do elsewhere in the workspace.
          </div>
        </div>
        <RolesManager
          roles={roles.map((r) => ({
            id: r.id,
            name: r.name,
            isOwner: r.isOwner,
            canManageWorkspace: r.canManageWorkspace,
            canManageTeam: r.canManageTeam,
            canManageTemplates: r.canManageTemplates,
            canApproveTemplates: r.canApproveTemplates,
            canViewAllDeals: r.canViewAllDeals,
            memberCount: r._count.users,
          }))}
          createRoleAction={createRole}
          updateRoleAction={updateRole}
          deleteRoleAction={deleteRole}
        />
      </div>
    )}

    {canManageTeam && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Teams</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Organizational segments (e.g. &ldquo;Sales EMEA&rdquo;, &ldquo;Sales US&rdquo;). Assign teammates to one above, then give a team its own review chain below.
          </div>
        </div>
        <TeamsManager
          teams={teams.map((t) => ({ id: t.id, name: t.name, memberCount: t._count.users }))}
          createTeamAction={createTeam}
          deleteTeamAction={deleteTeam}
        />
      </div>
    )}

    {canManageWorkspacePerm && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Review chains</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Contracts wait for every named reviewer in the matching chain to mark their step done, in order, before they go out to the client. Small deals can move fast, while big or team-specific ones pick up extra steps.
          </div>
        </div>
        <ReviewChainManager
          chains={reviewChains.map((c) => ({
            id: c.id,
            name: c.name,
            order: c.order,
            teamId: c.teamId,
            teamName: c.team?.name ?? null,
            minDealValue: c.minDealValue,
            steps: c.steps.map((s) => ({ id: s.id, order: s.order, assigneeId: s.assigneeId, assigneeName: s.assignee.name })),
          }))}
          teammates={teammateOptions}
          teams={teamOptions}
          createChainAction={createReviewChain}
          deleteChainAction={deleteReviewChain}
          moveChainAction={moveReviewChain}
          addStepAction={addReviewChainStep}
          removeStepAction={removeReviewChainStep}
          moveStepAction={moveReviewChainStep}
        />
      </div>
    )}

    {currentUser && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Approval backups</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Going on leave? Hand your approval authority to a teammate so a chain never gets stuck waiting on one person.
          </div>
        </div>
        <ApprovalDelegatesPanel
          currentUserId={currentUser.id}
          teammates={workspace.users.map((u) => ({ id: u.id, name: u.name }))}
          delegations={delegations}
          isAdmin={canManageWorkspacePerm}
          createDelegationAction={createDelegation}
          revokeDelegationAction={revokeDelegation}
        />
      </div>
    )}

    {canManageWorkspacePerm && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Access &amp; provisioning</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Control who can join, and let your IT team manage teammates automatically.
          </div>
        </div>
        <ScimSettingsPanel
          currentDomain={workspace.allowedEmailDomain}
          hasScimToken={Boolean(workspace.scimTokenHash)}
          scimBaseUrl={`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/scim/v2`}
          updateDomainAction={updateAllowedDomain}
          generateTokenAction={generateScimToken}
          revokeTokenAction={revokeScimToken}
        />
      </div>
    )}

    {canManageWorkspacePerm && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Single sign-on</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            {workspace.ssoEnabled ? (
              <span className="chip chip-success" style={{ padding: "1px 8px" }}>Enabled</span>
            ) : (
              "Requires an allowed email domain above, plus an OIDC app registered with your identity provider."
            )}
          </div>
        </div>
        <SsoSettingsPanel
          ssoEnabled={workspace.ssoEnabled}
          currentIssuer={workspace.ssoIssuer}
          currentClientId={workspace.ssoClientId}
          hasClientSecret={Boolean(workspace.ssoClientSecret)}
          redirectUri={`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/sso/callback`}
          updateConfigAction={updateSsoConfig}
          toggleAction={toggleSso}
        />
      </div>
    )}

    {canManageWorkspacePerm && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Slack</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Post to a channel when a deal starts, a contract goes out or gets signed, or an approval is waiting on someone.
          </div>
        </div>
        <SlackSettingsPanel
          configured={isSlackConfigured()}
          connected={Boolean(workspace.slackAccessToken)}
          teamName={workspace.slackTeamName}
          currentChannelId={workspace.slackChannelId}
          currentChannelName={workspace.slackChannelName}
          channels={slackChannels}
          channelsError={slackChannelsError}
          enabled={workspace.slackEnabled}
          setChannelAction={setSlackChannel}
          toggleAction={toggleSlack}
          disconnectAction={disconnectSlack}
        />
      </div>
    )}

    {canManageWorkspacePerm && (
      <div id="crm" className="glass-card glass-card-solid card-hover mb-4 max-w-[600px] scroll-mt-24">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">HubSpot</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Push clients and deals to HubSpot as Contacts and Deals, and bring HubSpot contacts in as leads.
          </div>
        </div>
        <HubspotSettingsPanel
          connected={Boolean(workspace.hubspotAccessToken)}
          portalId={workspace.hubspotPortalId}
          enabled={workspace.hubspotEnabled}
          connectAction={connectHubspot}
          toggleAction={toggleHubspot}
          disconnectAction={disconnectHubspot}
        />
        {workspace.hubspotAccessToken && workspace.prospectingEnabled && (
          <CrmLeadImportPanel
            crm="hubspot"
            enabled={workspace.hubspotLeadImport}
            filter={readHubspotFilter(workspace.hubspotLeadFilter)}
            syncedAt={workspace.hubspotLeadsSyncedAt?.toISOString() ?? null}
            webhook={{ url: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/hubspot/webhook`, secretSaved: Boolean(workspace.hubspotWebhookSecret) }}
            setEnabledAction={setCrmLeadImport}
            saveFilterAction={saveCrmLeadFilter}
            loadOptionsAction={loadCrmLeadOptions}
            syncAction={syncCrmLeadsNow}
            saveSecretAction={saveHubspotWebhookSecret}
          />
        )}
      </div>
    )}

    {canManageWorkspacePerm && workspace.prospectingEnabled && (
      <div id="gohighlevel" className="glass-card glass-card-solid card-hover mb-4 max-w-[600px] scroll-mt-24">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">GoHighLevel</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Put every call into a GoHighLevel sub-account: the contact, the notes, the next step and, if you like, an opportunity.
          </div>
        </div>
        <GohighlevelSettingsPanel
          connected={Boolean(workspace.ghlAccessToken)}
          locationId={workspace.ghlLocationId}
          enabled={workspace.ghlEnabled}
          pipelines={ghlPipelines}
          pipelinesError={ghlPipelinesError}
          selected={workspace.ghlPipelineId ? `${workspace.ghlPipelineId}:${workspace.ghlStageId ?? ""}` : ""}
          connectAction={connectGohighlevel}
          setPipelineAction={setGohighlevelPipeline}
          toggleAction={toggleGohighlevel}
          disconnectAction={disconnectGohighlevel}
        />
      </div>
    )}

    {canManageWorkspacePerm && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">DocuSign</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Hand a contract straight to your own DocuSign account for signing instead of SealMe&apos;s built-in flow. Offered as a choice on the Send page once connected.
          </div>
        </div>
        <DocusignSettingsPanel
          configured={isDocusignConfigured()}
          available={canConnectDocusign(workspace.id)}
          connected={Boolean(workspace.docusignRefreshToken)}
          accountEmail={workspace.docusignAccountEmail}
          enabled={workspace.docusignEnabled}
          toggleAction={toggleDocusign}
          disconnectAction={disconnectDocusign}
        />
      </div>
    )}

    {canManageWorkspacePerm && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Salesforce</h2>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Push clients and deals to your Salesforce org as Contacts and Opportunities, and bring Salesforce Leads in as leads.
          </div>
        </div>
        <SalesforceSettingsPanel
          configured={isSalesforceConfigured()}
          available={canConnectSalesforce(workspace.id)}
          connected={Boolean(workspace.salesforceRefreshToken)}
          accountEmail={workspace.salesforceAccountEmail}
          enabled={workspace.salesforceEnabled}
          toggleAction={toggleSalesforce}
          disconnectAction={disconnectSalesforce}
        />
        {workspace.salesforceRefreshToken && workspace.prospectingEnabled && (
          <CrmLeadImportPanel
            crm="salesforce"
            enabled={workspace.salesforceLeadImport}
            filter={readSalesforceFilter(workspace.salesforceLeadFilter)}
            syncedAt={workspace.salesforceLeadsSyncedAt?.toISOString() ?? null}
            setEnabledAction={setCrmLeadImport}
            saveFilterAction={saveCrmLeadFilter}
            loadOptionsAction={loadCrmLeadOptions}
            syncAction={syncCrmLeadsNow}
            salesforceWebhook={{ url: workspace.salesforceWebhookKey ? `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/salesforce/webhook?key=${workspace.salesforceWebhookKey}` : null }}
            setWebhookKeyAction={setSalesforceWebhookKey}
          />
        )}
      </div>
    )}

    {canManageWorkspacePerm && (
      <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
        <Link href="/settings/import" className="flex items-center justify-between gap-3 px-[22px] py-4">
          <div>
            <h2 className="text-[15px] font-medium">Bulk import</h2>
            <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
              Bring clients and deals over from a previous system via CSV.
            </div>
          </div>
          <span style={{ color: "var(--ink-muted)" }}>→</span>
        </Link>
      </div>
    )}

    {canManageWorkspacePerm && <DeveloperSettingsLink />}

    {currentUser && <PersonalSettings user={currentUser} prospecting={workspace.prospectingEnabled} />}

    <div className="glass-card glass-card-solid card-hover mb-4 max-w-[600px]">
      <div className="border-b px-[22px] py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">Sending domain</h2>
      </div>
      <div className="px-[22px] py-[18px]">
        {!workspace.senderDomain ? (
          <>
            <p className="mb-3 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
              Verify your own domain so contracts go out as you, not &ldquo;via SealMe&rdquo;.
            </p>
            <form action={connectSenderDomain} className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                name="mailbox"
                defaultValue="hello"
                placeholder="hello"
                className="input"
                style={{ fontSize: "13px", padding: "8px 11px", width: 110 }}
              />
              <span className="text-[13px]" style={{ color: "var(--ink-muted)" }}>@</span>
              <input
                name="domain"
                required
                placeholder="yourcompany.com"
                className="input flex-1"
                style={{ fontSize: "13px", padding: "8px 11px" }}
              />
              <button type="submit" className="btn btn-primary btn-sm">Connect</button>
            </form>
          </>
        ) : workspace.senderDomainStatus === "verified" ? (
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="chip chip-success">Verified ✓</div>
              <div className="mt-2 text-[13px] font-medium">{workspace.senderEmail}</div>
              <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Contracts are sent from this address.</div>
            </div>
            <form action={disconnectSenderDomain}>
              <button type="submit" className="btn btn-secondary btn-sm">Change</button>
            </form>
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center justify-between gap-4">
              <div>
                <div className="text-[13.5px] font-medium">{workspace.senderDomain}</div>
                <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
                  Add these DNS records at your domain host, then check verification.
                </div>
              </div>
            </div>
            {senderRecords.length > 0 && (
              <div className="mb-3 overflow-x-auto rounded-[10px]" style={{ border: "1px solid var(--hairline)" }}>
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr>
                      {["Type", "Name", "Value", "Status"].map((h) => (
                        <th key={h} className="border-b px-3 py-2 text-left font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {senderRecords.map((rec, i) => (
                      <tr key={i}>
                        <td className="font-mono-tab border-b px-3 py-2" style={{ borderColor: "var(--hairline-soft)" }}>{rec.type}</td>
                        <td className="font-mono-tab border-b px-3 py-2 break-all" style={{ borderColor: "var(--hairline-soft)" }}>{rec.name}</td>
                        <td className="font-mono-tab border-b px-3 py-2 break-all" style={{ borderColor: "var(--hairline-soft)" }}>{rec.value}</td>
                        <td className="border-b px-3 py-2" style={{ borderColor: "var(--hairline-soft)" }}>
                          <span className={`chip ${rec.status === "verified" ? "chip-success" : "chip-neutral"}`} style={{ fontSize: 11 }}>
                            {rec.status}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex gap-2">
              <form action={checkSenderDomainVerification}>
                <button type="submit" className="btn btn-primary btn-sm">Check verification</button>
              </form>
              <form action={disconnectSenderDomain}>
                <button type="submit" className="btn btn-secondary btn-sm">Start over</button>
              </form>
            </div>
          </>
        )}
      </div>
    </div>

    <div className="glass-card glass-card-solid card-hover max-w-[600px] px-[22px] py-2">
      <div className="flex items-center justify-between gap-4 border-b py-[15px]" style={{ borderColor: "var(--hairline-soft)" }}>
        <div>
          <div className="text-[13.5px] font-medium">Require manual approval before sending</div>
          <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Nothing reaches a client without your review</div>
        </div>
        <Toggle on={workspace.requireApproval} field="requireApproval" />
      </div>
      <div className="flex items-center justify-between gap-4 border-b py-[15px]" style={{ borderColor: "var(--hairline-soft)" }}>
        <div>
          <div className="text-[13.5px] font-medium">Email me when a contract is signed</div>
          <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Sent to {notifyEmail}</div>
        </div>
        <Toggle on={workspace.notifyOnSigned} field="notifyOnSigned" />
      </div>
      <div className="flex items-center justify-between gap-4 py-[15px]">
        <div>
          <div className="text-[13.5px] font-medium">Auto-remind clients after {workspace.reminderIntervalDays} day{workspace.reminderIntervalDays === 1 ? "" : "s"}</div>
          <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>One polite nudge if a contract is left unsigned</div>
        </div>
        <Toggle on={workspace.autoRemind} field="autoRemind" />
      </div>
      <div className="flex flex-col gap-2.5 border-t py-[15px]" style={{ borderColor: "var(--hairline-soft)" }}>
        <div>
          <div className="text-[13.5px] font-medium">Signing timing</div>
          <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>How many days before a reminder, and (optionally) before an unsigned link expires</div>
        </div>
        <form action={updateSigningTiming} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>Remind after (days)</span>
            <input name="reminderIntervalDays" type="number" min="1" max="90" defaultValue={workspace.reminderIntervalDays} className="input" style={{ fontSize: "13px", padding: "7px 10px", width: 90 }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>Expire after (days, blank = never)</span>
            <input name="signingExpiryDays" type="number" min="1" max="365" defaultValue={workspace.signingExpiryDays ?? ""} placeholder="—" className="input" style={{ fontSize: "13px", padding: "7px 10px", width: 90 }} />
          </label>
          <button type="submit" className="btn btn-secondary btn-sm">Save</button>
        </form>
      </div>
    </div>
    </>
  );
}
