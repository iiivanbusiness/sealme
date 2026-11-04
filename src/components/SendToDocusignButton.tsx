"use client";

import { useState, useTransition } from "react";

// onStart: the page keeps this card up after the send moves the deal out of
// the state that offered it, so the result stays on screen.
export default function SendToDocusignButton({
  dealId,
  sendAction,
  onStart,
}: {
  dealId: string;
  sendAction: (dealId: string) => Promise<{ error?: string; heldForReviewBy?: string }>;
  onStart?: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [heldForReviewBy, setHeldForReviewBy] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    onStart?.();
    startTransition(async () => {
      const result = await sendAction(dealId);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.heldForReviewBy) {
        setHeldForReviewBy(result.heldForReviewBy);
        return;
      }
      setSent(true);
    });
  }

  // A review chain caught it: nothing reached the client yet.
  if (heldForReviewBy) {
    return (
      <div className="card flex items-center gap-2 px-5 py-4 text-[13.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
        Held for review by {heldForReviewBy}, not sent yet
      </div>
    );
  }

  if (sent) {
    return (
      <div className="card flex items-center gap-2 px-5 py-4 text-[13.5px] font-medium" style={{ color: "var(--success)" }}>
        ✓ Sent to DocuSign
      </div>
    );
  }

  return (
    <div className="card flex flex-col gap-2 p-5">
      {error && (
        <div className="rounded-[8px] px-3 py-2 text-[12px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          {error}
        </div>
      )}
      <button type="button" disabled={isPending} onClick={handleClick} className="btn btn-primary w-full justify-center">
        {isPending ? "Sending…" : "Send via DocuSign now"}
      </button>
      <span className="text-center text-[12px]" style={{ color: "var(--ink-muted)" }}>
        Sends immediately with a standard message. Client signs on DocuSign, right while you&apos;re still on the call.
      </span>
    </div>
  );
}
