"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markContractNotSigned } from "@/app/(app)/deals/[id]/not-signed-actions";

// Closes a contract the client won't sign: the sign link stops taking
// signatures (a DocuSign envelope is voided) and the lead moves to Not
// signed. It asks first, since the client can't sign it afterwards; sending
// it again opens it back up. Offered where canMarkNotSigned (deal-status.ts)
// says so: the contract screen's sidebar, and the deal page's Next step card
// (inverted, on its dark background).
export default function MarkNotSignedButton({
  dealId,
  clientName,
  inverted = false,
}: {
  dealId: string;
  clientName: string;
  inverted?: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const firstName = clientName.split(/\s+/)[0] || clientName;
  const muted = inverted ? "var(--on-surface-inverted-muted)" : "var(--ink-muted)";

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await markContractNotSigned(dealId);
        if (result.error) {
          setError(result.error);
          return;
        }
        setConfirming(false);
        router.refresh();
      } catch {
        setError("That didn't go through. Try again.");
      }
    });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {confirming ? (
        <div
          className="flex flex-col gap-2.5 rounded-[10px] px-3 py-2.5 text-[12.5px]"
          style={inverted ? { color: "var(--on-surface-inverted)" } : { border: "1px solid var(--hairline)", background: "var(--canvas)" }}
        >
          <div>Mark as not signed? {firstName} can&apos;t sign it anymore and the lead moves to Not signed. You can send it again later.</div>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending} onClick={confirm} className="btn btn-sm" style={{ background: "#c0392b", color: "#fff" }}>
              {pending ? "Marking…" : "Mark as not signed"}
            </button>
            <button type="button" disabled={pending} onClick={() => setConfirming(false)} className="btn btn-ghost btn-sm" style={{ color: muted }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => (setConfirming(true), setError(null))}
          className="btn btn-ghost w-full justify-center"
          style={{ color: muted }}
        >
          {pending ? "Marking…" : "Mark as not signed"}
        </button>
      )}
      {error && <div className="chip chip-warn w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]">{error}</div>}
    </div>
  );
}
