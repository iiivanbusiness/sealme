import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { isPhoneApp } from "@/lib/phone-app-server";
import { leadAccess } from "@/lib/lead-visibility";
import { formatPhone } from "@/lib/phone";
import { isTelnyxConfigured } from "@/lib/telnyx";
import { leadIsInactive, INACTIVE_STAGES, PIPELINE_STAGE_CHIP, PIPELINE_STAGE_LABEL } from "@/lib/lead-pipeline";
import { overviewFromCall } from "@/lib/lead-overview";
import { docStatus } from "@/lib/doc-status";
import { docDate, docFailed, docReadiness, LEAD_PAGE_CALL_STATUSES, LEAD_PAGE_SET_ASIDE_STATUSES, ownPointers, setAsideRow } from "@/lib/call-docs";
import { SKIP_LABEL, failStuckCalls } from "@/lib/call-inbox";
import { workspaceCampaigns } from "@/lib/campaigns";
import LeadFields from "@/components/LeadFields";
import SubmitButton from "@/components/SubmitButton";
import LeadCalls, { type CallDoc, type LeadCallItem } from "@/components/LeadCalls";
import LeadOverview from "@/components/LeadOverview";
import LeadActions from "@/components/LeadActions";
import LeadCallButton from "@/components/LeadCallButton";
import RefreshWhile from "@/components/RefreshWhile";
import { cookieTimeZone } from "@/lib/viewer-time";
import { dayLabel } from "@/lib/day-label";
import { ClientCheck } from "@/components/LeadsTable";
import { deleteLead, markLeadLost, markLeadNotNow, reactivateLead, updateLead } from "../actions";
import { startLeadCall } from "../phone-actions";
import { deleteCall, mergeLeadInto, moveCallToLead, searchLeadsToJoin } from "../merge-actions";
import { createFromCall } from "../document-actions";

// Writing a proposal or contract from a call (an action on this page) waits
// on Claude; give it room beyond the default.
export const maxDuration = 300;

// Next-step dates are stored as UTC midnight, so formatting in UTC shows the
// day that was picked, for every viewer.
function formatDay(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function firstSentence(text: string | null): string {
  const t = (text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "";
  const m = t.match(/^.+?[.!?](?=\s|$)/);
  return (m ? m[0] : t).slice(0, 220);
}

// Pain points from the call's write-up: one list, separated by semicolons.
function painPointsOf(extracted: unknown): string[] {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return [];
  const value = (extracted as Record<string, unknown>).painPoints;
  return typeof value === "string" ? value.split(/;\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 8) : [];
}

function nextStepOf(extracted: unknown): string | null {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return null;
  const e = extracted as Record<string, unknown>;
  if (typeof e.nextStep !== "string" || !e.nextStep.trim()) return null;
  const date = typeof e.nextStepDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.nextStepDate) ? formatDay(new Date(`${e.nextStepDate}T00:00:00Z`)) : null;
  return [e.nextStep.trim(), date].filter(Boolean).join(" · ");
}

export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; saved?: string; edit?: string; error?: string; call?: string; added?: string }>;
}) {
  const workspace = await requireProspecting();
  const { id } = await params;
  // call: the call to open, e.g. the one Start a call just saved (added).
  const { created, saved, edit, error, call: openCallId, added } = await searchParams;

  const [access, phone, timeZone] = await Promise.all([leadAccess(), isPhoneApp(), cookieTimeZone()]);
  const lead = await prisma.lead.findFirst({ where: { id, workspaceId: workspace.id, ...access.where }, include: { owner: { select: { id: true, name: true } } } });
  if (!lead) {
    // A call saved on a placeholder lead can be moved onto the existing lead
    // it turned out to be, and the placeholder deleted: follow the call there.
    const moved = openCallId
      ? await prisma.phoneCall.findFirst({ where: { id: openCallId, workspaceId: workspace.id, leadId: { not: id }, lead: access.where }, select: { id: true, leadId: true } })
      : null;
    if (moved?.leadId) redirect(`/leads/${moved.leadId}?call=${moved.id}${added ? "&added=1" : ""}`);
    notFound();
  }
  // Before the calls: one whose write-up was cut off shows as failed, with
  // a way to try again, instead of "Writing up the notes" (and this page
  // re-reading itself) for good. The same check the Calls page runs.
  await failStuckCalls({ workspaceId: workspace.id, leadId: lead.id });

  const [members, calls, deals, templateKinds, campaigns, alsoAt] = await Promise.all([
    prisma.user.findMany({ where: { workspaceId: workspace.id, deactivatedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    // The newest 200 (a new call must never be the one cut off), then
    // oldest first, which the numbering and overview below rely on.
    prisma.phoneCall
      .findMany({
        where: { leadId: id, workspaceId: workspace.id, status: { in: [...LEAD_PAGE_CALL_STATUSES, ...LEAD_PAGE_SET_ASIDE_STATUSES] } },
        select: { id: true, startedAt: true, durationSec: true, status: true, summary: true, notes: true, extracted: true, transcript: true, dealId: true, wantsProposal: true, wantsContract: true, mode: true, processedAt: true, userId: true, user: { select: { name: true } } },
        orderBy: { startedAt: "desc" },
        take: 200,
      })
      .then((rows) => rows.reverse()),
    prisma.deal.findMany({
      where: { leadId: id, workspaceId: workspace.id, trashedAt: null },
      select: {
        id: true,
        kind: true,
        status: true,
        phoneCallId: true,
        createdAt: true,
        contract: { select: { id: true, status: true, viewedAt: true, sentAt: true, signedAt: true, expiresAt: true } },
        // Ready to go out once nothing is missing (as on the proposal's own page).
        _count: { select: { fields: { where: { status: "missing" } } } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.contractTemplate.groupBy({ by: ["kind"], where: { workspaceId: workspace.id }, _count: true }),
    workspaceCampaigns(workspace.id),
    // Other people from the same company, so the rep sees the whole account.
    lead.company
      ? prisma.lead.findMany({
          where: { workspaceId: workspace.id, id: { not: lead.id }, company: { equals: lead.company, mode: "insensitive" }, ...access.where },
          select: { id: true, name: true },
          orderBy: { lastActivityAt: { sort: "desc", nulls: "last" } },
          take: 6,
        })
      : Promise.resolve([]),
  ]);

  const processed = calls.filter((c) => c.status === "processed");
  const newest = processed.at(-1);
  const overview = processed.length >= 2 ? overviewFromCall(newest?.extracted) : null;
  const team = members.length >= 2;
  // A rep can't reassign, so the owner field just shows who has it.
  const owners = access.canAssign ? members : lead.owner ? [lead.owner] : [];

  // Each call's proposal and contract: the deal made from the call, newest
  // of each kind (the call's own pointer covers deals made before calls
  // were linked both ways). The old pointer counts only when it's that
  // call's alone, by the same rule "Delete call" goes by.
  const pointer = ownPointers(calls);
  const now = new Date();
  // Where it is and since when, and for a proposal what Send and Copy link need.
  const docOf = (deal: (typeof deals)[number]) => ({
    id: deal.id,
    ...docStatus(deal),
    day: dayLabel(docDate(deal), timeZone, now),
    contractId: deal.contract?.id ?? null,
    ...docReadiness({ status: deal.status, hasDocument: Boolean(deal.contract), missing: deal._count.fields }),
    sent: ["sent", "partially_signed", "signed"].includes(deal.contract?.status ?? ""),
  });
  const docFor = (callId: string, dealId: string | null, kind: string): CallDoc | null => {
    const made = deals.filter((d) => (d.kind === kind || (kind === "contract" && d.kind !== "proposal")) && (d.phoneCallId === callId || (!d.phoneCallId && d.id === dealId)));
    const deal = made.at(-1);
    return deal ? docOf(deal) : null;
  };
  const onACall = new Set(calls.flatMap((c) => [c.id, pointer(c)].filter(Boolean)));
  // A proposal or contract the call asked for is written right after its
  // notes: for a few minutes it's on its way, not missing. Not once it's
  // there, or once writing it failed (nothing is coming: the rep makes it).
  const onItsWay = (c: (typeof calls)[number], kind: "proposal" | "contract") =>
    c.status === "processed" &&
    (kind === "proposal" ? c.wantsProposal : c.wantsContract || c.mode === "sales") &&
    Boolean(c.processedAt) &&
    now.getTime() - c.processedAt!.getTime() < 5 * 60 * 1000 &&
    !docFailed(c.extracted, kind) &&
    docFor(c.id, pointer(c), kind) == null;
  // Call 1..N counts the calls with notes; a set-aside one has no number,
  // so a missed call doesn't renumber the conversations.
  const numbered = calls.filter((c) => LEAD_PAGE_CALL_STATUSES.includes(c.status));
  // The Calls page shows a rep their own calls; people who see all deals or
  // run the team see everyone's.
  const seesAllCalls = access.canViewAll || access.canAssign;
  const setAsideOf = (c: (typeof calls)[number]) => setAsideRow(c, { onCallsPage: seesAllCalls || c.userId === access.userId, skipLabels: SKIP_LABEL });
  const items: LeadCallItem[] = [
    ...calls.map((c): LeadCallItem => ({
      type: "call",
      id: c.id,
      n: numbered.includes(c) ? numbered.indexOf(c) + 1 : null,
      at: c.startedAt.toISOString(),
      day: dayLabel(c.startedAt, timeZone, now),
      minutes: c.durationSec ? Math.max(1, Math.round(c.durationSec / 60)) : null,
      who: team ? (c.user?.name ?? null) : null,
      processing: c.status === "processing",
      recording: c.status === "recording",
      line: firstSentence(c.summary),
      summary: c.summary,
      notes: c.notes,
      painPoints: painPointsOf(c.extracted),
      nextStep: nextStepOf(c.extracted),
      transcript: c.transcript,
      proposal: docFor(c.id, pointer(c), "proposal") ?? (onItsWay(c, "proposal") ? { id: null, label: "Being written", chip: "chip-neutral" } : null),
      contract: docFor(c.id, pointer(c), "contract") ?? (onItsWay(c, "contract") ? { id: null, label: "Being written", chip: "chip-neutral" } : null),
      setAside: setAsideOf(c),
    })),
    ...deals
      .filter((d) => !(d.phoneCallId && onACall.has(d.phoneCallId)) && !onACall.has(d.id))
      .map((d): LeadCallItem => ({ type: "doc", id: d.id, at: d.createdAt.toISOString(), day: dayLabel(d.createdAt, timeZone, now), kind: d.kind === "proposal" ? "proposal" : "contract", doc: docOf(d) })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const templates = {
    proposal: templateKinds.some((t) => t.kind === "proposal"),
    contract: templateKinds.some((t) => t.kind !== "proposal"),
  };
  const inactive = leadIsInactive(lead);
  const idle = inactive && !INACTIVE_STAGES.includes(lead.pipelineStage);
  const nextStep = lead.nextStep ? [lead.nextStep, lead.nextStepAt ? formatDay(lead.nextStepAt) : null].filter(Boolean).join(" · ") : null;
  const canCall = Boolean(lead.phone) && isTelnyxConfigured();
  // A call still being written up shows its notes as soon as they're in; one
  // still recording shows its proposal or contract filling in.
  const writing = calls.some((c) => c.status === "processing" || onItsWay(c, "proposal") || onItsWay(c, "contract"));
  const recording = calls.some((c) => c.status === "recording");
  // Just saved from Start a call: still being written up, or done.
  const addedCall = added ? calls.find((c) => c.id === openCallId) : undefined;
  const addedWriting = addedCall ? addedCall.status === "processing" : calls.some((c) => c.status === "processing");

  return (
    <>
      <Link href="/leads" className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
        ← Leads
      </Link>

      {(created || saved) && (
        <div className="chip chip-success mb-4 w-full max-w-[720px] justify-start px-4 py-2.5 text-[12.5px]" role="status">
          {created ? "Lead added." : "Changes saved."}
        </div>
      )}
      {added && !created && !saved && (
        <div className="chip chip-success mb-4 w-full max-w-[720px] justify-start whitespace-normal px-4 py-2.5 text-[12.5px]" role="status">
          {addedWriting ? "Call saved. SealMe is writing it up, and the notes show below in a minute or two." : "Call saved."}
        </div>
      )}

      <div className="flex max-w-[860px] flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            {/* Who the rep is calling for, when the workspace runs campaigns for several clients. */}
            {lead.campaign && <div className="chip chip-neutral mb-2 w-fit">{lead.campaign}</div>}
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <h1 className="break-words text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>{lead.name}</h1>
              {lead.isClient && <ClientCheck size={18} />}
              <span className={`chip ${PIPELINE_STAGE_CHIP[lead.pipelineStage] ?? "chip-neutral"}`}>{PIPELINE_STAGE_LABEL[lead.pipelineStage] ?? lead.pipelineStage}</span>
              {idle && <span className="chip chip-neutral" title="Nothing new for 30 days">Inactive</span>}
            </div>
            {(lead.title || lead.company) && (
              <div className="mt-1 break-words text-[13.5px]" style={{ color: "var(--ink-muted)" }}>{[lead.title, lead.company].filter(Boolean).join(" · ")}</div>
            )}
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
              {lead.email && <a href={`mailto:${lead.email}`} className="break-all font-medium" style={{ color: "var(--accent-blue)" }}>{lead.email}</a>}
              {lead.phone && <a href={`tel:${lead.phone}`} className="font-medium" style={{ color: "var(--accent-blue)" }}>{formatPhone(lead.phone)}</a>}
              {team && <span style={{ color: "var(--ink-muted)" }}>{lead.owner ? `Owner: ${lead.owner.name}` : "Unassigned"}</span>}
            </div>
          </div>
          {/* "contents": the menu's Merge and Delete panels wrap onto their own row under the header. */}
          <div className="contents">
            {canCall && <LeadCallButton leadName={lead.name} variant="compact" startAction={startLeadCall.bind(null, lead.id)} />}
            <LeadActions
              leadName={lead.name}
              calls={processed.length}
              editHref={`/leads/${lead.id}?edit=1`}
              can={{
                lose: !lead.isClient && lead.pipelineStage !== "lost",
                notNow: !lead.isClient && lead.pipelineStage !== "lost" && lead.pipelineStage !== "not_now",
                reactivate: !lead.isClient && inactive,
              }}
              searchLeads={searchLeadsToJoin.bind(null, lead.id)}
              mergeAction={mergeLeadInto.bind(null, lead.id)}
              lostAction={markLeadLost.bind(null, lead.id)}
              notNowAction={markLeadNotNow.bind(null, lead.id)}
              reactivateAction={reactivateLead.bind(null, lead.id)}
              deleteAction={access.canAssign ? deleteLead.bind(null, lead.id) : undefined}
            />
          </div>
        </div>

        {(nextStep || alsoAt.length > 0) && (
          <div className="flex flex-col gap-1.5 text-[13px]">
            {nextStep && (
              <div className="break-words">
                <span style={{ color: "var(--ink-muted)" }}>Next step: </span>
                {nextStep}
              </div>
            )}
            {alsoAt.length > 0 && (
              <div className="break-words">
                <span style={{ color: "var(--ink-muted)" }}>Also at {lead.company}: </span>
                {alsoAt.map((l, i) => (
                  <span key={l.id}>
                    {i > 0 && ", "}
                    <Link href={`/leads/${l.id}`} className="font-medium" style={{ color: "var(--accent-blue)" }}>{l.name}</Link>
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {edit && (
          <div className="card min-w-0 p-5 sm:p-6">
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <div className="text-[14px] font-medium">Edit details</div>
              <Link href={`/leads/${lead.id}`} className="text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }}>Cancel</Link>
            </div>
            {error && <div className="chip chip-warn mb-4 w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]" role="alert">{error.slice(0, 200)}</div>}
            <form action={updateLead.bind(null, lead.id)} className="flex min-w-0 flex-col gap-5">
              <LeadFields owners={owners} full values={lead} allowUnassigned={access.canAssign} campaigns={campaigns} />
              <SubmitButton className="btn btn-primary w-full justify-center sm:w-auto sm:self-start" pendingText="Saving…">
                Save changes
              </SubmitButton>
            </form>
          </div>
        )}

        {overview && processed[0] && <LeadOverview overview={overview} calls={processed.length} since={dayLabel(processed[0].startedAt, timeZone, now)} />}

        {(writing || recording) && <RefreshWhile everyMs={writing ? 4000 : 15000} />}
        <LeadCalls
          items={items}
          openCallId={openCallId ?? null}
          phone={phone}
          templates={templates}
          searchLeads={searchLeadsToJoin.bind(null, lead.id)}
          moveAction={moveCallToLead}
          deleteAction={deleteCall}
          createAction={createFromCall}
        />
      </div>
    </>
  );
}
