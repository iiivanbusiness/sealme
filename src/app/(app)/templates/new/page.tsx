import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import ClauseEditor from "@/components/ClauseEditor";
import { currentUserWithRole } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { createTemplate } from "../actions";

type Kind = "proposal" | "contract";

const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: "proposal", label: "Proposal", hint: "The client reads it" },
  { kind: "contract", label: "Contract", hint: "The client signs it" },
];

// Copy that follows the Proposal / Contract choice as it's changed, without
// a round trip: both versions are in the page and CSS shows the one that
// matches the checked option.
function ByKind({ proposal, contract }: { proposal: ReactNode; contract: ReactNode }) {
  return (
    <>
      <span className="group-has-[#kind-contract:checked]:hidden">{proposal}</span>
      <span className="hidden group-has-[#kind-contract:checked]:inline">{contract}</span>
    </>
  );
}

export default async function NewTemplatePage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind: asked } = await searchParams;
  const kind: Kind = asked === "proposal" ? "proposal" : "contract";
  const user = await currentUserWithRole();
  if (!user.role?.canManageTemplates) redirect(`/templates?kind=${kind}`);
  const libraryClauses = await prisma.clauseLibraryItem.findMany({ where: { workspaceId: user.workspaceId }, orderBy: { title: "asc" } });

  return (
    <div className="group">
    <Link href={`/templates?kind=${kind}`} className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
      ← Templates
    </Link>

    <div className="mb-6 max-w-[560px]">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>
        <ByKind proposal="New proposal template" contract="New contract template" />
      </h1>
      <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        <ByKind
          proposal="Name it and write what the client reads. SealMe fills in the details from the call."
          contract="Name it and define the clauses. SealMe fills in the terms from the call."
        />
      </div>
    </div>

    <form action={createTemplate} className="card flex max-w-[560px] flex-col gap-4 p-6">
      {/* Picked here once: the kind can't be changed later. */}
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[13px] font-medium">Type</legend>
        <div className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <label key={k.kind} className="flex cursor-pointer items-start gap-2.5 rounded-[10px] border border-[var(--hairline)] px-3 py-2.5 has-[:checked]:border-[var(--accent-blue)]">
              <input type="radio" id={`kind-${k.kind}`} name="kind" value={k.kind} defaultChecked={k.kind === kind} className="mt-[3px]" />
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium">{k.label}</span>
                <span className="block text-[12px]" style={{ color: "var(--ink-muted)" }}>{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>You can&apos;t change this later.</span>
      </fieldset>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Template name</span>
        <input name="name" required placeholder={kind === "proposal" ? "e.g. Website Redesign Proposal" : "e.g. Retainer Agreement"} className="input" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Description</span>
        <input name="description" placeholder="One line describing when to use this template" className="input" />
      </label>

      <ClauseEditor libraryClauses={libraryClauses} />

      <button type="submit" className="btn btn-primary mt-2 w-full justify-center">
        Create template
      </button>
    </form>
    </div>
  );
}
