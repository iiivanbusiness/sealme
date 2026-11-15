import Link from "next/link";
import { prisma } from "@/lib/db";
import { isExtractionConfigured } from "@/lib/extract-deal";
import { requireWorkspaceId } from "@/lib/workspace";
import { isPhoneApp } from "@/lib/phone-app-server";
import { leadAccess } from "@/lib/lead-visibility";
import LocalCaptureForm from "@/components/LocalCaptureForm";
import CallUploadForm from "@/components/CallUploadForm";
import { startCallHref } from "@/lib/start-call";
import { startCallFromTranscript } from "./actions";
import { searchCallLeads, type CallLeadOption } from "@/app/(app)/leads/search-actions";

// Writing up a long call, and the proposal or contract it asks for, run in
// after() within this budget.
export const maxDuration = 300;

const UPLOAD_SUBTITLE = "Upload the recording or paste the transcript. SealMe writes up the notes on the client's lead, and drafts a proposal or contract if you tick one.";

// Start a call: who it's with, what SealMe makes (notes always, a proposal
// or a contract when ticked), then the recording or the transcript. Every
// call lands on a lead. A meeting from the calendar opens it with the
// person filled in: ?lead= picks their lead (when the viewer can see it),
// ?who= types the email or name, and ?name= names a lead made from an email.
export default async function StartCallPage({ searchParams }: { searchParams: Promise<{ mode?: string; error?: string; who?: string; lead?: string; name?: string }> }) {
  const { mode, error, lead: leadParam, ...params } = await searchParams;
  const workspaceId = await requireWorkspaceId();
  const phone = await isPhoneApp();
  const initialLead = typeof leadParam === "string" && leadParam ? await visibleLead(workspaceId, leadParam) : null;
  const who = typeof params.who === "string" ? params.who.trim().slice(0, 200) : "";
  const name = typeof params.name === "string" ? params.name.trim().slice(0, 200) : "";
  // Who it's with, kept when switching between recording live and uploading.
  const person = initialLead ? { leadId: initialLead.id } : { who: who || undefined, name: name || undefined };
  const extractionConfigured = isExtractionConfigured();
  const templates = await prisma.contractTemplate.findMany({ where: { workspaceId }, select: { id: true, name: true, kind: true }, orderBy: { name: "asc" } });
  const byKind = {
    proposal: templates.filter((t) => t.kind === "proposal").map(({ id, name }) => ({ id, name })),
    contract: templates.filter((t) => t.kind !== "proposal").map(({ id, name }) => ({ id, name })),
  };
  const recordHere = mode === "local" && !phone;

  return (
    <>
      <Link href="/dashboard" className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
        ← Dashboard
      </Link>

      <div className="mb-6 max-w-[560px]">
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>
          Start a call
        </h1>
        <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
          {recordHere ? (
            // Only the desktop app records; a browser gets the way to upload
            // instead (see LocalCaptureForm), so it says what it can do.
            // The classes pick one before the first paint (globals.css).
            <>
              <span className="desktop-app-only">SealMe records your system audio for the call. Nothing joins the meeting.</span>
              <span className="browser-only">{UPLOAD_SUBTITLE}</span>
            </>
          ) : phone ? (
            "Add the recording or paste the transcript. SealMe writes up the notes on the client's lead."
          ) : (
            UPLOAD_SUBTITLE
          )}
        </div>
      </div>

      {error && <div className="chip chip-warn mb-4 w-full max-w-[560px] justify-start px-4 py-2.5 text-[12.5px]">{error}</div>}

      {!extractionConfigured ? (
        <div className="card max-w-[560px] p-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
          Call processing isn&apos;t set up yet. It needs an <span className="font-mono-tab">ANTHROPIC_API_KEY</span> in <span className="font-mono-tab">.env</span>.
        </div>
      ) : recordHere ? (
        <LocalCaptureForm templates={byKind} searchLeads={searchCallLeads} who={who || name} name={name} initialLead={initialLead} uploadHref={startCallHref(person, false)} />
      ) : (
        <>
          <CallUploadForm templates={byKind} action={startCallFromTranscript} searchLeads={searchCallLeads} phone={phone} who={who || name} name={name} initialLead={initialLead} />
          {!phone && (
            <div className="not-on-phone-app mt-3 max-w-[560px] text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
              Recording a call on this computer?{" "}
              <Link href={startCallHref(person, true)} className="font-medium" style={{ color: "var(--accent-blue)" }}>
                Record it in the desktop app
              </Link>
            </div>
          )}
        </>
      )}
    </>
  );
}

// The lead ?lead= names, as "Who's on the call?" shows it, when the viewer
// can see it; otherwise the page opens as if it wasn't given.
async function visibleLead(workspaceId: string, id: string): Promise<CallLeadOption | null> {
  const access = await leadAccess();
  const lead = await prisma.lead.findFirst({
    where: { id, workspaceId, AND: [access.where] },
    select: { id: true, name: true, company: true, email: true, isClient: true, _count: { select: { phoneCalls: { where: { status: "processed" } } } } },
  });
  return lead ? { id: lead.id, name: lead.name, company: lead.company, email: lead.email, isClient: lead.isClient, calls: lead._count.phoneCalls } : null;
}
