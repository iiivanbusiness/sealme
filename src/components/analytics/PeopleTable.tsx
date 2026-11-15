export type PersonNumbers = {
  id: string;
  name: string;
  calls: number;
  proposals: number;
  signed: number;
  value: string; // already formatted, one total per currency
};

const COLUMNS: { key: keyof Omit<PersonNumbers, "id" | "name">; label: string; head: string }[] = [
  { key: "calls", label: "Calls", head: "Calls" },
  { key: "proposals", label: "Proposals", head: "Proposals sent" },
  { key: "signed", label: "Signed", head: "Contracts signed" },
  { key: "value", label: "Value", head: "Value signed" },
];

const show = (v: string | number) => (typeof v === "number" ? v.toLocaleString("en-US") : v);

// Each teammate's numbers for the period, for whoever sees the whole team.
// A card per person below lg (the table doesn't fit a phone or a narrow
// window), a table from lg up, like the Team page.
export default function PeopleTable({ rows }: { rows: PersonNumbers[] }) {
  const border = { borderColor: "var(--hairline-soft)" };
  return (
    <section className="glass-card glass-card-solid">
      <div className="border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
        <h2 className="text-[15px] font-medium">By person</h2>
      </div>

      <div className="lg:hidden">
        {rows.map((row, i) => (
          <div key={row.id} className={`flex flex-col gap-2 px-5 py-3 ${i < rows.length - 1 ? "border-b" : ""}`} style={border}>
            <div className="truncate text-[14px] font-medium" title={row.name}>{row.name}</div>
            <div className="grid grid-cols-4 gap-2 text-[13px]">
              {COLUMNS.map((c) => (
                <div key={c.key} className="min-w-0">
                  <div className="truncate text-[11px] uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>{c.label}</div>
                  <div className="truncate font-medium tabular-nums">{show(row[c.key])}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Teammate", ...COLUMNS.map((c) => c.head)].map((label, i) => (
                <th
                  key={label}
                  className={`whitespace-nowrap border-b px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide ${i === 0 ? "text-left" : "text-right"}`}
                  style={{ color: "var(--ink-muted)", borderColor: "var(--hairline)" }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const last = i === rows.length - 1 ? "" : "border-b";
              return (
                <tr key={row.id}>
                  <td className={`${last} px-5 py-3 text-[13px]`} style={border}>
                    <div className="max-w-[260px] truncate font-medium" title={row.name}>{row.name}</div>
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className={`${last} whitespace-nowrap px-5 py-3 text-right text-[13px] tabular-nums`} style={border}>{show(row[c.key])}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
