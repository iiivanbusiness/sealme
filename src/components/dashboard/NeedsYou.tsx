import type { ReactNode } from "react";
import Link from "next/link";
import SendReminderButton from "@/components/dashboard/SendReminderButton";
import type { NeedsYouData } from "@/lib/dashboard-data";

const plural = (v: number, one: string, many: string) => `${v.toLocaleString("en-US")} ${v === 1 ? one : many}`;
const line = { borderTop: "1px solid var(--hairline-soft)" };

// One thing the viewer has to do: what and for whom, a line of detail, and
// the one button that does it. On a phone the button goes under the text.
function Row({ title, href, detail, chip, action }: { title: string; href: string; detail?: string; chip?: { label: string; cls: string }; action: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5" style={line}>
      <div className="min-w-0 flex-1 basis-[220px]">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={href} className="truncate text-[14px] font-medium" style={{ color: "var(--ink)" }} title={title}>
            {title}
          </Link>
          {chip && <span className={`chip flex-none ${chip.cls}`}>{chip.label}</span>}
        </div>
        {detail && <div className="mt-0.5 truncate text-[12.5px]" style={{ color: "var(--ink-muted)" }} title={detail}>{detail}</div>}
      </div>
      <div className="flex-none">{action}</div>
    </div>
  );
}

function More({ count, what }: { count: number; what: string }) {
  if (count <= 0) return null;
  return (
    <div className="px-4 py-2.5 text-[12.5px] sm:px-5" style={{ ...line, color: "var(--ink-muted)" }}>
      and {plural(count, what, `${what}s`)} more
    </div>
  );
}

const linkButton = (href: string, label: string) => (
  <Link href={href} className="btn btn-secondary btn-sm">
    {label}
  </Link>
);

// Needs you: what's waiting on the viewer. Approvals first (a teammate is
// waiting), then proposals quiet for 5 days, contracts to finish and send,
// calls with no name, calls to check, and the phone number if it's missing.
// The to-do list sits right under it as Reminders, with its own header and
// empty state. On the iPhone app the documents aren't asked for
// (dashboardData leaves them out).
export default function NeedsYou({ data, phoneNotice, reminders }: { data: NeedsYouData; phoneNotice: boolean; reminders: ReactNode }) {
  const { approvals, toSend, unnamed, callsToCheck } = data;
  const proposals = data.reminders;
  const count = approvals.length + proposals.rows.length + proposals.more + toSend.rows.length + toSend.more + (unnamed ? 1 : 0) + (callsToCheck ? 1 : 0) + (phoneNotice ? 1 : 0);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <section className="glass-card glass-card-solid flex min-w-0 flex-col overflow-hidden" aria-labelledby="needs-you-title">
        <div className="flex items-baseline gap-2 px-4 pb-3 pt-4 sm:px-5">
          <h2 id="needs-you-title" className="text-[15px] font-medium">Needs you</h2>
          {count > 0 && <span className="text-[12.5px] tabular-nums" style={{ color: "var(--ink-muted)" }}>{count.toLocaleString("en-US")}</span>}
        </div>

        {count === 0 ? (
          <div className="px-4 pb-4 text-[13px] sm:px-5" style={{ color: "var(--ink-muted)" }}>
            Nothing needs you right now.
          </div>
        ) : (
          <>
            {approvals.map((a) => (
              <Row key={`a-${a.dealId}`} title={`Approve the contract for ${a.name}`} href={`/deals/${a.dealId}/contract`} detail={a.service} chip={{ label: "Approval", cls: "chip-warn" }} action={linkButton(`/deals/${a.dealId}/contract`, "Review")} />
            ))}

            {proposals.rows.map((p) => (
              <Row
                key={`p-${p.dealId}`}
                title={`Proposal for ${p.name}`}
                href={`/deals/${p.dealId}`}
                chip={{ label: "No answer", cls: "chip-warn" }}
                detail={[`Quiet for ${plural(p.quietDays, "day", "days")}`, p.opened ? "Opened" : "Not opened", p.to ?? "No email on file"].join(" · ")}
                action={<SendReminderButton dealId={p.dealId} contractId={p.contractId} to={p.to} />}
              />
            ))}
            <More count={proposals.more} what="proposal" />

            {toSend.rows.map((d) => (
              <Row key={`s-${d.dealId}`} title={`Contract for ${d.name}`} href={d.href} detail={d.service} chip={{ label: d.label, cls: d.chip }} action={linkButton(d.href, d.cta)} />
            ))}
            <More count={toSend.more} what="contract" />

            {unnamed && (
              <Row
                title={`${plural(unnamed.count, "call needs", "calls need")} a name`}
                href={unnamed.href}
                detail={`SealMe didn't hear who ${unnamed.count === 1 ? "it was" : "they were"} with. Add their name so the notes land on the right person.`}
                action={linkButton(unnamed.href, unnamed.leads === 1 ? "Add a name" : "Show them")}
              />
            )}

            {callsToCheck > 0 && (
              <Row title={`Check ${plural(callsToCheck, "call", "calls")}`} href="/calls" detail="Pick who it was with, or try again" action={linkButton("/calls", "Open Calls")} />
            )}

            {phoneNotice && (
              <Row title="Add your phone number" href="/settings#phone" detail="One time, takes a minute. Then a tap on Call rings you and connects your client." action={linkButton("/settings#phone", "Add number")} />
            )}
          </>
        )}
      </section>

      {reminders}
    </div>
  );
}
