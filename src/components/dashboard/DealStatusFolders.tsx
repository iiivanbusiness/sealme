import Link from "next/link";
import { dealStatusLabel } from "@/lib/deal-status";
import FolderIcon from "./FolderIcon";

// expired: how many of the "sent" ones have a SealMe sign link that ran out
// (contractExpired in contract-status.ts). They still sit in this folder,
// but the client can't sign them: the caption counts them, and once every
// one has run out the folder stops saying "awaiting signature".
export type StatusCount = { status: string; count: number; expired?: number };

// Finder-style icon grid — the same neutral glass folder for every status
// (see FolderIcon), title + count caption below, exactly like the
// reference's file-type grid. No per-cell chrome or tint — the folder
// graphic itself is the only thing that isn't flat page background.
export default function DealStatusFolders({ counts }: { counts: StatusCount[] }) {
  return (
    // Columns follow the widget's own width (a container query), since on
    // the dashboard it can be resized independently of the window.
    <div className="grid grid-cols-2 gap-1 @sm:grid-cols-4 @3xl:grid-cols-8">
      {counts.map(({ status, count, expired = 0 }) => {
        const empty = count === 0;
        const allExpired = !empty && expired >= count;
        return (
          <Link
            key={status}
            href={`/deals?status=${status}`}
            className="group card-hover flex flex-col items-center gap-2.5 rounded-[14px] px-2 py-4 text-center hover:bg-[var(--surface-1)]"
            style={{ opacity: empty ? 0.45 : 1 }}
          >
            <span className="inline-flex transition-transform duration-150 group-hover:scale-[1.08]">
              <FolderIcon id={status} size={64} />
            </span>
            <div>
              <div className="text-[12.5px] font-medium" style={{ color: "var(--ink)" }}>
                {dealStatusLabel(status, allExpired)}
              </div>
              <div className="text-[11px]" style={{ color: "var(--ink-muted)" }}>
                {count} {count === 1 ? "deal" : "deals"}
              </div>
              {expired > 0 && !allExpired && (
                <div className="text-[11px] font-medium" style={{ color: "var(--warn)" }}>
                  {expired} sign {expired === 1 ? "link" : "links"} expired
                </div>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
