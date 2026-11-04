"use client";

import { useState } from "react";

// The real name (with any accented letters) comes in the UTF-8 filename*,
// the plain filename is only an ASCII fallback.
function filenameFrom(disposition: string): string {
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Malformed: fall back to the plain one below.
    }
  }
  return disposition.match(/filename="([^"]+)"/)?.[1] ?? "contract.pdf";
}

export default function DownloadContractButton({ contractId, className }: { contractId: string; className?: string }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/contracts/${contractId}/pdf`);
      if (!res.ok) throw new Error("Failed to download contract");
      const filename = filenameFrom(res.headers.get("content-disposition") ?? "");

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
