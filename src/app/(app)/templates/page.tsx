import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import SubmitButton from "@/components/SubmitButton";
import { createSampleProposalTemplate } from "./actions";

type Kind = "proposal" | "contract";

const TABS: { kind: Kind; label: string; subtitle: string }[] = [
  { kind: "proposal", label: "Proposal templates", subtitle: "SealMe fills these in from the call, and the client reads them" },
  { kind: "contract", label: "Contract templates", subtitle: "SealMe fills these in from the call, and the client signs them" },
];

// Two lists, proposals first. Without ?kind it opens on proposals once the
// workspace has one, else on contracts, which every workspace starts with.
export default async function TemplatesPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind: asked } = await searchParams;
  const workspaceId = await requireWorkspaceId();
  const [all, user] = await Promise.all([
    prisma.contractTemplate.findMany({ where: { workspaceId }, orderBy: { name: "asc" } }),
    currentUserWithRole(),
  ]);
  const byKind: Record<Kind, typeof all> = {
    proposal: all.filter((t) => t.kind === "proposal"),
    contract: all.filter((t) => t.kind !== "proposal"),
  };
  const kind: Kind = asked === "proposal" || asked === "contract" ? asked : byKind.proposal.length ? "proposal" : "contract";
  const templates = byKind[kind];
  const tab = TABS.find((t) => t.kind === kind) ?? TABS[0];
  const canManage = Boolean(user.role?.canManageTemplates);

  const uploadLink = (primary: boolean) => (
    <Link href={`/templates/upload?kind=${kind}`} className={`btn ${primary ? "btn-primary" : "btn-secondary"}`}>
      ⭱ Upload a {kind}
    </Link>
  );
  const newLink = (primary: boolean) => (
    <Link href={`/templates/new?kind=${kind}`} className={`btn ${primary ? "btn-primary" : "btn-secondary"}`}>
      + New template
    </Link>
  );

  return (
    <>
    <div className="mb-5 flex flex-wrap items-baseline justify-between gap-4">
      <div>
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Templates</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>{tab.subtitle}</div>
      </div>
      {canManage && (
        <div className="flex flex-wrap gap-2.5">
          {Boolean(user.role?.canApproveTemplates) && (
            <Link href="/templates/library" className="btn btn-secondary">
              Clause library
            </Link>
          )}
          {/* An empty list offers these in its own empty state. */}
          {templates.length > 0 && (
            <>
              {uploadLink(false)}
              {newLink(true)}
            </>
          )}
        </div>
      )}
    </div>

    <div className="mb-5 inline-flex max-w-full rounded-full p-[3px] text-[12.5px]" style={{ background: "var(--surface-2)" }} role="tablist" aria-label="Template type">
      {TABS.map((t) => {
        const on = t.kind === kind;
        return (
          <Link
            key={t.kind}
            href={`/templates?kind=${t.kind}`}
            scroll={false}
            role="tab"
            aria-selected={on}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 font-medium"
            style={on ? { background: "var(--surface-1)", color: "var(--ink)", boxShadow: "0 0 0 1px var(--hairline)" } : { color: "var(--ink-muted)" }}
          >
            {t.label}
            <span className="font-mono-tab" style={{ color: "var(--ink-muted)" }}>{byKind[t.kind].length}</span>
          </Link>
        );
      })}
    </div>

    {templates.length === 0 ? (
      <div className="glass-card glass-card-solid flex max-w-[560px] flex-col items-start gap-2 p-6">
        <h2 className="text-[16px] font-medium">No {kind} templates yet</h2>
        <p className="text-[13.5px] leading-[1.55]" style={{ color: "var(--ink-muted)" }}>
          {!canManage
            ? "An admin adds templates. Ask yours to add one."
            : kind === "proposal"
              ? "Start from our sample: scope, deliverables, price and timeline, filled in from the call. Or upload a proposal you already send."
              : "Upload a contract you already use, or write one here. SealMe fills it in from the call."}
        </p>
        {canManage && (
          <div className="mt-2 flex flex-wrap gap-2.5">
            {kind === "proposal" && (
              <form action={createSampleProposalTemplate}>
                <SubmitButton className="btn btn-primary" pendingText="Adding the sample…">
                  Start from a sample proposal
                </SubmitButton>
              </form>
            )}
            {uploadLink(kind === "contract")}
            {newLink(false)}
          </div>
        )}
      </div>
    ) : (
      <div className="grid gap-3.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
        {templates.map((tpl) => (
          <Link key={tpl.id} href={`/templates/${tpl.id}`} className="glass-card glass-card-solid card-hover p-[18px]" style={{ color: "inherit" }}>
            <div className="flex items-center gap-1.5">
              <h3 className="text-[15px] font-medium">{tpl.name}</h3>
              {tpl.locked && <span title="Locked - approved wording">🔒</span>}
            </div>
            <div className="mb-2.5 mt-1 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{tpl.description}</div>
            <span className="chip chip-neutral">{tpl.requiredFieldCount} required fields</span>
          </Link>
        ))}
      </div>
    )}
    </>
  );
}
