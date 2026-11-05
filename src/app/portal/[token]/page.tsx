import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import BrandLogo from "@/components/BrandLogo";
import DownloadContractButton from "@/components/DownloadContractButton";
import { parseContractSnapshot } from "@/lib/contract-snapshot";

// partially_signed: the client has signed and someone after them (a
// counter-signer) still has to.
const STATUS_LABEL: Record<string, string> = {
  sent: "Awaiting your signature",
  partially_signed: "Waiting on counter-signature",
  signed: "Signed",
};

const STATUS_CHIP: Record<string, string> = {
  sent: "chip-warn",
  partially_signed: "chip-active",
  signed: "chip-success",
};

export default async function ClientPortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const client = await prisma.client.findUnique({
    where: { portalToken: token },
    include: {
      workspace: true,
      deals: {
        include: { contract: true, template: true },
        orderBy: { updatedAt: "desc" },
      },
    },
  });
  if (!client) notFound();

  // Drafts and internal-approval states aren't this client's business yet —
  // only show agreements that have actually reached them.
  const visibleDeals = client.deals.filter((d) => d.contract && ["sent", "partially_signed", "signed"].includes(d.contract.status));

  return (
    <div className="sm-theme min-h-screen" style={{ background: "var(--canvas)" }}>
      <header className="border-b px-6 py-4" style={{ borderColor: "var(--hairline)" }}>
        <div className="mx-auto flex max-w-[720px] items-center gap-2.5">
          {client.workspace.logoImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={client.workspace.logoImage} alt={client.workspace.name} style={{ height: 28, maxWidth: 160, objectFit: "contain" }} />
          ) : (
            <>
              <div
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] font-display text-[14px] font-semibold"
                style={{ background: "var(--primary)", color: "var(--on-primary)" }}
              >
                S
              </div>
              <span className="text-[14px] font-medium">{client.workspace.name}</span>
            </>
          )}
          <span style={{ color: "var(--ink-muted)" }}>·</span>
          <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>via</span>
          <BrandLogo height={13} className="opacity-70" />
        </div>
      </header>

      <main className="mx-auto max-w-[720px] px-6 py-10">
        <div className="mb-6">
          <h1 className="text-[22px] font-medium" style={{ letterSpacing: "-0.6px" }}>Your agreements with {client.workspace.name}</h1>
          <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>{client.name}{client.company && client.company !== client.name ? ` · ${client.company}` : ""}</div>
        </div>

        {visibleDeals.length === 0 ? (
          <div className="card px-5 py-10 text-center text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
            Nothing here yet. Agreements will appear once they&apos;re sent to you.
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {visibleDeals.map((deal) => {
              const contract = deal.contract!;
              return (
                <div key={deal.id} className="card p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-[15px] font-medium">{parseContractSnapshot(contract.snapshot)?.templateName ?? deal.template?.name ?? deal.service}</div>
                      <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{deal.service} · {deal.feeDisplay}</div>
                    </div>
                    <span className={`chip ${STATUS_CHIP[contract.status] ?? "chip-neutral"}`}>
                      <span className="chip-dot" />
                      {STATUS_LABEL[contract.status] ?? contract.status}
                    </span>
                  </div>

                  {contract.status === "signed" && contract.renewalDate && (
                    <div className="mt-3 rounded-[8px] px-3 py-2.5 text-[12.5px]" style={{ background: "var(--surface-2)" }}>
                      {contract.autoRenews ? "Renews" : "Ends"} {contract.renewalDate.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
                      {contract.renewalNote ? ` - ${contract.renewalNote}` : ""}
                    </div>
                  )}

                  <div className="mt-3.5 flex flex-wrap gap-2.5">
                    {/* A DocuSign contract is signed from DocuSign's own email. */}
                    {contract.status === "sent" && contract.deliveryMethod === "sealme" && (
                      <a href={`/sign/${contract.id}`} className="btn btn-primary btn-sm">
                        Review &amp; sign
                      </a>
                    )}
                    <DownloadContractButton contractId={contract.id} className="btn btn-secondary btn-sm" />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
