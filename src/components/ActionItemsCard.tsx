"use client";

import { useState, useTransition } from "react";

type ActionItem = {
  id: string;
  description: string;
  ownerType: string; // team | client
  dueDate: Date | null;
  status: string; // open | done
  sourceQuote: string | null;
};

// A fixed locale: the server renders this first, and the browser's own
// locale ("14 Nov" vs "Nov 14") would make the page fail to hydrate.
function formatDue(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Due dates are calendar days (stored at midnight UTC), so an item is late
// only once its whole day has passed on the viewer's clock. today is that
// day (YYYY-MM-DD), worked out on the server so both renders agree.
export function isOverdue(date: Date, today: string): boolean {
  return date.toISOString().slice(0, 10) < today;
}

export default function ActionItemsCard({
  dealId,
  items,
  today,
  toggleAction,
}: {
  dealId: string;
  items: ActionItem[];
  // The viewer's current day, YYYY-MM-DD.
  today: string;
  toggleAction: (dealId: string, itemId: string) => Promise<{ error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [openQuote, setOpenQuote] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // The parent only refreshes `items` from its live-call poll, so after a
  // toggle this card is the source of truth; new items from a poll still
  // replace it. Toggles show instantly and flip back if the save fails.
  const [localItems, setLocalItems] = useState(items);
  const [syncedItems, setSyncedItems] = useState(items);
  if (items !== syncedItems) {
    setSyncedItems(items);
    setLocalItems(items);
  }

  function flip(itemId: string) {
    setLocalItems((prev) => prev.map((i) => (i.id === itemId ? { ...i, status: i.status === "done" ? "open" : "done" } : i)));
  }

  function toggle(itemId: string) {
    setError(null);
    flip(itemId);
    startTransition(async () => {
      const result = await toggleAction(dealId, itemId);
      if (result.error) {
        flip(itemId);
        setError(result.error);
      }
    });
  }

  const open = localItems.filter((i) => i.status !== "done");
  const doneItems = localItems.filter((i) => i.status === "done");
  const ordered = [...open, ...doneItems];

  if (localItems.length === 0) return null;

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">Action items</h2>
        {open.length > 0 && (
          <span className="chip chip-neutral" style={{ fontSize: 11 }}>{open.length} open</span>
        )}
      </div>
      {error && (
        <div className="mx-5 mt-3 rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          {error}
        </div>
      )}
      <div className="px-5 py-1.5">
        {ordered.map((item) => {
          const done = item.status === "done";
          const overdue = !done && item.dueDate && isOverdue(item.dueDate, today);
          return (
            <div key={item.id} className="border-b py-3 last:border-b-0" style={{ borderColor: "var(--hairline-soft)" }}>
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  onClick={() => toggle(item.id)}
                  className="mt-0.5 flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] text-[11px]"
                  style={{
                    border: `1.5px solid ${done ? "var(--accent-blue)" : "var(--hairline)"}`,
                    background: done ? "var(--accent-blue)" : "transparent",
                    color: "#fff",
                  }}
                  title={done ? "Mark as open" : "Mark as done"}
                >
                  {done ? "✓" : ""}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className="text-[13.5px]"
                      style={{ color: done ? "var(--ink-muted)" : "var(--ink)", textDecoration: done ? "line-through" : "none" }}
                    >
                      {item.description}
                    </span>
                    <span className="chip chip-neutral flex-none" style={{ fontSize: 10.5 }}>
                      {item.ownerType === "client" ? "Client" : "Team"}
                    </span>
                    {item.sourceQuote && (
                      <button
                        onClick={() => setOpenQuote(openQuote === item.id ? null : item.id)}
                        title="Show source"
                        className="flex h-[16px] w-[16px] flex-none items-center justify-center rounded-[5px] text-[10.5px]"
                        style={{ color: "var(--ink-muted)" }}
                      >
                        ⓘ
                      </button>
                    )}
                  </div>
                  {item.dueDate && (
                    <div className="mt-0.5 text-[11.5px]" style={{ color: overdue ? "#c0392b" : "var(--ink-muted)" }}>
                      {overdue ? "Overdue. Was due" : "Due"} {formatDue(item.dueDate)}
                    </div>
                  )}
                  {item.sourceQuote && openQuote === item.id && (
                    <blockquote
                      className="mt-2 rounded-r-[8px] py-2 pl-3 pr-3 text-[12px] italic"
                      style={{ borderLeft: "2px solid var(--accent-blue)", background: "var(--surface-2)", color: "var(--ink-muted)" }}
                    >
                      {item.sourceQuote}
                    </blockquote>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
