"use client";

import { useState } from "react";
import { filenameFromDisposition } from "@/lib/download-filename";

export default function AuditTrailButton({ dealId, className }: { dealId: string; className?: string }) {
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    if (downloading) return;
    setDownloading(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${dealId}/audit-trail`);
      if (!res.ok) throw new Error("Failed to export audit trail");
      const filename = filenameFromDisposition(res.headers.get("content-disposition") ?? "", "audit-trail.pdf");

      // Blob download, not a direct link navigation — same reason as the
      // contract PDF button: some webviews (the desktop app) open a PDF in
      // their own viewer on a plain link click, with no way back.
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
      setError("Couldn't export the audit trail. Try again.");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button type="button" onClick={handleDownload} disabled={downloading} className={className}>
        {downloading ? "Exporting…" : "Export audit trail"}
      </button>
      {error && (
        <span className="text-[11.5px]" style={{ color: "#c0392b" }}>{error}</span>
      )}
    </div>
  );
}
