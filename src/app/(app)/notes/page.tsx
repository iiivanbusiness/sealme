import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { isPhoneApp } from "@/lib/phone-app-server";
import { leadAccess } from "@/lib/lead-visibility";
import { workspaceCampaigns } from "@/lib/campaigns";
import { overviewFromCall } from "@/lib/lead-overview";
import { noteLines } from "@/lib/note-lines";
import CallUploadForm from "@/components/CallUploadForm";
import NotesFilterBar from "@/components/NotesFilterBar";
import RefreshWhile from "@/components/RefreshWhile";
import { createNotesFromTranscript } from "../deals/new/actions";
import { searchTodoLeads } from "../leads/task-actions";

// Writing up a call runs after the form is sent (see createNotesFromTranscript);
// a long call's notes can take a while.
export const maxDuration = 300;

const SHOWN = 200;

function secondsAgo(n: number): Date {
  return new Date(Date.now() - n * 1000);
}

function day(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Notes: for teams that only want the write-up of a call. Add a recording or
// transcript at the top and get notes, no contract. Below, only the clients
// that have notes: the same leads as in Leads (one lead per client), just
// the ones with a written-up call, newest first.
export default async function NotesPage({ searchParams }: { searchParams: Promise<{ q?: string; campaign?: string; added?: string }> }) {
  const workspace = await requireProspecting();
  const [access, phone] = await Promise.all([leadAccess(), isPhoneApp()]);
  const { q, campaign, added } = await searchParams;
  const term = q?.trim().slice(0, 100) ?? "";

  const withNotes = { phoneCalls: { some: { status: "processed", notes: { not: null } } } };
  const [leads, total, working, campaigns, justDone] = await Promise.all([
    prisma.lead.findMany({
      where: {
        workspaceId: workspace.id,
        AND: [
          access.where,
          withNotes,
          campaign ? { campaign } : {},
          term ? { OR: [{ name: { contains: term, mode: "insensitive" } }, { company: { contains: term, mode: "insensitive" } }] } : {},
        ],
      },
      select: {
        id: true,
        name: true,
        company: true,
        campaign: true,
        summary: true,
        lastContactedAt: true,
        _count: { select: { phoneCalls: { where: { status: "processed" } } } },
        // The newest call carries "where things stand" (lib/lead-overview.ts).
        phoneCalls: { where: { status: "processed" }, select: { startedAt: true, extracted: true }, orderBy: { startedAt: "desc" }, take: 1 },
      },
      orderBy: [{ lastContactedAt: { sort: "desc", nulls: "last" } }, { updatedAt: "desc" }],
      take: SHOWN,
    }),
    prisma.lead.count({ where: { workspaceId: workspace.id, AND: [access.where, withNotes] } }),
    // This person's calls still being written up, or that didn't make it.
    prisma.phoneCall.findMany({
      where: { workspaceId: workspace.id, userId: access.userId, mode: "notes", status: { in: ["processing", "failed"] } },
      select: { id: true, status: true },
      orderBy: { startedAt: "desc" },
      take: 5,
    }),
    workspaceCampaigns(workspace.id),
    // "Where things stand" is written a few seconds after a call is saved;
    // keep the list fresh until it's there.
    prisma.phoneCall.count({ where: { workspaceId: workspace.id, userId: access.userId, status: "processed", processedAt: { gte: secondsAgo(20) } } }),
  ]);
  const processing = working.filter((c) => c.status === "processing");
  const failed = working.filter((c) => c.status === "failed");

  return (
    <>
      <div className="mb-5">
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Notes</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
          Add a call and get its notes.{phone ? "" : " No deal, no contract."} Every call with a client goes on that client&apos;s file.
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          {phone && (
            <Link href="/record" className="btn record-button max-w-[560px] justify-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: "#fff" }} />
              Record a meeting
            </Link>
          )}
          <CallUploadForm templates={[]} action={createNotesFromTranscript} searchLeads={searchTodoLeads} notesOnly back="/notes" phone={phone} />
          {(processing.length > 0 || failed.length > 0 || added) && (
            <div className="card flex max-w-[560px] flex-col gap-1.5 px-5 py-4 text-[13px]" role="status">
              {(processing.length > 0 || justDone > 0) && <RefreshWhile />}
              {processing.length > 0 ? (
                <>
                  <span className="font-medium">
                    Writing up {processing.length === 1 ? "your call" : `${processing.length} calls`}…
                  </span>
                  <span style={{ color: "var(--ink-muted)" }}>It shows up in the list in a minute or so. You can add the next one meanwhile.</span>
                </>
              ) : (
                added && !failed.length && <span className="font-medium">Notes are saved. The client is at the top of the list.</span>
              )}
              {failed.length > 0 && (
                <span style={{ color: "var(--ink-muted)" }}>
                  {failed.length === 1 ? "One call" : `${failed.length} calls`} couldn&apos;t be written up.{" "}
                  <Link href="/calls" className="font-medium" style={{ color: "var(--accent-blue)" }}>
                    Try again in Calls
                  </Link>
                </span>
              )}
            </div>
          )}
        </div>

        <section aria-labelledby="notes-clients" className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="notes-clients" className="text-[15px] font-medium">
              Clients with notes
              <span className="font-normal" style={{ color: "var(--ink-muted)" }}> · {total.toLocaleString("en-US")}</span>
            </h2>
            <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>Last call first</span>
          </div>
          {total > 0 && <NotesFilterBar campaigns={campaigns} />}

          {leads.length === 0 ? (
            <div className="card px-5 py-6 text-[13px]" style={{ color: "var(--ink-muted)" }}>
              {total === 0 ? "No notes yet. Add a call and its client shows up here, with every call you have with them after that." : "No clients match. Try a different search."}
            </div>
          ) : (
            <div className="card overflow-hidden">
              {leads.map((lead, i) => {
                const latest = lead.phoneCalls[0];
                const overview = lead._count.phoneCalls >= 2 ? overviewFromCall(latest?.extracted) : null;
                const line = overview ? noteLines(overview)[0] : lead.summary;
                const when = lead.lastContactedAt ?? latest?.startedAt ?? null;
                return (
                  <Link
                    key={lead.id}
                    href={`/leads/${lead.id}`}
                    className="row-hover flex flex-col gap-1 px-5 py-3.5"
                    style={{ color: "inherit", ...(i ? { borderTop: "1px solid var(--hairline-soft)" } : {}) }}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[14px]">
                        <span className="font-medium">{lead.name}</span>
                        {lead.company && <span style={{ color: "var(--ink-muted)" }}> · {lead.company}</span>}
                      </span>
                      <span className="flex-none whitespace-nowrap text-[12.5px] tabular-nums" style={{ color: "var(--ink-muted)" }}>
                        {lead._count.phoneCalls} {lead._count.phoneCalls === 1 ? "call" : "calls"}
                        {when ? ` · ${day(when)}` : ""}
                      </span>
                    </div>
                    {lead.campaign && <span className="chip chip-neutral w-fit text-[11.5px]">{lead.campaign}</span>}
                    {line && (
                      <span className="line-clamp-2 break-words text-[12.5px] leading-snug" style={{ color: "var(--ink-muted)" }}>
                        {line}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          )}
          {leads.length === SHOWN && (
            <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Showing the {SHOWN} talked to most recently. Search to find anyone else.</div>
          )}
        </section>
      </div>
    </>
  );
}
