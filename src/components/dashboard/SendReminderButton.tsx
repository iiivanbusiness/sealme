"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { clientDocumentUrl } from "@/lib/document-links";
import { recordReminderLinkCopied, sendDocumentReminder } from "@/app/(app)/deals/[id]/reminder-actions";

// How long "Reminder sent" stays on the row before the Dashboard refreshes
// and the row leaves Needs you (Waiting on an answer then says "Reminded
// today").
const CONFIRM_MS = 2500;

// Send reminder on a proposal under Needs you: one click emails the client
// (the row shows where it goes), and nothing is sent any other way. A
// client with no email gets Copy link instead, for the rep to send it
// themselves; that counts as the reminder too. The actions don't refresh
// the page themselves, else the row would be gone before the confirmation
// could be read: this does, a moment after the reminder is on the record.
export default function SendReminderButton({ dealId, contractId, to }: { dealId: string; contractId: string; to: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => router.refresh(), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [saved, router]);

  function send() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await sendDocumentReminder(dealId);
        if (result.error) setError(result.error);
        else {
          setDone(true);
          setSaved(true);
        }
      } catch {
        setError("Couldn't send the reminder. Try again in a minute");
      }
    });
  }

  function copy() {
    setError(null);
    // The copy happens in the click itself, so the browser allows it.
    navigator.clipboard
      ?.writeText(clientDocumentUrl(contractId, "proposal"))
      .then(() => {
        setDone(true);
        startTransition(async () => {
          await recordReminderLinkCopied(dealId).catch(() => ({}));
          setSaved(true);
        });
      })
      .catch(() => setError("Couldn't copy the link. Open the proposal and copy it there"));
  }

  return (
    <div className="flex flex-col items-start gap-1.5 sm:items-end">
      {done ? (
        <span className="chip chip-success" role="status">{to ? "Reminder sent" : "Link copied"}</span>
      ) : to ? (
        <button type="button" onClick={send} disabled={pending} className="btn btn-secondary btn-sm">
          {pending ? "Sending…" : "Send reminder"}
        </button>
      ) : (
        <button type="button" onClick={copy} disabled={pending} className="btn btn-secondary btn-sm">
          Copy link
        </button>
      )}
      {error && (
        <span className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-1.5 text-[12px]" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
