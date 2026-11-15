"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreDeal } from "@/app/(app)/deals/bulk-actions";

// Puts a proposal or contract back from the trash, the same as Restore on
// the Trash page, from the page the rep is already looking at. Nothing goes
// out from the trash, so this is offered where Send would be. The page
// refreshes in place: restoreDeal only refreshes Leads and Trash.
export default function RestoreFromTrashButton({
  dealId,
  inverted = false,
}: {
  dealId: string;
  // On the deal page's dark Next step card, styled like its other buttons.
  inverted?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function restore() {
    setError(null);
    startTransition(async () => {
      try {
        await restoreDeal(dealId);
        router.refresh();
      } catch {
        setError("Couldn't restore it. Try again from Trash.");
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={restore}
        className={inverted ? "btn w-full justify-center" : "btn btn-primary w-full justify-center"}
        style={inverted ? { height: 46, fontSize: 15, background: "var(--on-surface-inverted)", color: "var(--surface-inverted)" } : undefined}
      >
        {pending ? "Restoring…" : "Restore"}
      </button>
      {error && <div className="chip chip-warn w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]">{error}</div>}
    </div>
  );
}
