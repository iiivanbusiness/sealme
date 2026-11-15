import Link from "next/link";
import { daysLabel } from "@/lib/waiting";
import type { WaitingData } from "@/lib/dashboard-data";

const ago = (days: number) => (days <= 0 ? "today" : days === 1 ? "yesterday" : `${days.toLocaleString("en-US")} days ago`);
const line = { borderTop: "1px solid var(--hairline-soft)" };

// Waiting on an answer: every proposal and contract out with a client,
// longest silence on top, with how long it's been quiet (since it went out,
// the last call where they talked, or the last reminder, whichever came
// last; the row says when the last call or reminder was). A client opening
// it isn't an answer, so it only says Opened. On the team's list each row
// says whose it is.
export default function WaitingOnAnswer({ data }: { data: WaitingData }) {
  const { rows, more, team } = data;
  const total = rows.length + more;
  return (
    <section className="glass-card glass-card-solid flex min-w-0 flex-col overflow-hidden" aria-labelledby="waiting-on-an-answer">
      <div className="flex items-baseline gap-2 px-4 pb-3 pt-4 sm:px-5">
        <h2 id="waiting-on-an-answer" className="text-[15px] font-medium">Waiting on an answer</h2>
        {total > 0 && <span className="text-[12.5px] tabular-nums" style={{ color: "var(--ink-muted)" }}>{total.toLocaleString("en-US")}</span>}
        {team && <span className="ml-auto text-[12.5px]" style={{ color: "var(--ink-muted)" }}>Whole team</span>}
      </div>

      {rows.length === 0 ? (
        <div className="px-4 pb-4 text-[13px] sm:px-5" style={{ color: "var(--ink-muted)" }}>
          Nothing is out with a client right now. Proposals and contracts {team ? "the team sends" : "you send"} show here until they get an answer.
        </div>
      ) : (
        <>
          {rows.map((r) => {
            const detail = [
              r.kind === "proposal" ? "Proposal" : "Contract",
              r.service,
              r.calledDays != null ? `Called ${ago(r.calledDays)}` : null,
              r.remindedDays != null ? `Reminded ${ago(r.remindedDays)}` : null,
              r.owner,
            ].filter(Boolean).join(" · ");
            return (
              <Link key={r.dealId} href={`/deals/${r.dealId}`} className="row-hover flex items-center gap-4 px-4 py-3 sm:px-5" style={{ ...line, color: "inherit" }}>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[14px] font-medium" style={{ color: "var(--ink)" }} title={r.name}>{r.name}</span>
                    {r.partlySigned && <span className="chip chip-active flex-none">Partly signed</span>}
                    {r.opened && <span className="chip chip-neutral flex-none">Opened</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px]" style={{ color: "var(--ink-muted)" }} title={detail}>{detail}</div>
                </div>
                <span className="flex-none text-right text-[13px] font-medium tabular-nums" style={{ color: "var(--ink)" }}>{daysLabel(r.days)}</span>
              </Link>
            );
          })}
          {more > 0 && (
            <div className="px-4 py-2.5 text-[12.5px] sm:px-5" style={{ ...line, color: "var(--ink-muted)" }}>
              and {more.toLocaleString("en-US")} more
            </div>
          )}
        </>
      )}
    </section>
  );
}
