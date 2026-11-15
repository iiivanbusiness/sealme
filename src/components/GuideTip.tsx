"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { markGuideSeen } from "@/lib/guide-seen";

// inline: shown next to the thing it's about (by a GuideTip with `at`),
// not at the top of the page.
type Tip = { title: string; body: string; seen?: string; inline?: boolean };

// What each place in the app is for, shown when it's opened from the setup
// guide (?guide=…). Opening a "look at this" step ticks it off in the guide.
function tipFor(guide: string, pathname: string): Tip | null {
  const onLead = /^\/leads\/(?!new$|import$)[^/]+$/.test(pathname);
  switch (guide) {
    case "notes":
      return pathname === "/deals/new"
        ? {
            title: "Start a call: the write-up of any call",
            body: "Say who the call was with, drop a recording or video of it, or paste its transcript, and press Write up the call. You get the notes and the next step on the client's lead, the same lead every time you talk to that client.",
          }
        : null;
    case "calls":
      return pathname === "/calls"
        ? {
            title: "Calls: where every call starts",
            body: "Drop a recording or video of a call here, or choose a file. Keep Notes only and press Process. SealMe writes the notes and puts them on the client's lead, the same lead every time you talk to that client.",
          }
        : null;
    case "lead":
      if (onLead) {
        return {
          title: "Everything with this person",
          body: "Every call lands here, newest on top. Open one for its notes, and its proposal or contract: open the one SealMe made, or create one from the call. From the second call on, Where things stand sums them all up. A call on the wrong lead? Use ... on the call to move it.",
          seen: "lead",
        };
      }
      return pathname === "/leads"
        ? { title: "Open a lead to see everything with them", body: "Each lead is one person, with every call you've had and every proposal and contract. Start a call and its lead shows up here." }
        : null;
    case "todo":
      return pathname === "/dashboard"
        ? {
            title: "Your reminders",
            body: "Next steps agreed on a call show up here on their day, in the order your day happens. Tick them off as you go. A manager can switch to the team's list.",
            seen: "todo",
            inline: true,
          }
        : null;
    case "leads":
      return pathname === "/leads"
        ? {
            title: "Leads: everyone you talk to",
            body: "Active is who you're working on. A lead moves on its own as you send a proposal and a contract, and gets a green check when they sign. Lost leads, unsigned contracts and leads with nothing new for 30 days go to Inactive; a new call brings them back.",
            seen: "leads",
          }
        : null;
    case "contracts":
      return pathname === "/deals/new"
        ? {
            title: "Notes and a proposal or contract",
            body: "Tick Proposal or Contract, add the recording or transcript, and press the button. SealMe drafts it from what was agreed, on the template that fits, for you to check before it goes out.",
          }
        : null;
    default:
      return null;
  }
}

// At the top of every page (no `at`), or placed next to what it's about
// (`at` = the guide step, e.g. the reminders on the Dashboard).
export default function GuideTip({ at }: { at?: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const guide = params.get("guide") ?? "";
  const found = guide ? tipFor(guide, pathname) : null;
  const tip = found && (at ? found.inline && at === guide : !found.inline) ? found : null;

  useEffect(() => {
    if (tip?.seen) markGuideSeen(tip.seen);
  }, [tip?.seen]);

  if (!tip) return null;

  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete("guide");
    router.replace(next.size ? `${pathname}?${next.toString()}` : pathname, { scroll: false });
  };

  return (
    <div className="glass-card glass-card-solid mb-4 flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:gap-4 sm:p-5" role="note" aria-label="Setup guide tip">
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] font-semibold uppercase" style={{ letterSpacing: "0.5px", color: "var(--ink-muted)" }}>Setup guide</div>
        <div className="mt-0.5 text-[14.5px] font-medium">{tip.title}</div>
        <div className="mt-1 max-w-[68ch] text-[13px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>{tip.body}</div>
      </div>
      <div className="flex flex-none items-center gap-2">
        <Link href="/dashboard#setup" className="btn btn-secondary btn-sm whitespace-nowrap">
          Back to the guide
        </Link>
        <button type="button" onClick={close} className="btn btn-ghost btn-sm" aria-label="Close the tip">
          Close
        </button>
      </div>
    </div>
  );
}
