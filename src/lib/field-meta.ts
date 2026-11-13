// How a field key reads to people: its label and the group it's shown in on
// a deal. Kept free of server-only imports so the template review screen in
// the browser can label a field the user just added.

const FIELD_META: Record<string, { label: string; groupLabel: string }> = {
  clientName: { label: "Client", groupLabel: "Client & engagement" },
  // Not a contract placeholder: a deal made from a phone call needs it to
  // send the contract, so it's asked for when the call didn't give one.
  clientEmail: { label: "Client email", groupLabel: "Client & engagement" },
  service: { label: "Service", groupLabel: "Client & engagement" },
  startDate: { label: "Start date", groupLabel: "Client & engagement" },
  duration: { label: "Duration", groupLabel: "Client & engagement" },
  deliverables: { label: "Deliverables", groupLabel: "Scope" },
  platforms: { label: "Platforms", groupLabel: "Scope" },
  fee: { label: "Fee", groupLabel: "Commercial terms" },
  paymentTerms: { label: "Payment terms", groupLabel: "Commercial terms" },
  cancellation: { label: "Cancellation terms", groupLabel: "Commercial terms" },
  billingAddress: { label: "Billing address", groupLabel: "Commercial terms" },
};

// A template's own placeholder ({billingCycle}) reads as "Billing cycle".
// Short forms that read wrong in lower case: "sdrCount" is "SDR count",
// not "Sdr count".
const ACRONYMS = new Set(["sdr", "sdrs", "crm", "sow", "kpi", "kpis", "bant", "roi", "seo", "ppc", "cpa", "cpc", "cpm", "ctr", "url", "api", "id", "usd", "eur", "gbp", "nda", "msa", "sla", "llc", "vp", "ceo", "cfo", "cmo", "coo", "cto", "hr", "ux", "ui", "ai"]);

export function humanize(fieldKey: string): string {
  const words = fieldKey.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  if (!words) return fieldKey;
  const label = words.split(/\s+/).map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w)).join(" ");
  return label[0].toUpperCase() + label.slice(1);
}

export function fieldMeta(fieldKey: string): { label: string; groupLabel: string } {
  // Own keys only: a key like "constructor" mustn't find Object's.
  return (Object.hasOwn(FIELD_META, fieldKey) ? FIELD_META[fieldKey] : undefined) ?? { label: humanize(fieldKey), groupLabel: "Deal details" };
}

// The fields every template can use, by label, for suggesting a name when
// someone marks a field by hand.
export const STANDARD_FIELD_LABELS: { key: string; label: string }[] = Object.entries(FIELD_META)
  .filter(([key]) => key !== "clientEmail")
  .map(([key, meta]) => ({ key, label: meta.label }));
