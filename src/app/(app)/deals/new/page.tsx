import Link from "next/link";
import { prisma } from "@/lib/db";
import { isExtractionConfigured } from "@/lib/extract-deal";
import { requireWorkspaceId } from "@/lib/workspace";
import LocalCaptureForm from "@/components/LocalCaptureForm";
import CallUploadForm from "@/components/CallUploadForm";
import SubmitButton from "@/components/SubmitButton";
import { createDeal, createDealFromTranscript, createNotesFromTranscript } from "./actions";
import { searchTodoLeads } from "@/app/(app)/leads/task-actions";

// Extracting terms from an hour-long transcript is one ~15-30s model call;
// the follow-up work, and writing up a notes-only call, run in after()
// within the same budget.
export const maxDuration = 300;

function Field({ label, name, placeholder, required }: { label: string; name: string; placeholder?: string; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <input name={name} placeholder={placeholder} required={required} className="input" />
    </label>
  );
}

function ModeTab({ href, active, className = "", children }: { href: string; active: boolean; className?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={`btn btn-sm whitespace-nowrap ${className}`}
      style={active ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
    >
      {children}
    </Link>
  );
}

export default async function NewDealPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; error?: string }>;
}) {
  const { mode, error } = await searchParams;
  const isManual = mode === "manual";
  const isLocal = mode === "local";
  const isTranscript = !isManual && !isLocal;
  const workspaceId = await requireWorkspaceId();
  const extractionConfigured = isExtractionConfigured();

  const templates = await prisma.contractTemplate.findMany({ where: { workspaceId }, orderBy: { name: "asc" } });

  return (
    <>
    <Link href="/deals" className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
      ← Deals
    </Link>

    <div className="mb-6 max-w-[560px]">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Start a call</h1>
      <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        {isLocal
          ? "SealMe records your system audio for the call. Nothing joins as a visible participant."
          : isManual
            ? "Enter what the call covered and it'll drop straight into the review flow."
            : "Upload the call recording or its transcript. SealMe writes up the call, and drafts the contract if you want one."}
      </div>
    </div>

    <div className="mb-5 flex flex-wrap gap-2">
      <ModeTab href="/deals/new?mode=local" active={isLocal} className="not-on-phone-app">Record locally</ModeTab>
      <ModeTab href="/deals/new" active={isTranscript}>Recording or transcript</ModeTab>
      <ModeTab href="/deals/new?mode=manual" active={isManual}>Enter manually</ModeTab>
    </div>


    {error && (
      <div className="chip chip-warn mb-4 max-w-[560px] w-full justify-start px-4 py-2.5 text-[12.5px]">
        {error}
      </div>
    )}

    {isManual ? (
      <form action={createDeal} className="card flex max-w-[520px] flex-col gap-4 p-6">
        <Field label="Client name" name="clientName" placeholder="Northgate Fitness" required />
        <Field label="Company" name="company" placeholder="Same as client name if blank" />
        <Field label="Client email" name="email" placeholder="hello@client.com" />
        <Field label="Service" name="service" placeholder="Social Media Management" required />
        <Field label="Fee" name="feeDisplay" placeholder="€2,500 / month" required />

        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Template</span>
          <select name="templateId" className="input">
            {templates.map((t) => (
              <option key={t.id} value={t.id} style={{ background: "var(--surface-1)" }}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <SubmitButton className="btn btn-primary mt-2 w-full justify-center" pendingText="Starting…">
          Start processing
        </SubmitButton>
      </form>
    ) : isLocal ? (
      !extractionConfigured ? (
        <div className="card max-w-[560px] p-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
          Local recording isn&apos;t fully set up yet. It needs an <span className="font-mono-tab">ANTHROPIC_API_KEY</span> in{" "}
          <span className="font-mono-tab">.env</span>. Use{" "}
          <Link href="/deals/new?mode=manual" className="font-medium" style={{ color: "var(--accent-blue)" }}>
            manual entry
          </Link>{" "}
          for now.
        </div>
      ) : (
        <LocalCaptureForm templates={templates} />
      )
    ) : !extractionConfigured ? (
      <div className="card max-w-[560px] p-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        Call processing isn&apos;t set up yet. It needs an <span className="font-mono-tab">ANTHROPIC_API_KEY</span> in <span className="font-mono-tab">.env</span>. Use{" "}
        <Link href="/deals/new?mode=manual" className="font-medium" style={{ color: "var(--accent-blue)" }}>
          manual entry
        </Link>{" "}
        for now.
      </div>
    ) : (
      <CallUploadForm
        templates={templates.map((t) => ({ id: t.id, name: t.name }))}
        action={createDealFromTranscript}
        notesAction={createNotesFromTranscript}
        searchLeads={searchTodoLeads}
      />
    )}
    </>
  );
}
