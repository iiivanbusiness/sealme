import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { isPhoneApp } from "@/lib/phone-app-server";
import { leadAccess } from "@/lib/lead-visibility";
import { cookieTimeZone } from "@/lib/viewer-time";
import { CALL_OUTCOME_CHIP, CALL_OUTCOME_LABEL } from "@/lib/call-outcomes";
import { SKIP_LABEL, callCostUsd } from "@/lib/call-inbox";
import { formatCallDuration } from "@/lib/recording-upload";
import CallRecordingUploader from "@/components/CallRecordingUploader";
import PendingCallCard from "@/components/PendingCallCard";
import RefreshWhileBusy from "@/components/RefreshWhileBusy";
import ProcessAnywayButton from "@/components/ProcessAnywayButton";
import { addUploadedCall, discardCall, processCall } from "./actions";

// Processing runs in after() on the action's request.
// A sales call reads the terms, drafts the contract and runs two more
// model passes, so it gets the longest window.
export const maxDuration = 300;

const HISTORY_SHOWN = 100;
const SOURCE_LABEL: Record<string, string> = { phone: "Phone", upload: "Upload", desktop: "Desktop", paste: "Pasted", app: "Recorded on iPhone" };

function formatWhen(date: Date, timeZone: string): string {
  return date.toLocaleString("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatUsd(usd: number): string {
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export default async function CallsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const workspace = await requireProspecting();
  const [access, phone] = await Promise.all([leadAccess(), isPhoneApp()]);
  const seesAll = access.canViewAll || access.canAssign;
  const timeZone = await cookieTimeZone();
  const tab = (await searchParams).tab === "history" ? "history" : "pending";
  const callWhere = { workspaceId: workspace.id, ...(seesAll ? {} : { userId: access.userId }) };

  const [pending, history, leads, pendingCount] = await Promise.all([
    tab === "pending"
      ? prisma.phoneCall.findMany({
          where: { ...callWhere, status: { in: ["pending", "processing", "failed"] } },
          select: { id: true, status: true, source: true, transcript: true, telnyxRecordingId: true, durationSec: true, startedAt: true, leadId: true, mode: true, templateId: true, user: { select: { name: true } } },
          orderBy: { startedAt: "desc" },
          take: 100,
        })
      : Promise.resolve([]),
    tab === "history"
      ? prisma.phoneCall.findMany({
          where: { ...callWhere, status: { in: ["processed", "skipped", "discarded"] } },
          select: {
            id: true,
            status: true,
            source: true,
            mode: true,
            templateId: true,
            transcript: true,
            outcome: true,
            summary: true,
            extracted: true,
            durationSec: true,
            sttSeconds: true,
            aiInputTokens: true,
            aiOutputTokens: true,
            aiCostUsd: true,
            telnyxCostUsd: true,
            hubspotCallId: true,
            salesforceTaskId: true,
            startedAt: true,
            dealId: true,
            lead: { select: { id: true, name: true, company: true } },
            user: { select: { name: true } },
          },
          orderBy: { startedAt: "desc" },
          take: HISTORY_SHOWN,
        })
      : Promise.resolve([]),
    tab === "pending"
      ? prisma.lead.findMany({
          where: { workspaceId: workspace.id, AND: [access.where], stage: { not: "converted" } },
          select: { id: true, name: true, company: true, phone: true },
          orderBy: { updatedAt: "desc" },
          take: 2000,
        })
      : Promise.resolve([]),
    prisma.phoneCall.count({ where: { ...callWhere, status: { in: ["pending", "processing", "failed"] } } }),
  ]);

  const tabLink = (key: "pending" | "history", label: string) => (
    <Link
      href={key === "pending" ? "/calls" : "/calls?tab=history"}
      className="btn btn-sm"
      style={tab === key ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
    >
      {label}
    </Link>
  );
  const historyCost = history.reduce((sum, c) => sum + callCostUsd(c), 0);

  return (
    <>
      <div className="mb-4">
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Calls</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
          {seesAll ? "Calls waiting to be processed, and what came of the team's past calls" : "Your calls waiting to be processed, and what came of past ones"}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {tabLink("pending", pendingCount ? `Pending · ${pendingCount}` : "Pending")}
        {tabLink("history", "History")}
      </div>

      {tab === "pending" ? (
        <div className="flex max-w-[760px] flex-col gap-3.5">
          <RefreshWhileBusy busy={pending.some((c) => c.status === "processing")} />
          <CallRecordingUploader addAction={addUploadedCall} />
          {pending.length === 0 ? (
            <div className="card px-6 py-8 text-center text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
              No calls waiting. Calls you make with SealMe on the line show up here when you hang up, and so do recordings you upload above.
            </div>
          ) : (
            pending.map((c) => (
              <PendingCallCard
                key={c.id}
                call={{
                  id: c.id,
                  status: c.status,
                  when: formatWhen(c.startedAt, timeZone),
                  duration: c.durationSec ? formatCallDuration(c.durationSec) : null,
                  source: SOURCE_LABEL[c.source] ?? c.source,
                  rep: seesAll ? (c.user?.name ?? null) : null,
                  transcript: c.transcript ?? "",
                  awaitingTranscript: !c.transcript && Boolean(c.telnyxRecordingId),
                  leadId: c.leadId,
                  mode: c.mode,
                }}
                leads={leads.map((l) => ({ id: l.id, name: l.name, detail: l.company ?? l.phone ?? "" }))}
                processAction={processCall.bind(null, c.id)}
                discardAction={discardCall.bind(null, c.id)}
                notesOnly={phone}
              />
            ))
          )}
        </div>
      ) : history.length === 0 ? (
        <div className="card max-w-[760px] px-6 py-8 text-center text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
          No processed calls yet.
        </div>
      ) : (
        <div className="max-w-[900px]">
          <div className="mb-2 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            {history.length === HISTORY_SHOWN ? `Last ${HISTORY_SHOWN} calls` : `${history.length} ${history.length === 1 ? "call" : "calls"}`} · {formatUsd(historyCost)} in transcription and AI
          </div>
          <div className="card overflow-hidden">
            {history.map((c, i) => {
              const skipped = (c.extracted as { skipped?: string } | null)?.skipped;
              const chip =
                c.status === "processed" && c.mode === "sales"
                  ? { cls: "chip-success", label: phone ? "Sales call" : "Sales call · deal created" }
                  : c.status === "processed" && c.outcome
                  ? { cls: CALL_OUTCOME_CHIP[c.outcome] ?? "chip-neutral", label: CALL_OUTCOME_LABEL[c.outcome] ?? c.outcome }
                  : c.status === "skipped"
                    ? { cls: "chip-neutral", label: `Skipped: ${SKIP_LABEL[skipped ?? ""] ?? "not processed"}` }
                    : { cls: "chip-neutral", label: "Discarded" };
              return (
                <div key={c.id} className="flex flex-col gap-1.5 px-5 py-3.5" style={i ? { borderTop: "1px solid var(--hairline)" } : undefined}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px]">
                    <span className={`chip ${chip.cls}`}>{chip.label}</span>
                    {c.lead ? (
                      <Link href={`/leads/${c.lead.id}`} className="font-medium">
                        {c.lead.name}
                        {c.lead.company ? <span style={{ color: "var(--ink-muted)" }}> · {c.lead.company}</span> : null}
                      </Link>
                    ) : (
                      <span style={{ color: "var(--ink-muted)" }}>No lead</span>
                    )}
                    <span className="ml-auto text-[12px] tabular-nums" style={{ color: "var(--ink-muted)" }}>
                      {[formatWhen(c.startedAt, timeZone), c.durationSec ? formatCallDuration(c.durationSec) : null, SOURCE_LABEL[c.source] ?? c.source, seesAll ? c.user?.name : null, callCostUsd(c) > 0 ? formatUsd(callCostUsd(c)) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </div>
                  {c.summary && <div className="text-[13px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>{c.summary}</div>}
                  {c.mode === "sales" && c.dealId && !phone && (
                    <div>
                      <Link href={`/deals/${c.dealId}`} className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
                        Open the deal →
                      </Link>
                    </div>
                  )}
                  {(c.hubspotCallId || c.salesforceTaskId) && (
                    <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
                      Logged in {[c.hubspotCallId ? "HubSpot" : null, c.salesforceTaskId ? "Salesforce" : null].filter(Boolean).join(" and ")}
                    </div>
                  )}
                  {c.status === "skipped" && c.lead && c.transcript && (c.mode === "cold" || c.mode === "sales") && (
                    <div>
                      <ProcessAnywayButton action={processCall.bind(null, c.id, { leadId: c.lead.id, mode: c.mode, templateId: c.templateId, force: true })} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
