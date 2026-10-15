"use client";

import type { Clause } from "@/lib/contract";

type Field = { fieldKey: string; label: string; value: string | null };

// The contract as it stands: the deal's template with every term heard so
// far written in, and the ones still to come marked where they go. Shown
// from the moment a call starts, so the rep sees what the call has to cover.
export default function ContractPreview({ templateName, clausesJson, fields, live }: { templateName: string | null; clausesJson: string; fields: Field[]; live: boolean }) {
  let clauses: Clause[];
  try {
    clauses = JSON.parse(clausesJson) as Clause[];
  } catch {
    return null;
  }
  const byKey = new Map(fields.map((f) => [f.fieldKey, f]));
  const filled = fields.filter((f) => f.value).length;

  return (
    <div className="card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">Contract</h2>
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          {templateName ? `${templateName} template · ` : ""}
          {filled} of {fields.length} terms in{live ? ", filling in as they're said" : ""}
        </span>
      </div>
      <div className="max-h-[560px] overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-4">
          {clauses.map((clause, i) => (
            <section key={i}>
              <h3 className="mb-1 text-[13px] font-semibold">{clause.title}</h3>
              <p className="whitespace-pre-line text-[13px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>
                {clause.body.split(/(\{\w+\})/g).map((part, j) => {
                  const key = /^\{(\w+)\}$/.exec(part)?.[1];
                  if (!key) return part;
                  const field = byKey.get(key);
                  return field?.value ? (
                    <span key={j} className="font-medium" style={{ color: "var(--ink)" }}>
                      {field.value}
                    </span>
                  ) : (
                    <span key={j} className="rounded-[5px] px-1 py-px text-[12px] font-medium" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                      {field?.label ?? key}
                    </span>
                  );
                })}
              </p>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
