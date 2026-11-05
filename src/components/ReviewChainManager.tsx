"use client";

import { useState, useTransition } from "react";

// left: the assignee has since left the workspace (SCIM deactivation, or they
// deleted their account), so the step needs someone else.
type Step = { id: string; order: number; assigneeId: string; assigneeName: string; left?: boolean };
type Chain = { id: string; name: string; order: number; teamId: string | null; teamName: string | null; minDealValue: number | null; steps: Step[] };
type TeammateOption = { id: string; name: string };
type TeamOption = { id: string; name: string };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function ChainCard({
  chain,
  index,
  isLast,
  teammates,
  addStepAction,
  removeStepAction,
  moveStepAction,
  moveChainAction,
  deleteChainAction,
}: {
  chain: Chain;
  index: number;
  isLast: boolean;
  teammates: TeammateOption[];
  addStepAction: (chainId: string, formData: FormData) => Promise<{ error?: string }>;
  removeStepAction: (stepId: string) => Promise<{ error?: string }>;
  moveStepAction: (stepId: string, direction: "up" | "down") => Promise<{ error?: string }>;
  moveChainAction: (chainId: string, direction: "up" | "down") => Promise<{ error?: string }>;
  deleteChainAction: (chainId: string) => Promise<{ error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [isPending, startTransition] = useTransition();
  const usedAssigneeIds = new Set(chain.steps.map((s) => s.assigneeId));
  const availableTeammates = teammates.filter((t) => !usedAssigneeIds.has(t.id));

  function run(fn: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="rounded-[10px] border" style={{ borderColor: "var(--hairline-soft)" }}>
      <div className="flex items-center justify-between gap-3 border-b px-3.5 py-3" style={{ borderColor: "var(--hairline-soft)" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13.5px] font-medium">{chain.name}</span>
          {chain.teamName && <span className="chip chip-neutral" style={{ fontSize: 11 }}>{chain.teamName}</span>}
          {chain.minDealValue != null && <span className="chip chip-neutral" style={{ fontSize: 11 }}>≥ €{chain.minDealValue.toLocaleString()}</span>}
          {!chain.teamName && chain.minDealValue == null && <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>Matches any deal</span>}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" disabled={index === 0 || isPending} onClick={() => run(() => moveChainAction(chain.id, "up"))} className="text-[13px]" style={{ color: index === 0 ? "var(--ink-muted)" : "var(--accent-blue)", opacity: index === 0 ? 0.4 : 1 }}>↑</button>
          <button type="button" disabled={isLast || isPending} onClick={() => run(() => moveChainAction(chain.id, "down"))} className="text-[13px]" style={{ color: isLast ? "var(--ink-muted)" : "var(--accent-blue)", opacity: isLast ? 0.4 : 1 }}>↓</button>
          {confirmingDelete ? (
            <span className="flex items-center gap-2">
              <button type="button" disabled={isPending} onClick={() => run(() => deleteChainAction(chain.id))} className="text-[12px] font-medium" style={{ color: "#c0392b" }}>Confirm</button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Cancel</button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>Delete</button>
          )}
        </div>
      </div>

      <div className="px-3.5 py-1">
        {error && (
          <div className="mb-2 mt-2 rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
            {error}
          </div>
        )}

        {chain.steps.length === 0 && (
          <div className="py-3 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            No reviewers yet. Contracts matching this chain send immediately.
          </div>
        )}

        {chain.steps.map((step, i) => (
          <div key={step.id} className="flex items-center justify-between gap-3.5 border-b py-2.5 last:border-b-0" style={{ borderColor: "var(--hairline-soft)" }}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
              <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full text-[10.5px] font-semibold" style={{ background: "var(--surface-2)", color: "var(--ink)" }}>{initials(step.assigneeName)}</span>
              <span className="text-[13px] font-medium">{step.assigneeName}</span>
              {step.left && (
                <span className="chip chip-warn flex-none" style={{ fontSize: 11 }}>
                  No longer on the team
                </span>
              )}
            </div>
            <div className="flex flex-none items-center gap-3">
              <button type="button" disabled={i === 0 || isPending} onClick={() => run(() => moveStepAction(step.id, "up"))} className="text-[12.5px]" style={{ color: i === 0 ? "var(--ink-muted)" : "var(--accent-blue)", opacity: i === 0 ? 0.4 : 1 }}>↑</button>
              <button type="button" disabled={i === chain.steps.length - 1 || isPending} onClick={() => run(() => moveStepAction(step.id, "down"))} className="text-[12.5px]" style={{ color: i === chain.steps.length - 1 ? "var(--ink-muted)" : "var(--accent-blue)", opacity: i === chain.steps.length - 1 ? 0.4 : 1 }}>↓</button>
              <button type="button" disabled={isPending} onClick={() => run(() => removeStepAction(step.id))} className="text-[11.5px] font-medium" style={{ color: "var(--ink-muted)" }}>Remove</button>
            </div>
          </div>
        ))}

        {availableTeammates.length > 0 ? (
          <form action={(formData) => run(() => addStepAction(chain.id, formData))} className="flex items-center gap-2 py-3">
            <select name="assigneeId" className="input flex-1" style={{ fontSize: "12.5px", padding: "7px 10px" }}>
              {availableTeammates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm">Add reviewer</button>
          </form>
        ) : (
          <div className="py-3 text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
            {teammates.length === 0 ? "No teammates in this workspace yet." : "Every teammate is already in this chain."}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReviewChainManager({
  chains,
  teammates,
  teams,
  createChainAction,
  deleteChainAction,
  moveChainAction,
  addStepAction,
  removeStepAction,
  moveStepAction,
}: {
  chains: Chain[];
  teammates: TeammateOption[];
  teams: TeamOption[];
  createChainAction: (formData: FormData) => Promise<{ error?: string }>;
  deleteChainAction: (chainId: string) => Promise<{ error?: string }>;
  moveChainAction: (chainId: string, direction: "up" | "down") => Promise<{ error?: string }>;
  addStepAction: (chainId: string, formData: FormData) => Promise<{ error?: string }>;
  removeStepAction: (stepId: string) => Promise<{ error?: string }>;
  moveStepAction: (stepId: string, direction: "up" | "down") => Promise<{ error?: string }>;
}) {
  const [createError, setCreateError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function runCreate(formData: FormData) {
    setCreateError(null);
    startTransition(async () => {
      const result = await createChainAction(formData);
      if (result.error) setCreateError(result.error);
    });
  }

  return (
    <div className="px-[22px] py-2">
      <div className="mb-2.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
        Checked top to bottom. The first chain whose team and deal-value conditions both match wins. Put more specific rules above a catch-all.
      </div>

      {chains.length === 0 && (
        <div className="py-3 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          No review chains configured. Contracts send as soon as someone clicks &ldquo;Send to client&rdquo;.
        </div>
      )}

      <div className="flex flex-col gap-3 pb-3">
        {chains.map((chain, i) => (
          <ChainCard
            key={chain.id}
            chain={chain}
            index={i}
            isLast={i === chains.length - 1}
            teammates={teammates}
            addStepAction={addStepAction}
            removeStepAction={removeStepAction}
            moveStepAction={moveStepAction}
            moveChainAction={moveChainAction}
            deleteChainAction={deleteChainAction}
          />
        ))}
      </div>

      <div className="border-t pt-3.5" style={{ borderColor: "var(--hairline-soft)" }}>
        {createError && (
          <div className="mb-2 rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
            {createError}
          </div>
        )}
        <form action={runCreate} className="flex flex-wrap gap-2 sm:items-center">
          <input name="name" required placeholder="Chain name, e.g. Enterprise" className="input min-w-0 flex-1 basis-[160px]" style={{ fontSize: "12.5px", padding: "7px 10px" }} />
          <select name="teamId" className="input flex-none" style={{ fontSize: "12.5px", padding: "7px 10px", minWidth: 140 }} defaultValue="">
            <option value="">Any team</option>
            {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input name="minDealValue" type="number" min="0" placeholder="Min € value" className="input flex-none" style={{ fontSize: "12.5px", padding: "7px 10px", width: 120 }} />
          <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm flex-none">+ Add chain</button>
        </form>
      </div>
    </div>
  );
}
