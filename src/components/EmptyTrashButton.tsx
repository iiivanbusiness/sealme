"use client";

import { useState, useTransition } from "react";

export default function EmptyTrashButton({ action, count }: { action: () => Promise<{ deleted: number }>; count: number }) {
  const [confirming, setConfirming] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (!confirming) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirming(true)}>
        Empty trash ({count})
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
        Permanently delete {count} {count === 1 ? "proposal or contract" : "proposals and contracts"}? This can&apos;t be undone.
      </span>
      <button
        type="button"
        disabled={isPending}
        className="btn btn-secondary btn-sm"
        onClick={() => startTransition(async () => { await action(); })}
      >
        {isPending ? "Deleting…" : "Yes, delete permanently"}
      </button>
      <button type="button" className="text-[12.5px] font-medium" style={{ color: "var(--ink-muted)" }} onClick={() => setConfirming(false)}>
        Cancel
      </button>
    </div>
  );
}
