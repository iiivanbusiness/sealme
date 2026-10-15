"use client";

import { useState } from "react";

type FieldChange = {
  oldValue: string | null;
  newValue: string | null;
  changedBy: string;
  changedAt: Date;
};

type Field = {
  id: string;
  groupLabel: string;
  label: string;
  value: string | null;
  status: string;
  sourceQuote: string | null;
  history?: FieldChange[];
};

function formatChangeDate(date: Date): string {
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// listening: the call is still going, so a term not heard yet is still to
// come rather than missing.
export default function DealTermsCard({
  groups,
  updateAction,
  listening = false,
}: {
  groups: [string, Field[]][];
  updateAction: (formData: FormData) => void;
  listening?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [openQuote, setOpenQuote] = useState<string | null>(null);
  const [openHistory, setOpenHistory] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">Deal terms</h2>
        {!editing && (
          <button onClick={() => setEditing(true)} className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
            Edit
          </button>
        )}
      </div>

      {!editing ? (
        <div className="px-5 py-1.5">
          {groups.map(([label, rows]) => (
            <div key={label} className="border-b py-3 last:border-b-0" style={{ borderColor: "var(--hairline-soft)" }}>
              <div className="pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
                {label}
              </div>
              {rows.map((row) => (
                <div key={row.id}>
                  <div className="flex items-center justify-between gap-3 py-2">
                    <span className="text-[13.5px]" style={{ color: "var(--ink-muted)" }}>{row.label}</span>
                    <div className="flex items-center gap-2">
                      {row.value ? (
                        <span className="text-[13.5px] font-medium">{row.value}</span>
                      ) : (
                        <span className="text-[13px]" style={{ color: "var(--ink-muted)" }}>{listening ? "Listening…" : "Not mentioned"}</span>
                      )}
                      {!!row.history?.length && (
                        <button
                          onClick={() => setOpenHistory(openHistory === row.id ? null : row.id)}
                          title="Show how this changed"
                          className="flex h-[18px] items-center justify-center rounded-[5px] px-1 text-[10.5px] font-medium"
                          style={{ color: "var(--accent-blue)" }}
                        >
                          changed
                        </button>
                      )}
                      {row.sourceQuote && (
                        <button
                          onClick={() => setOpenQuote(openQuote === row.id ? null : row.id)}
                          title="Show source"
                          className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] text-[11px]"
                          style={{ color: "var(--ink-muted)" }}
                        >
                          ⓘ
                        </button>
                      )}
                    </div>
                  </div>
                  {!!row.history?.length && openHistory === row.id && (
                    <div className="mb-2 flex flex-col gap-1.5 rounded-[8px] p-3 text-[12.5px]" style={{ background: "var(--surface-2)" }}>
                      {row.history!.map((change, i) => (
                        <div key={i} className="flex items-center justify-between gap-3" style={{ color: "var(--ink-muted)" }}>
                          <span>
                            <span style={{ textDecoration: "line-through" }}>{change.oldValue}</span>
                            {" → "}
                            <span style={{ color: "var(--ink)" }}>{change.newValue}</span>
                          </span>
                          <span className="flex-none text-[11px]">
                            {change.changedBy === "manual" ? "edited" : "on call"} · {formatChangeDate(change.changedAt)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {row.sourceQuote && openQuote === row.id && (
                    <blockquote
                      className="mb-2 rounded-r-[8px] py-2 pl-3 pr-3 text-[12.5px] italic"
                      style={{ borderLeft: "2px solid var(--accent-blue)", background: "var(--surface-2)", color: "var(--ink-muted)" }}
                    >
                      {row.sourceQuote}
                    </blockquote>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <form action={updateAction} className="px-5 py-3">
          {groups.map(([label, rows]) => (
            <div key={label} className="border-b py-3 last:border-b-0" style={{ borderColor: "var(--hairline-soft)" }}>
              <div className="pb-2 pt-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
                {label}
              </div>
              {rows.map((row) => (
                <label key={row.id} className="mb-2.5 flex flex-col gap-1 last:mb-0">
                  <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>{row.label}</span>
                  <input name={row.id} defaultValue={row.value ?? ""} className="input" style={{ fontSize: "13px", padding: "8px 11px" }} />
                </label>
              ))}
            </div>
          ))}
          <div className="mt-3 flex gap-2.5">
            <button type="submit" className="btn btn-primary flex-1 justify-center">
              Save changes
            </button>
            <button type="button" onClick={() => setEditing(false)} className="btn btn-secondary flex-1 justify-center">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
