import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { readContractText } from "@/lib/contract-snapshot";
import { clauseNumbers } from "@/lib/contract";
import BrandLogo from "@/components/BrandLogo";
import DownloadContractButton from "@/components/DownloadContractButton";

// The rep is working on it: never sent, or taken back to change. The client
// waits for the new version instead of reading one that's about to change.
const BEING_UPDATED = new Set(["draft", "pending_approval", "changes_requested"]);

// What the client opens from a proposal's link or email. It's only read:
// nothing to sign, nothing to comment on. The first open after it was sent
// is what the rep sees as Viewed.
export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const contract = await prisma.contract.findUnique({
    where: { id },
    include: { deal: { include: { client: true, fields: true, workspace: true } }, template: true },
  });
  // A contract is signed at its own page; a proposal in Trash is gone.
  if (!contract || contract.deal.kind !== "proposal" || contract.deal.trashedAt) notFound();
  // What the client was sent, never the deal's terms or template as they are now.
  const proposal = await readContractText(contract);
  if (!proposal) notFound();
  const numbers = clauseNumbers(proposal.clauses);
  const { workspace } = contract.deal;
  const beingUpdated = BEING_UPDATED.has(contract.status);

  // Only the client's open counts: the rep checking their own link, or a
  // version that isn't out yet, doesn't make it Viewed. updateMany so two
  // tabs opening at once record it once.
  if (contract.status === "sent" && !contract.viewedAt) {
    const session = await auth();
    if (session?.user?.workspaceId !== contract.deal.workspaceId) {
      await prisma.contract.updateMany({ where: { id: contract.id, status: "sent", viewedAt: null }, data: { viewedAt: new Date() } });
    }
  }

  return (
    <div className="sm-theme min-h-screen" style={{ background: "var(--canvas)" }}>
      <header className="border-b px-6 py-4" style={{ borderColor: "var(--hairline)" }}>
        <div className="mx-auto flex max-w-[720px] items-center gap-2.5">
          {workspace.logoImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={workspace.logoImage} alt={workspace.name} style={{ height: 28, maxWidth: 160, objectFit: "contain" }} />
          ) : (
            <>
              <div
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] font-display text-[14px] font-semibold"
                style={{ background: "var(--primary)", color: "var(--on-primary)" }}
              >
                {workspace.name.trim().charAt(0).toUpperCase() || "S"}
              </div>
              <span className="text-[14px] font-medium">{workspace.name}</span>
            </>
          )}
          <span style={{ color: "var(--ink-muted)" }}>·</span>
          <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>via</span>
          <BrandLogo height={13} className="opacity-70" />
        </div>
      </header>

      <main className="mx-auto max-w-[720px] px-6 py-10">
        {beingUpdated ? (
          <div className="chip chip-warn w-full justify-start whitespace-normal px-4 py-3 text-[13.5px]">
            This proposal is being updated. {workspace.name} will send you the new version.
          </div>
        ) : (
          <>
            <div className="card px-5 py-7 md:px-[46px] md:py-[42px]">
              <div className="mb-1.5 text-[22px] font-medium" style={{ letterSpacing: "-0.6px" }}>{proposal.templateName}</div>
              <div className="mb-7 border-b pb-[22px] text-[13.5px]" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline-soft)" }}>
                Prepared for {proposal.clientName} by {proposal.agencyName}
              </div>
              {proposal.clauses.map((clause, i) => (
                <div key={`${i}-${clause.title}`} className="mb-5 max-w-[64ch]">
                  <h3 className="mb-1.5 flex gap-2 text-[14px] font-semibold">
                    {numbers[i] && <span className="font-mono-tab font-normal" style={{ color: "var(--ink-muted)" }}>{numbers[i]}</span>}
                    {clause.title}
                  </h3>
                  <p className="whitespace-pre-line text-[14px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>{clause.body}</p>
                </div>
              ))}
            </div>

            <div className="card mt-5 p-6">
              <h2 className="mb-1 text-[16px] font-medium">Proposal from {workspace.name}</h2>
              <p className="mb-4 text-[13px]" style={{ color: "var(--ink-muted)" }}>
                When you&apos;re ready to go ahead, {workspace.name} will send you the agreement to sign.
              </p>
              <DownloadContractButton contractId={contract.id} kind="proposal" className="btn btn-secondary w-full justify-center" />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
