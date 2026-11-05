import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { computeClientRisk } from "@/lib/client-risk";
import { dealStatusChip, dealStatusLabel } from "@/lib/deal-status";
import { contractExpired } from "@/lib/contract-status";
import ClientProfileForm from "@/components/ClientProfileForm";
import { updateClientDetails } from "../actions";

const RISK_LABEL: Record<string, string> = { high: "At risk", watch: "Watch" };
const RISK_CHIP: Record<string, string> = { high: "chip-warn", watch: "chip-neutral" };

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

export default async function ClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workspaceId = await requireWorkspaceId();
  const { where: dealVisibility, canViewAll } = await dealVisibilityFilter();

  const client = await prisma.client.findFirst({
    where: { id, workspaceId },
    include: {
      deals: {
        where: dealVisibility,
        include: {
          actionItems: true,
          contract: { select: { status: true, deliveryMethod: true, expiresAt: true, clauseComments: { select: { resolved: true } } } },
          notes: { orderBy: { createdAt: "desc" } },
        },
        orderBy: { updatedAt: "desc" },
      },
    },
  });

  // A restricted role only reaches a client profile if it can actually see
  // at least one deal with them — same rule the Clients list filters by,
  // so a direct link can't be used to peek at someone else's client.
  if (!client || (!canViewAll && client.deals.length === 0)) notFound();

  const risk = computeClientRisk(client);
  const allNotes = client.deals
    .flatMap((deal) => deal.notes.map((note) => ({ ...note, dealService: deal.service, dealId: deal.id })))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  // A sent deal whose SealMe sign link ran out reads "Sign link expired",
  // same as on the Deals page.
  const expiredDealIds = new Set(client.deals.filter((deal) => deal.status === "sent" && contractExpired(deal.contract)).map((deal) => deal.id));

  return (
    <>
    <div className="mb-2">
      <Link href="/clients" className="text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
        ← Clients
      </Link>
    </div>
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>{client.name}</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>{client.company}</div>
      </div>
      {risk.level !== "none" && (
        <span className={`chip ${RISK_CHIP[risk.level]}`} title={risk.reasons.join(" · ")}>
          {RISK_LABEL[risk.level]}
        </span>
      )}
    </div>

    {risk.level !== "none" && (
      <div className="card mb-4 flex flex-col gap-1 p-4" style={{ borderColor: "var(--warn)" }}>
        {risk.reasons.map((reason) => (
          <div key={reason} className="text-[12.5px]" style={{ color: "var(--warn)" }}>⚠ {reason}</div>
        ))}
      </div>
    )}

    <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-4">
        <div>
          <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>Profile</h2>
          <ClientProfileForm client={client} updateAction={updateClientDetails} />
        </div>

        <div>
          <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
            Deals ({client.deals.length})
          </h2>
          <div className="card overflow-hidden">
            {client.deals.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px]" style={{ color: "var(--ink-muted)" }}>
                No deals with this client yet.
              </div>
            ) : (
              client.deals.map((deal) => (
                <Link
                  key={deal.id}
                  href={`/deals/${deal.id}`}
                  className="row-hover flex items-center justify-between gap-3 border-b px-5 py-3.5 transition-colors last:border-b-0"
                  style={{ borderColor: "var(--hairline-soft)", color: "inherit" }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium">{deal.service || "—"}</div>
                    <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>{timeAgo(deal.updatedAt)}</div>
                  </div>
                  <span className="font-mono-tab flex-none text-[13px] font-medium">{deal.feeDisplay || "—"}</span>
                  <span className={`chip flex-none ${dealStatusChip(deal.status, expiredDealIds.has(deal.id))}`} style={{ fontSize: 11 }}>
                    {dealStatusLabel(deal.status, expiredDealIds.has(deal.id))}
                  </span>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
          Notes across all deals
        </h2>
        <div className="card p-5">
          {allNotes.length === 0 ? (
            <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
              No internal notes yet. Notes left on any deal with this client show up here.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {allNotes.map((note) => (
                <div key={note.id} className="border-b pb-3 last:border-b-0 last:pb-0" style={{ borderColor: "var(--hairline-soft)" }}>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium">{note.authorName}</span>
                    <span className="text-[11px]" style={{ color: "var(--ink-muted)" }}>{timeAgo(note.createdAt)}</span>
                  </div>
                  <p className="text-[13px] leading-relaxed" style={{ whiteSpace: "pre-wrap" }}>{note.body}</p>
                  <Link href={`/deals/${note.dealId}`} className="mt-1 inline-block text-[11.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
                    on {note.dealService || "this deal"}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    </>
  );
}
