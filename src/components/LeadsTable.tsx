"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import TaskFields, { todayLocal, viewerTimeZone, type TaskDraft } from "@/components/TaskFields";

export type LeadRow = {
  id: string;
  name: string;
  company: string | null;
  campaign: string | null;
  // One line from the last call, or how to reach them when there's no call yet.
  line: string;
  stageLabel: string;
  stageChip: string;
  isClient: boolean;
  owner: string;
  calls: number; // written-up calls with this lead
  recording: boolean; // the desktop app is recording a call with them right now
  lastContact: string | null; // day of the last call or anything else that happened
};

type AssignInput = TaskDraft & { timezone: string; leadIds: string[]; makeOwner: boolean };

// Columns drop out as the window narrows so the table never runs past the
// card; below md the list switches to stacked rows instead.
const SHOW = {
  line: "hidden lg:table-cell",
  owner: "hidden xl:table-cell",
};

// The green check SealMe puts on a lead once a contract is signed.
export function ClientCheck({ size = 15 }: { size?: number }) {
  return (
    <span role="img" aria-label="Client" title="Client: signed a contract" className="inline-flex flex-none items-center justify-center rounded-full" style={{ width: size, height: size, background: "var(--success, #1f9d55)", color: "#fff" }}>
      <svg viewBox="0 0 12 12" width={size * 0.62} height={size * 0.62} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M2.5 6.2 5 8.5 9.5 3.5" />
      </svg>
    </span>
  );
}

// The same mark the lead's page puts on a call that's being recorded.
function RecordingNow() {
  return (
    <span className="chip chip-success inline-flex flex-none items-center gap-1.5 whitespace-nowrap">
      <span className="inline-flex h-1.5 w-1.5 animate-pulse rounded-full" style={{ background: "currentColor" }} aria-hidden />
      Recording now
    </span>
  );
}

export default function LeadsTable({
  rows,
  showOwner,
  canAssign,
  assignees,
  assignAction,
  deleteAction,
}: {
  rows: LeadRow[];
  showOwner: boolean;
  canAssign: boolean;
  assignees: { id: string; name: string }[];
  assignAction: (input: AssignInput) => Promise<{ created: number }>;
  deleteAction?: (leadIds: string[]) => Promise<{ deleted: number; kept: number }>;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) => {
    setNotice(null);
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const toggleAll = () => {
    setNotice(null);
    setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)));
  };

  const check = (id: string, label: string) =>
    canAssign ? (
      <input type="checkbox" className="h-4 w-4 flex-none" checked={selected.has(id)} onChange={() => toggle(id)} aria-label={`Select ${label}`} />
    ) : null;

  return (
    <>
      {notice && (
        <div className="chip chip-success mb-3 w-full justify-start px-4 py-2.5 text-[12.5px]" role="status">{notice}</div>
      )}

      {/* Phone: stacked rows */}
      <div className="card divide-y overflow-hidden md:hidden" style={{ borderColor: "var(--hairline)" }}>
        {canAssign && (
          <label className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline-soft)" }}>
            <input type="checkbox" className="h-4 w-4" checked={allOnPage} onChange={toggleAll} aria-label="Select all leads on this page" />
            Select all
          </label>
        )}
        {rows.map((lead) => (
          <div key={lead.id} className="flex items-start gap-3 px-4 py-3.5" style={{ borderColor: "var(--hairline-soft)" }}>
            {canAssign && <div className="pt-[3px]">{check(lead.id, lead.name)}</div>}
            <Link href={`/leads/${lead.id}`} className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[14px] font-medium" style={{ color: "var(--ink)" }}>{lead.name}</span>
                    {lead.isClient && <ClientCheck size={14} />}
                  </div>
                  {lead.company && <div className="truncate text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{lead.company}</div>}
                </div>
                <span className={`chip flex-none ${lead.stageChip}`}>{lead.stageLabel}</span>
              </div>
              {lead.line && <div className="line-clamp-2 break-words text-[12.5px]" style={{ color: "var(--ink)" }}>{lead.line}</div>}
              <div className="flex min-w-0 items-center gap-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>
                {lead.recording && <RecordingNow />}
                <span className="truncate">
                  {[lead.calls > 0 ? `${lead.calls} ${lead.calls === 1 ? "call" : "calls"}` : lead.recording ? null : "No calls yet", lead.lastContact ? `last ${lead.lastContact}` : null].filter(Boolean).join(" · ")}
                </span>
              </div>
            </Link>
          </div>
        ))}
      </div>

      {/* Computer: table */}
      <div className="card hidden overflow-hidden md:block">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                {canAssign && (
                  <th className="w-10 border-b py-3 pl-4" style={{ borderColor: "var(--hairline)" }}>
                    <input type="checkbox" className="h-4 w-4" checked={allOnPage} onChange={toggleAll} aria-label="Select all leads on this page" />
                  </th>
                )}
                {[
                  { label: "Lead", show: "" },
                  { label: "Last call", show: SHOW.line },
                  { label: "Stage", show: "" },
                  { label: "Calls", show: "" },
                  ...(showOwner ? [{ label: "Owner", show: SHOW.owner }] : []),
                ].map((col) => (
                  <th
                    key={col.label}
                    className={`whitespace-nowrap border-b px-4 py-3 text-left text-[11.5px] font-medium uppercase tracking-wide ${col.show}`}
                    style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((lead) => {
                const cell = "border-b px-4 py-3 text-[13px]";
                const border = { borderColor: "var(--hairline-soft)" };
                const muted = { ...border, color: "var(--ink-muted)" };
                return (
                  <tr key={lead.id} className="row-hover transition-colors">
                    {canAssign && (
                      <td className="border-b py-3 pl-4" style={border}>
                        {check(lead.id, lead.name)}
                      </td>
                    )}
                    <td className={cell} style={border}>
                      <Link href={`/leads/${lead.id}`} className="block max-w-[240px]">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate font-medium" style={{ color: "var(--ink)" }} title={lead.name}>{lead.name}</span>
                          {lead.isClient && <ClientCheck size={14} />}
                        </div>
                        <div className="truncate text-[12px]" style={{ color: "var(--ink-muted)" }} title={[lead.company, lead.campaign].filter(Boolean).join(" · ")}>
                          {[lead.company, lead.campaign].filter(Boolean).join(" · ") || " "}
                        </div>
                      </Link>
                    </td>
                    <td className={`${cell} ${SHOW.line}`} style={muted}>
                      <div className="line-clamp-2 max-w-[420px] break-words" title={lead.line}>{lead.line || "-"}</div>
                    </td>
                    <td className={cell} style={border}>
                      <span className={`chip whitespace-nowrap ${lead.stageChip}`}>{lead.stageLabel}</span>
                    </td>
                    <td className={`whitespace-nowrap ${cell}`} style={muted}>
                      {lead.recording ? (
                        <div className="flex items-center gap-2">
                          {lead.calls > 0 && <span className="tabular-nums" style={{ color: "var(--ink)" }}>{lead.calls}</span>}
                          <RecordingNow />
                        </div>
                      ) : (
                        <div className="tabular-nums" style={{ color: "var(--ink)" }}>{lead.calls > 0 ? lead.calls : "-"}</div>
                      )}
                      {lead.lastContact && <div className="text-[12px]">Last {lead.lastContact}</div>}
                    </td>
                    {showOwner && (
                      <td className={`${cell} ${SHOW.owner}`} style={muted}>
                        <div className="max-w-[140px] truncate">{lead.owner}</div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Floats at the bottom so ticking the first box doesn't push the
          list down under the cursor. On phones it sits above the tab bar,
          level with the help button and left of it: the right padding
          keeps it clear of that button (48px, 20px in from the edge). Where
          one line doesn't fit (a 375px phone), the buttons go on a second
          line under the count instead of running off the screen. */}
      {canAssign && selected.size > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-30 flex justify-start pl-4 pr-[84px] md:bottom-6 md:justify-center md:px-4">
          <div
            className="pointer-events-auto flex max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-[26px] border py-1.5 pl-5 pr-1.5"
            style={{ background: "var(--surface-1)", borderColor: "var(--hairline)", boxShadow: "0 10px 34px rgba(0, 0, 0, 0.18)" }}
            role="region"
            aria-label="Selected leads"
          >
            <span className="whitespace-nowrap py-1 text-[13px] font-medium">{selected.size.toLocaleString("en-US")} selected</span>
            <div className="flex flex-wrap items-center gap-1">
              <button type="button" onClick={() => setSelected(new Set())} className="btn btn-ghost btn-sm">Clear</button>
              {deleteAction && (
                <button type="button" onClick={() => setConfirmDelete(true)} className="btn btn-ghost btn-sm" style={{ color: "#c0392b" }}>Delete</button>
              )}
              <button type="button" onClick={() => setDialog(true)} className="btn btn-primary btn-sm">Assign</button>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && deleteAction && (
        <DeleteDialog
          count={selected.size}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            const { deleted, kept } = await deleteAction([...selected]);
            return () => {
              setNotice(
                `Deleted ${deleted.toLocaleString("en-US")} ${deleted === 1 ? "lead" : "leads"}.` +
                  (kept ? ` Kept ${kept.toLocaleString("en-US")}: clients, leads whose proposal or contract went out, and leads with a call still going can't be deleted.` : ""),
              );
              setSelected(new Set());
              setConfirmDelete(false);
            };
          }}
        />
      )}

      {dialog && (
        <AssignDialog
          count={selected.size}
          assignees={assignees}
          onClose={() => setDialog(false)}
          onSubmit={async (draft, makeOwner) => {
            const { created } = await assignAction({ ...draft, timezone: viewerTimeZone(), leadIds: [...selected], makeOwner });
            const who = assignees.find((a) => a.id === draft.assigneeId)?.name ?? "them";
            return () => {
              setNotice(`${created.toLocaleString("en-US")} ${created === 1 ? "task" : "tasks"} assigned to ${who}.`);
              setSelected(new Set());
              setDialog(false);
            };
          }}
        />
      )}
    </>
  );
}

function AssignDialog({
  count,
  assignees,
  onClose,
  onSubmit,
}: {
  count: number;
  assignees: { id: string; name: string }[];
  onClose: () => void;
  // Saves, then returns the UI updates to apply once it has.
  onSubmit: (draft: TaskDraft, makeOwner: boolean) => Promise<() => void>;
}) {
  const [draft, setDraft] = useState<TaskDraft>({ assigneeId: "", type: "cold_call", dueDate: todayLocal(), dueTime: "", priority: "normal", note: "" });
  const [makeOwner, setMakeOwner] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!draft.assigneeId) return setError("Pick who it's for.");
    startTransition(async () => {
      try {
        const done = await onSubmit(draft, makeOwner);
        // After an await, updates need their own transition to land together
        // with the refreshed list (sent back by the action's revalidatePath).
        startTransition(done);
      } catch {
        setError("Couldn't assign those. Try again.");
      }
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4" style={{ background: "rgba(0,0,0,0.45)" }} onMouseDown={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label="Assign leads"
        className="card flex max-h-[92dvh] w-full max-w-[520px] flex-col gap-4 overflow-y-auto rounded-b-none p-5 sm:rounded-b-[var(--r-lg)] sm:p-6"
      >
        <div>
          <h2 className="text-[16px] font-medium">Assign {count.toLocaleString("en-US")} {count === 1 ? "lead" : "leads"}</h2>
          <div className="mt-1 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>One task per lead, on their list for that day.</div>
        </div>
        <TaskFields draft={draft} setDraft={setDraft} assignees={assignees} disabled={pending} />
        <label className="flex items-start gap-2.5 text-[13px]">
          <input type="checkbox" className="mt-[2px] h-4 w-4" checked={makeOwner} onChange={(e) => setMakeOwner(e.target.checked)} disabled={pending} />
          <span>Also make them the owner of {count === 1 ? "this lead" : "these leads"}</span>
        </label>
        {error && <div className="chip chip-warn w-full justify-start px-4 py-2.5 text-[12.5px]">{error}</div>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className="btn btn-primary">{pending ? "Assigning…" : "Assign"}</button>
          <button type="button" disabled={pending} onClick={onClose} className="btn btn-secondary">Cancel</button>
        </div>
      </form>
    </div>
  );
}

function DeleteDialog({ count, onClose, onConfirm }: { count: number; onClose: () => void; onConfirm: () => Promise<() => void> }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const what = `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"}`;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-0 sm:items-center sm:p-4" style={{ background: "rgba(0,0,0,0.45)" }} onMouseDown={(e) => e.target === e.currentTarget && !pending && onClose()}>
      <div role="dialog" aria-modal="true" aria-label="Delete leads" className="card flex w-full max-w-[440px] flex-col gap-4 rounded-b-none p-5 sm:rounded-b-[var(--r-lg)] sm:p-6">
        <div>
          <h2 className="text-[16px] font-medium">Delete {what}?</h2>
          <div className="mt-1 text-[13px]" style={{ color: "var(--ink-muted)" }}>
            Their calls and tasks are deleted too, and their proposal and contract drafts go to the trash. Clients, and leads whose proposal or contract went out to the client, are kept. This can&apos;t be undone.
          </div>
        </div>
        {error && <div className="chip chip-warn w-full justify-start px-4 py-2.5 text-[12.5px]">{error}</div>}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  const done = await onConfirm();
                  startTransition(done);
                } catch {
                  setError("Couldn't delete those. Try again.");
                }
              })
            }
            className="btn"
            style={{ background: "#c0392b", color: "#fff" }}
          >
            {pending ? "Deleting…" : `Delete ${what}`}
          </button>
          <button type="button" disabled={pending} onClick={onClose} className="btn btn-secondary">Cancel</button>
        </div>
      </div>
    </div>
  );
}
