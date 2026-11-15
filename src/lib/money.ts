// Parses a free-typed fee string (AI-extracted or hand-edited) into a number.
// Handles both US grouping ("$2,500.00") and European grouping ("€2.500,00")
// — a plain `replace(/,/g, "")` treats "150.000,00" (150k, European) as
// "150.000" -> 150, silently understating the fee by 1000x. That number
// feeds straight into ReviewChain.minDealValue gating and the HubSpot
// sync, so misreading the format doesn't just show a wrong label — it can
// skip a required review step entirely.
export function parseFee(feeDisplay: string): number {
  // Spaces, non-breaking spaces and apostrophes group thousands too ("5 000 €",
  // "CHF 12'500"), but only between groups of three digits, so a gap before
  // anything else still ends the number. A leading dot is a decimal point
  // ("$.5M", "$.75/min").
  const match = feeDisplay.match(/\d{1,3}(?:[\s'’]\d{3})+(?!\d)(?:[.,]\d+)?|(?:\.(?=\d))?\d(?:[\d.,]*\d)?/);
  if (!match) return 0;
  let numStr = match[0].replace(/[\s'’]/g, "");
  // "$8.5k", "$1.2M", "2 million": the word after the number scales it.
  const after = feeDisplay.slice((match.index ?? 0) + match[0].length);
  const scale = /^\s?(k|thousand)\b/i.test(after) ? 1_000 : /^\s?(m|mm|mil|million)\b/i.test(after) ? 1_000_000 : 1;

  const lastComma = numStr.lastIndexOf(",");
  const lastDot = numStr.lastIndexOf(".");

  if (lastComma !== -1 && lastDot !== -1) {
    // Both separators present — whichever comes last is the decimal one.
    numStr = lastComma > lastDot
      ? numStr.replace(/\./g, "").replace(",", ".")
      : numStr.replace(/,/g, "");
  } else if (lastComma !== -1) {
    // Only commas: a single comma followed by 1 or 2 digits is a decimal
    // separator ("12,50", "€2,5k"); anything else is thousands grouping.
    const decimals = numStr.length - lastComma - 1;
    const isDecimal = numStr.indexOf(",") === lastComma && (decimals === 1 || decimals === 2);
    numStr = isDecimal ? numStr.replace(",", ".") : numStr.replace(/,/g, "");
  } else if (lastDot !== -1) {
    // Only dots: more than one, or exactly 3 digits after the last one
    // (e.g. "2.500"), means thousands grouping rather than a real decimal.
    const dotCount = (numStr.match(/\./g) ?? []).length;
    const isGrouping = dotCount > 1 || numStr.length - lastDot - 1 === 3;
    numStr = isGrouping ? numStr.replace(/\./g, "") : numStr;
  }

  const parsed = parseFloat(numStr) * scale;
  return Number.isFinite(parsed) ? parsed : 0;
}

const CURRENCY_CODES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "CHF", "SEK", "NOK", "DKK", "PLN", "RSD", "JPY", "INR", "MXN", "BRL", "ZAR", "SGD", "AED", "HKD", "TWD"];

// Whose dollar a "$" is, from the letters written right before it.
const DOLLAR_PREFIXES: Record<string, string> = {
  US: "USD", U: "USD", C: "CAD", CA: "CAD", A: "AUD", AU: "AUD", NZ: "NZD",
  R: "BRL", S: "SGD", MX: "MXN", MEX: "MXN", HK: "HKD", NT: "TWD",
};

// The currency a fee is written in: an ISO code when the fee says so ("$",
// "€", "R$", "EUR"...), the sign itself ("J$") for a dollar we can't name,
// so it's never added to US dollars, and null when there's no sign at all.
// A bare "$" is taken as US dollars.
function writtenCurrency(feeDisplay: string): string | null {
  const code = feeDisplay.toUpperCase().match(new RegExp(`\\b(${CURRENCY_CODES.join("|")})\\b`));
  if (code) return code[1];
  const dollar = feeDisplay.match(/([A-Za-z]*)\$/);
  // Only one to three capital letters right before "$" name a dollar ("R$",
  // "HK$"); a word stuck to it ("Fee$500") or lower case is a plain "$".
  const prefix = dollar && /^[A-Z]{1,3}$/.test(dollar[1]) ? dollar[1] : "";
  if (DOLLAR_PREFIXES[prefix]) return DOLLAR_PREFIXES[prefix];
  if (feeDisplay.includes("€")) return "EUR";
  if (feeDisplay.includes("£")) return "GBP";
  if (feeDisplay.includes("¥")) return "JPY";
  if (feeDisplay.includes("₹")) return "INR";
  if (dollar) return prefix ? `${prefix}$` : "USD";
  return null;
}

// The currency a fee is written in, as an ISO code, for the API and
// webhooks: null when the fee doesn't say, or says it in a way we can't name.
export function feeCurrency(feeDisplay: string): string | null {
  const currency = writtenCurrency(feeDisplay);
  return currency && /^[A-Z]{3}$/.test(currency) ? currency : null;
}

// Adds fees up per currency and never across currencies: "$8,500" and
// "€2.500" stay two totals. A fee written without a currency counts in the
// currency most of the others are written in (US dollars when none says),
// since a team that writes "€" on some fees means euros on the rest too.
// The group with the most fees comes first.
export function sumByCurrency(fees: string[]): { currency: string; total: number; count: number }[] {
  const written = fees.map((fee) => writtenCurrency(fee));
  const seen = new Map<string, number>();
  for (const c of written) if (c) seen.set(c, (seen.get(c) ?? 0) + 1);
  const usual = [...seen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";

  const groups = new Map<string, { currency: string; total: number; count: number }>();
  fees.forEach((fee, i) => {
    const currency = written[i] ?? usual;
    const group = groups.get(currency) ?? { currency, total: 0, count: 0 };
    group.total += parseFee(fee);
    group.count += 1;
    groups.set(currency, group);
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || b.total - a.total);
}

// "$8,500", "€2,500"; with short, big amounts shrink to "$12.3K" or
// "$1.3M" so they fit a stat tile. Whole units only: these are totals,
// not invoices.
export function formatMoney(amount: number, currency: string, opts: { short?: boolean } = {}): string {
  const short = opts.short && Math.abs(amount) >= 10_000;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: short ? 1 : 0,
      ...(short ? { notation: "compact" as const } : {}),
    }).format(amount);
  } catch {
    // Not a code Intl knows (a dollar sign we can't name, like "J$").
    const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: short ? 1 : 0, ...(short ? { notation: "compact" as const } : {}) }).format(amount);
    return `${currency} ${number}`;
  }
}
