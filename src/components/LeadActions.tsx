"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import MoreMenu, { type MoreMenuItem } from "@/components/MoreMenu";
import LeadJoinPicker, { type JoinPick } from "@/components/LeadJoinPicker";

// The "..." on a lead: Edit details, Merge, Mark as lost, Not now,
// Reactivate, and Delete. Merge and Delete open right under the header,
// where they were asked for.
export default function LeadActions({
  leadName,
  calls,
  editHref,
  can,
  searchLeads,
  mergeAction,
  lostAction,
  notNowAction,
  reactivateAction,
  deleteAction,
}: {
  leadName: string;
  calls: number;
  editHref: string;
  // Which of Mark as lost, Not now and Reactivate fit where the lead is (none for a client).
  can: { lose: boolean; notNow: boolean; reactivate: boolean };
  searchLeads: (q: string) => Promise<JoinPick[]>;
  mergeAction: (targetId: string) => Promise<{ leadId: string }>;
  lostAction: () => Promise<void>;
  notNowAction: () => Promise<void>;
  reactivateAction: () => Promise<void>;
  deleteAction?: () => Promise<{ error?: string }>;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<"merge" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<unknown>) =>
    startTransition(async () => {
      setError(null);
      try {
        const result = await action();
        if (result && typeof result === "object" && "error" in result && typeof result.error === "string") setError(result.error);
        else setPanel(null);
      } catch {
        setError("That didn't go through. Try again.");
      }
    });

  const items: MoreMenuItem[] = [
    { label: "Edit details", href: editHref },
    { label: "Merge with another lead", onSelect: () => (setPanel("merge"), setError(null)) },
    ...(can.reactivate ? [{ label: "Reactivate", onSelect: () => run(reactivateAction) }] : []),
    ...(can.notNow ? [{ label: "Not now", onSelect: () => run(notNowAction) }] : []),
    ...(can.lose ? [{ label: "Mark as lost", onSelect: () => run(lostAction) }] : []),
    ...(deleteAction ? [{ label: "Delete lead", danger: true, onSelect: () => (setPanel("delete"), setError(null)) }] : []),
  ];

  return (
    <>
      <MoreMenu items={items} label="More for this lead" />
      {(panel || error) && (
        <div className="order-last w-full basis-full">
          {panel === "merge" && (
            <div className="card flex flex-col gap-2.5 p-4">
              <div className="text-[13.5px] font-medium">Merge {leadName} into another lead</div>
              <LeadJoinPicker
                search={searchLeads}
                confirmText={(pick) => {
                  const target = pick === "new" ? "" : pick.name;
                  const what = calls ? `${calls} ${calls === 1 ? "call" : "calls"}, the proposals and contracts` : "The proposals and contracts";
                  return `${what} from ${leadName} move to ${target}, and ${leadName} is removed. This can't be undone.`;
                }}
                confirmLabel="Merge"
                onConfirm={async (pick) => {
                  if (pick === "new") return;
                  const { leadId } = await mergeAction(pick.id);
                  router.push(`/leads/${leadId}`);
                }}
                onCancel={() => setPanel(null)}
              />
            </div>
          )}
          {panel === "delete" && deleteAction && (
            <div className="card flex flex-col gap-2.5 p-4 text-[13px]">
              <div>Delete {leadName}, their calls and notes? Draft proposals and contracts go to the trash. This can&apos;t be undone.</div>
              {error && <div className="chip chip-warn w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]">{error}</div>}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const result = await deleteAction();
                      if (!result.error) router.push("/leads?deleted=1");
                      return result;
                    })
                  }
                  className="btn btn-sm"
                  style={{ background: "#c0392b", color: "#fff" }}
                >
                  {pending ? "Deleting…" : "Delete lead"}
                </button>
                <button type="button" disabled={pending} onClick={() => setPanel(null)} className="btn btn-ghost btn-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {!panel && error && <div className="chip chip-warn w-full justify-start whitespace-normal px-3 py-2 text-[12.5px]">{error}</div>}
        </div>
      )}
    </>
  );
}
