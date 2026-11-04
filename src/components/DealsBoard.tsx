"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type BoardDeal = {
  id: string;
  clientName: string;
  service: string;
  feeDisplay: string;
  updatedAgo: string;
  // Sent, but the SealMe sign link ran out: it needs sending again.
  linkExpired?: boolean;
};

const DRAGGABLE_STATUSES = new Set(["processing", "missing_info", "changes_requested", "ready"]);

const COLUMNS = ["processing", "missing_info", "extraction_failed", "ready", "pending_approval", "changes_requested", "sent", "signed"] as const;
const COLUMN_LABEL: Record<string, string> = {
  processing: "Analyzing",
  missing_info: "Missing info",
  extraction_failed: "Couldn't process",
  ready: "Ready",
  pending_approval: "Awaiting approval",
  changes_requested: "Changes requested",
  sent: "Sent",
  signed: "Signed",
};

// Native HTML5 drag-and-drop — no library needed. Only columns in
// DRAGGABLE_STATUSES accept a drop: everything past "ready" (sent,
// pending_approval, signed, extraction_failed) is the result of a real
// action elsewhere (an approval resolving, an email actually sent, a
// signature actually captured) and stays reachable only through that
// action — see updateDealStatus's own matching guard, this is just the
// UI half of the same rule so a rejected drop shows immediately instead
// of round-tripping to find out.
export default function DealsBoard({
  byColumn,
  updateStatusAction,
}: {
  byColumn: Record<string, BoardDeal[]>;
  updateStatusAction: (dealId: string, status: string) => Promise<{ error?: string }>;
}) {
  const router = useRouter();
  const [columns, setColumns] = useState(byColumn);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function moveDeal(dealId: string, sourceCol: string, targetCol: string) {
    if (sourceCol === targetCol || !DRAGGABLE_STATUSES.has(sourceCol) || !DRAGGABLE_STATUSES.has(targetCol)) return;

    // Optimistic move — snap back on failure.
    const previous = columns;
    const deal = columns[sourceCol].find((d) => d.id === dealId)!;
    setColumns({
      ...columns,
      [sourceCol]: columns[sourceCol].filter((d) => d.id !== dealId),
      [targetCol]: [deal, ...columns[targetCol]],
    });
    setError(null);
    startTransition(async () => {
      const result = await updateStatusAction(dealId, targetCol);
      if (result.error) {
        setColumns(previous);
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function handleDrop(targetCol: string) {
    setDragOverCol(null);
    if (!draggingId || !DRAGGABLE_STATUSES.has(targetCol)) return;
    const dealId = draggingId;
    setDraggingId(null);

    let sourceCol: string | null = null;
    for (const [col, deals] of Object.entries(columns)) {
      if (deals.some((d) => d.id === dealId)) sourceCol = col;
    }
    if (!sourceCol) return;
    moveDeal(dealId, sourceCol, targetCol);
  }

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <div className="chip chip-warn max-w-full whitespace-normal break-words px-3.5 py-2 text-[12.5px]">{error}</div>
      )}
      <div
        className="flex gap-3.5 overflow-x-auto pb-2"
        style={{
          scrollSnapType: "x proximity",
          scrollPadding: "0 20px",
          // Fades the edge columns toward transparent instead of slicing them
          // off mid-card when the row is scrolled — a visual cue that there's
          // more to either side, rather than looking like clipped/broken layout.
          maskImage: "linear-gradient(to right, transparent 0, black 20px, black calc(100% - 20px), transparent 100%)",
          WebkitMaskImage: "linear-gradient(to right, transparent 0, black 20px, black calc(100% - 20px), transparent 100%)",
        }}
      >
        {COLUMNS.map((col) => {
          const colDeals = columns[col] ?? [];
          const droppable = DRAGGABLE_STATUSES.has(col);
          return (
            <div
              key={col}
              onDragOver={(e) => {
                if (!droppable) return;
                e.preventDefault();
                setDragOverCol(col);
              }}
              onDragLeave={() => setDragOverCol((c) => (c === col ? null : c))}
              onDrop={() => handleDrop(col)}
              className="flex w-[240px] flex-none flex-col gap-2.5 rounded-[14px] p-1.5 transition-colors"
              style={{ background: dragOverCol === col ? "var(--surface-2)" : "transparent", scrollSnapAlign: "start" }}
            >
              <div className="flex items-center justify-between px-1">
                <span className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
                  {COLUMN_LABEL[col]}
                </span>
                <span className="font-mono-tab text-[11.5px]" style={{ color: "var(--ink-muted)" }}>{colDeals.length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {colDeals.map((deal) => (
                  <Link
                    key={deal.id}
                    href={`/deals/${deal.id}`}
                    draggable={droppable}
                    onDragStart={(e) => {
                      if (!droppable) {
                        e.preventDefault();
                        return;
                      }
                      setDraggingId(deal.id);
                    }}
                    onDragEnd={() => setDraggingId(null)}
                    className="glass-card glass-card-solid card-hover flex flex-col gap-1 p-3.5"
                    style={{ color: "inherit", cursor: droppable ? "grab" : "pointer", opacity: draggingId === deal.id ? 0.4 : 1 }}
                  >
                    <span className="text-[13px] font-medium">{deal.clientName}</span>
                    <span className="truncate text-[12px]" style={{ color: "var(--ink-muted)" }}>{deal.service || "—"}</span>
                    {deal.linkExpired && (
                      <span className="chip chip-warn mt-1 w-fit" style={{ fontSize: 11 }}>
                        <span className="chip-dot" />
                        Sign link expired
                      </span>
                    )}
                    <div className="mt-1 flex items-center justify-between">
                      <span className="font-mono-tab text-[12px] font-medium">{deal.feeDisplay || "—"}</span>
                      <span className="text-[11px]" style={{ color: "var(--ink-muted)" }}>{deal.updatedAgo}</span>
                    </div>
                    {droppable && (
                      // Native HTML5 drag-and-drop (the desktop interaction
                      // above) never fires on touch — there's no mouse to
                      // hold — so a phone has no way to move a card between
                      // columns without this. md:hidden keeps it out of the
                      // way on desktop, where dragging already works.
                      <select
                        className="input md:hidden"
                        style={{ fontSize: "11.5px", padding: "5px 8px", marginTop: 2 }}
                        value=""
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          e.stopPropagation();
                          const target = e.target.value;
                          if (target) moveDeal(deal.id, col, target);
                        }}
                      >
                        <option value="" disabled>Move to…</option>
                        {[...DRAGGABLE_STATUSES].filter((s) => s !== col).map((s) => (
                          <option key={s} value={s}>{COLUMN_LABEL[s]}</option>
                        ))}
                      </select>
                    )}
                  </Link>
                ))}
                {colDeals.length === 0 && (
                  <div className="rounded-[12px] px-3 py-4 text-center text-[12px]" style={{ border: "1px dashed var(--hairline)", color: "var(--ink-muted)" }}>
                    Empty
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
