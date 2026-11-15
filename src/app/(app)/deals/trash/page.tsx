import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { restoreDeal, emptyTrash } from "../bulk-actions";
import EmptyTrashButton from "@/components/EmptyTrashButton";

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function DealsTrashPage() {
  const workspaceId = await requireWorkspaceId();
  const { where: visibility } = await dealVisibilityFilter();

  const deals = await prisma.deal.findMany({
    where: { workspaceId, ...visibility, trashedAt: { not: null } },
    include: { client: true },
    orderBy: { trashedAt: "desc" },
  });

  return (
    <>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <Link href="/leads" className="text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
            ← Leads
          </Link>
          <h1 className="mt-1 text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Trash</h1>
          <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
            {deals.length === 0 ? "Deleted proposals and contracts wait here." : `${deals.length} deleted ${deals.length === 1 ? "proposal or contract" : "proposals and contracts"}. Restore one to put it back on its lead, or empty the trash to delete them for good.`}
          </div>
        </div>
        {deals.length > 0 && <EmptyTrashButton action={emptyTrash} count={deals.length} />}
      </div>

      <div className="glass-card glass-card-solid card-hover overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-collapse">
          <thead>
            <tr>
              <th className="border-b px-5 py-3 text-left text-[11.5px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}>Document</th>
              <th className="border-b px-5 py-3 text-left text-[11.5px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}>Value</th>
              <th className="border-b px-5 py-3 text-left text-[11.5px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}>Trashed</th>
              <th className="border-b px-5 py-3" style={{ borderColor: "var(--hairline)" }} />
            </tr>
          </thead>
          <tbody>
            {deals.map((deal) => (
              <tr key={deal.id} className="row-hover transition-colors">
                <td className="border-b px-5 py-3" style={{ borderColor: "var(--hairline-soft)" }}>
                  <span className="flex flex-col gap-0.5">
                    <span className="font-medium" style={{ color: "var(--ink)" }}>{deal.kind === "proposal" ? "Proposal" : "Contract"} · {deal.client.name}</span>
                    <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{deal.service}</span>
                  </span>
                </td>
                <td className="font-mono-tab border-b px-5 py-3 font-semibold" style={{ borderColor: "var(--hairline-soft)", color: "var(--ink)" }}>
                  {deal.feeDisplay}
                </td>
                <td className="border-b px-5 py-3 text-[12.5px]" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline-soft)" }}>
                  {deal.trashedAt ? timeAgo(deal.trashedAt) : "-"}
                </td>
                <td className="border-b px-5 py-3 text-right" style={{ borderColor: "var(--hairline-soft)" }}>
                  <form action={restoreDeal.bind(null, deal.id)}>
                    <button type="submit" className="btn btn-secondary btn-sm">Restore</button>
                  </form>
                </td>
              </tr>
            ))}
            {deals.length === 0 && (
              <tr>
                <td colSpan={4} className="px-5 py-10 text-center text-[13px]" style={{ color: "var(--ink-muted)" }}>
                  Trash is empty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
    </>
  );
}
