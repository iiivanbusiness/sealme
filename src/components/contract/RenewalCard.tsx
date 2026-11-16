"use client";

import { useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import LocalDateTime from "@/components/LocalDateTime";
import { CardButton } from "./NextCard";
import { renewalCountdown } from "./paper-utils";
import s from "./contract.module.css";

const subscribeNothing = () => () => {};

// Under the next step on a signed contract whose term ends or renews: when,
// how long until then, and Start renewal (a new contract for the same
// client with these terms, opened on its own screen).
export default function RenewalCard({ date, autoRenews, note, startAction }: { date: string; autoRenews: boolean; note: string | null; startAction?: () => void | Promise<void> }) {
  // Days left go by the viewer's clock, so they only show in the browser.
  const isClient = useSyncExternalStore(subscribeNothing, () => true, () => false);
  const countdown = isClient ? renewalCountdown(date) : null;
  return (
    <section className={s.card} aria-label="Renewal">
      <div className={s.cardH}>
        <h3 className={s.cardTitle}>Renewal</h3>
        {countdown?.label && (
          <span className={`chip flex-none ${countdown.soon ? "chip-warn" : "chip-neutral"}`} style={{ fontSize: 11 }}>
            {countdown.label}
          </span>
        )}
      </div>
      <p className={s.renewWhen}>
        {autoRenews ? "Auto-renews" : "Term ends"} <LocalDateTime iso={date} options={{ month: "short", day: "numeric", year: "numeric" }} />
      </p>
      {note && <p className={s.renewNote}>{note}</p>}
      {startAction && (
        <form action={startAction} className={s.renewRow}>
          <StartButton />
        </form>
      )}
    </section>
  );
}

function StartButton() {
  const { pending } = useFormStatus();
  return (
    <CardButton type="submit" busy={pending}>
      {pending ? "Starting..." : "Start renewal"}
    </CardButton>
  );
}
