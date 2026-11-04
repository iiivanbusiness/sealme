"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import CountersignerFields, { type CountersignerInput } from "./CountersignerFields";
import SentConfirmationCard from "./SentConfirmationCard";

type SendResult = { status: "sent" } | { status: "pending_approval"; assigneeName: string } | { status: "error"; error: string };

// Wraps the manual Send form: submits via the sendContractEmail action
// directly (not a native <form action> redirect) so a successful send can
// show an animated confirmation — naming who it actually went to (the
// client, or the first reviewer if a review chain caught it) — before
// moving on to the contract page, instead of the page just changing out
// from under the rep with no acknowledgment.
export default function SendContractForm({
  dealId,
  configured,
  defaultTo,
  defaultSubject,
  defaultMessage,
  clientName,
  docusignAvailable,
  docusignAccountEmail,
  defaultCc = "",
  defaultDeliveryMethod = "sealme",
  initialSigners,
  sendAction,
}: {
  dealId: string;
  configured: boolean;
  defaultTo: string;
  defaultSubject: string;
  defaultMessage: string;
  clientName: string;
  docusignAvailable: boolean;
  docusignAccountEmail: string | null;
  // Sending again (after changes, or once the link expired) starts from what
  // the last send used, so nobody drops off the CC or the signers unless the
  // rep removes them (say, a signer who declined).
  defaultCc?: string;
  defaultDeliveryMethod?: string;
  initialSigners?: CountersignerInput[];
  sendAction: (dealId: string, formData: FormData) => Promise<SendResult>;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await sendAction(dealId, formData);
      if (res.status === "error") {
        setError(res.error);
        return;
      }
      setResult(res);
      setTimeout(() => router.push(`/deals/${dealId}/contract`), 1600);
    });
  }

  if (result) {
    return (
      <div className="max-w-[560px]">
        <SentConfirmationCard
          title={
            result.status === "pending_approval"
              ? `Sent to ${result.assigneeName} for review`
              : `Sent to ${clientName}`
          }
        />
      </div>
    );
  }

  return (
    <form action={handleSubmit} className="card flex max-w-[560px] flex-col gap-4 p-6">
      {error && (
        <div className="chip chip-warn w-full justify-start px-4 py-2.5 text-[12.5px]">{error}</div>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">To</span>
        <input name="to" type="email" required defaultValue={defaultTo} placeholder="client@company.com" className="input" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">CC <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(optional. Comma-separated, gets a copy but doesn&apos;t sign)</span></span>
        <input name="cc" defaultValue={defaultCc} placeholder="assistant@client.com, ops@yourcompany.com" className="input" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Subject</span>
        <input name="subject" required defaultValue={defaultSubject} className="input" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Message</span>
        <textarea name="message" required rows={7} defaultValue={defaultMessage} className="input" />
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          The sign link is appended below your message automatically.
        </span>
      </label>
      <CountersignerFields clientName={clientName} initialSigners={initialSigners} />
      {docusignAvailable && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Sign via</span>
          <select name="deliveryMethod" defaultValue={defaultDeliveryMethod === "docusign" ? "docusign" : "sealme"} className="input">
            <option value="sealme">SealMe (built-in signing)</option>
            <option value="docusign">DocuSign ({docusignAccountEmail})</option>
          </select>
        </label>
      )}
      <button type="submit" disabled={!configured || isPending} className="btn btn-primary mt-2 w-full justify-center">
        {isPending ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
