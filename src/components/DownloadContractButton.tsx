"use client";

import { useState } from "react";
import { filenameFromDisposition } from "@/lib/download-filename";

// `kind` only names the file when the server doesn't say: a proposal
// downloads as proposal.pdf, everything else as contract.pdf. With no
// contractId yet, `prepare` makes the document first (a proposal filled in
// on the contract screen) and gives its id, or says why it couldn't.
export default function DownloadContractButton({
  contractId,
  prepare,
  className,
  kind,
}: {
  contractId: string | null;
  prepare?: () => Promise<{ contractId?: string; error?: string }>;
  className?: string;
  kind?: string | null;
}) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      let id = contractId;
      if (!id) {
        const made = prepare ? await prepare() : { error: "There's no document to download yet." };
        if (!made.contractId) {
          setError(made.error ?? "Couldn't download the PDF. Try again.");
          return;
        }
        id = made.contractId;
      }
      const res = await fetch(`/api/contracts/${id}/pdf`);
      if (!res.ok) throw new Error("Failed to download the PDF");
      const filename = filenameFromDisposition(res.headers.get("content-disposition") ?? "", kind === "proposal" ? "proposal.pdf" : "contract.pdf");

      // Trigger the save via a blob URL instead of navigating to the PDF
      // route directly — some webviews (notably the desktop app) open PDFs
      // in their own built-in viewer on a plain link click, which replaces
      // the page with no way back to the app since that shell has no
      // browser chrome. A blob download never navigates away at all.
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setError("Couldn't download the PDF. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" onClick={handleDownload} disabled={downloading} className={className}>
        {downloading ? "Downloading…" : "Download PDF"}
      </button>
      {error && (
        <span className="text-[11.5px]" style={{ color: "#c0392b" }}>{error}</span>
      )}
    </div>
  );
}
