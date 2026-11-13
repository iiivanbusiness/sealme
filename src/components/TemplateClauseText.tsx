import type { CSSProperties, ReactNode } from "react";
import { fieldMeta } from "@/lib/field-meta";

const PLACEHOLDER = /\{(\w+)\}/g;

// A template clause as people read it: each {placeholder} shows as the name
// of the field the call fills in ("Fee", "Start date"), with its key on
// hover for Edit template, where fields are typed as {key}.
export default function TemplateClauseText({ body, className, style }: { body: string; className?: string; style?: CSSProperties }) {
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const m of body.matchAll(PLACEHOLDER)) {
    if (m.index > pos) parts.push(body.slice(pos, m.index));
    const key = m[1];
    parts.push(
      <span key={m.index} title={`Filled in from the call. In Edit template: {${key}}`}
        className="mx-[1px] inline rounded-[6px] px-1.5 py-[1px] align-baseline text-[12.5px] font-medium"
        style={{ background: "color-mix(in srgb, var(--accent-blue) 12%, transparent)", color: "var(--accent-blue)", boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }}>
        {fieldMeta(key).label}
      </span>
    );
    pos = m.index + m[0].length;
  }
  if (pos < body.length) parts.push(body.slice(pos));
  return <p className={className} style={style}>{parts}</p>;
}

// The fields a template fills in from the call, in the order they first
// appear, each with how many places it fills.
export function templateFields(clauses: { body: string }[]): { key: string; label: string; places: number }[] {
  const byKey = new Map<string, { key: string; label: string; places: number }>();
  for (const c of clauses) {
    for (const m of c.body.matchAll(PLACEHOLDER)) {
      const f = byKey.get(m[1]);
      if (f) f.places++;
      else byKey.set(m[1], { key: m[1], label: fieldMeta(m[1]).label, places: 1 });
    }
  }
  return [...byKey.values()];
}
