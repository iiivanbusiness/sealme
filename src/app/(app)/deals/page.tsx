import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireWorkspace, requireWorkspaceId } from "@/lib/workspace";
import { parseFee } from "@/lib/money";
import DealsBulkTable from "@/components/DealsBulkTable";
import DealsBoard from "@/components/DealsBoard";
import DealsFilterBar from "@/components/DealsFilterBar";
import { bulkRemind, bulkSend, bulkTrash, updateDealStatus } from "./bulk-actions";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { BOARD_COLUMNS, dealStatusChip, dealStatusLabel } from "@/lib/deal-status";
import { contractExpired } from "@/lib/contract-status";

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_STATUSES = new Set(["ready", "missing_info"]);

function isDealStale(status: string, updatedAt: Date): boolean {
  return STALE_STATUSES.has(status) && Date.now() - updatedAt.getTime() > STALE_AFTER_MS;
}

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

function ViewTab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="btn btn-sm"
      style={active ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
    >
      {children}
    </Link>
  );
}

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; status?: string; owner?: string }>;
}) {
  const { view, q, status, owner } = await searchParams;
  const isBoard = view === "board";
  const workspaceId = await requireWorkspaceId();
  const { where: visibility, canViewAll } = await dealVisibilityFilter();

  const filterWhere = {
    ...(status ? { status } : {}),
    ...(owner ? { ownerId: owner } : {}),
    ...(q
      ? {
          OR: [
            { client: { name: { contains: q, mode: "insensitive" as const } } },
            { service: { contains: q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [workspace, deals, owners, trashedCount] = await Promise.all([
    requireWorkspace(),
    prisma.deal.findMany({
      where: { workspaceId, ...visibility, ...filterWhere, trashedAt: null },
      select: {
        id: true,
        service: true,
        feeDisplay: true,
        status: true,
        updatedAt: true,
        client: { select: { name: true, email: true } },
        contract: { select: { status: true, deliveryMethod: true, expiresAt: true } },
        owner: { select: { name: true } },
      },
      orderBy: { updatedAt: "desc" },
    }),
    canViewAll ? prisma.user.findMany({ where: { workspaceId }, select: { id: true, name: true }, orderBy: { name: "asc" } }) : Promise.resolve([]),
    prisma.deal.count({ where: { workspaceId, ...visibility, trashedAt: { not: null } } }),
  ]);

  // A sent deal whose sign link ran out reads "Sign link expired" and has
  // nothing to remind the client about: the link in a reminder wouldn't work.
  const expiredDealIds = new Set(deals.filter((deal) => contractExpired(deal.contract)).map((deal) => deal.id));

  const tableRows = deals.map((deal) => ({
    id: deal.id,
    clientName: deal.client.name,
    service: deal.service,
    feeDisplay: deal.feeDisplay,
    feeValue: parseFee(deal.feeDisplay),
    statusLabel: dealStatusLabel(deal.status, expiredDealIds.has(deal.id)),
    statusChip: dealStatusChip(deal.status, expiredDealIds.has(deal.id)),
    updatedAgo: timeAgo(deal.updatedAt),
    updatedAt: deal.updatedAt.getTime(),
    ownerName: deal.owner?.name ?? null,
    isStale: isDealStale(deal.status, deal.updatedAt),
    canRemind: deal.contract?.status === "sent" && !expiredDealIds.has(deal.id) && Boolean(deal.client.email),
    canSend: deal.contract?.status === "draft" && Boolean(deal.client.email),
  }));

  const byColumn: Record<string, { id: string; clientName: string; service: string; feeDisplay: string; updatedAgo: string; linkExpired: boolean }[]> = {};
  for (const col of BOARD_COLUMNS) byColumn[col] = [];
  for (const deal of deals) {
    if (!byColumn[deal.status]) byColumn[deal.status] = [];
    byColumn[deal.status].push({
      id: deal.id,
      clientName: deal.client.name,
      service: deal.service,
      feeDisplay: deal.feeDisplay,
      updatedAgo: timeAgo(deal.updatedAt),
      linkExpired: deal.status === "sent" && expiredDealIds.has(deal.id),
    });
  }

  return (
    <>
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-4">
      <div>
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Deals</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
          {deals.length} {deals.length === 1 ? "deal" : "deals"}. From first call to signed contract
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/deals/trash"
          className="btn btn-sm relative"
          style={{ background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
          title="Trash"
        >
          <TrashIcon />
          {trashedCount > 0 && (
            <span
              className="font-mono-tab absolute -right-1.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 text-[10px] font-semibold"
              style={{ background: "var(--primary)", color: "var(--on-primary)" }}
            >
              {trashedCount}
            </span>
          )}
        </Link>
        <Link href="/deals/new" className="btn btn-primary">
          + Start a call
        </Link>
      </div>
    </div>

    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
        Record any call locally, then let SealMe draft the contract
        {workspace && (
          <span className="ml-2" style={{ color: "var(--ink-muted)" }}>
            · {workspace.callsUsedThisMonth} calls this month
          </span>
        )}
      </div>
      <div className="flex gap-2">
        <ViewTab href="/deals" active={!isBoard}>Table</ViewTab>
        <ViewTab href="/deals?view=board" active={isBoard}>Board</ViewTab>
      </div>
    </div>

    <DealsFilterBar owners={owners} showOwnerFilter={canViewAll} />

    {isBoard ? (
      <DealsBoard byColumn={byColumn} updateStatusAction={updateDealStatus} />
    ) : (
      <DealsBulkTable rows={tableRows} remindAction={bulkRemind} sendAction={bulkSend} trashAction={bulkTrash} showOwnerColumn={canViewAll} />
    )}
    </>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" width="16" height="16">
      <path d="M4 6h12M8 6V4.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V6M6 6l.6 9.4a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L14 6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8.3 9v4.2M11.7 9v4.2" strokeLinecap="round" />
    </svg>
  );
}
