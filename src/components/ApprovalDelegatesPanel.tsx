"use client";

import { useState, useTransition } from "react";
import ClientText from "@/components/ClientText";

type Teammate = { id: string; name: string };
type Delegation = { id: string; fromUserId: string; fromName: string; toUserId: string; toName: string; endsAt: string | null };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// endsAt is the end of the picked day in the viewer's own time zone
// (delegation-actions.ts), so it's formatted in the browser: on the server
// (UTC) it can land on the next day and React throws a hydration mismatch.
function Until({ iso }: { iso: string }) {
  return <ClientText text={() => `until ${formatDate(iso)}`} />;
}

export default function ApprovalDelegatesPanel({
  currentUserId,
  teammates,
  delegations,
  isAdmin,
  createDelegationAction,
  revokeDelegationAction,
}: {
  currentUserId: string;
  teammates: Teammate[];
  delegations: Delegation[]; // workspace-wide if isAdmin, otherwise just ones involving the current user
  isAdmin: boolean;
  createDelegationAction: (formData: FormData) => Promise<{ error?: string }>;
  revokeDelegationAction: (delegationId: string) => Promise<{ error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const others = teammates.filter((t) => t.id !== currentUserId);

  function run(fn: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="px-[22px] py-[18px]">
      {error && (
        <div className="mb-2.5 rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          {error}
        </div>
      )}

      {delegations.length === 0 ? (
        <div className="mb-2.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          No active backups{isAdmin ? " in this workspace" : ""}.
        </div>
      ) : (
        <div className="mb-2.5 flex flex-col gap-2">
          {delegations.map((d) => (
            <div key={d.id} className="flex items-center justify-between gap-3 rounded-[8px] px-3 py-2" style={{ background: "var(--surface-2)" }}>
              <div className="text-[12.5px]">
                <span className="font-medium">{d.fromName}</span> → <span className="font-medium">{d.toName}</span>
                <span className="ml-2 text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
                  {d.endsAt ? <Until iso={d.endsAt} /> : "open-ended"}
                </span>
              </div>
              {(isAdmin || d.fromUserId === currentUserId) && (
                <button type="button" disabled={isPending} onClick={() => run(() => revokeDelegationAction(d.id))} className="text-[11.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
                  Revoke
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {others.length > 0 ? (
        <form action={(formData) => run(() => createDelegationAction(formData))} className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center" style={{ borderColor: "var(--hairline-soft)" }}>
          <select name="toUserId" className="input flex-1" style={{ fontSize: "12.5px", padding: "7px 10px" }}>
            {others.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input name="endsAt" type="date" className="input" style={{ fontSize: "12.5px", padding: "7px 10px" }} title="Leave blank for open-ended" />
          <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm flex-none">Delegate my approvals</button>
        </form>
      ) : (
        <div className="border-t pt-3 text-[11.5px]" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline-soft)" }}>
          Invite another teammate first to set up a backup.
        </div>
      )}
    </div>
  );
}
