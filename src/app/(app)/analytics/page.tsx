import Link from "next/link";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { formatMoney, sumByCurrency } from "@/lib/money";
import { requireWorkspaceId } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { cookieTimeZone } from "@/lib/viewer-time";
import { ANALYTICS_PERIODS, analyticsPeriod, callBuckets, COUNTED_CALL_STATUSES, daysToSignature, formatDays, median, periodStart } from "@/lib/analytics";
import GlassStatCard from "@/components/GlassStatCard";
import PeopleTable, { type PersonNumbers } from "@/components/analytics/PeopleTable";

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;
// A total with a currency code ("RSD 123.5K") is wider than a stat tile on
// a phone or in the six-across row, so it gets a smaller font there.
const LONG_VALUE = "max-sm:[&_.font-mono-tab]:text-[20px] 2xl:[&_.font-mono-tab]:text-[20px]";
const moneyLine = (groups: { currency: string; total: number }[]) => groups.map((g) => formatMoney(g.total, g.currency, { short: true })).join(", ");

function BarRow({ label, count, max }: { label: string; count: number; max: number }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="w-[104px] flex-none truncate text-[13px] sm:w-[150px]" style={{ color: "var(--ink-muted)" }}>
        {label}
      </span>
      <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full" style={{ background: "var(--surface-2)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--primary)" }} />
      </div>
      {/* As wide as the biggest count, so every bar has the same track. */}
      <span className="font-mono-tab flex-none text-right text-[13px] font-medium" style={{ width: `max(36px, ${n(max).length}ch)` }}>{n(count)}</span>
    </div>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ period?: string | string[] }> }) {
  const workspaceId = await requireWorkspaceId();
  const user = await currentUserWithRole();
  // Same switch as the deals list. Without it these are strictly the rep's
  // own numbers: deals they own and calls they made, not the ownerless or
  // under-review deals they're allowed to open.
  const { canViewAll } = await dealVisibilityFilter(user);
  const period = analyticsPeriod((await searchParams).period);
  const tz = await cookieTimeZone();
  const now = new Date();
  const since = periodStart(period, tz, now);

  // Imported deals are old contracts brought in from a spreadsheet, often
  // dated the day of the import, so they'd show as a burst of signatures.
  const dealScope: Prisma.DealWhereInput = { workspaceId, trashedAt: null, source: { not: "import" }, ...(canViewAll ? {} : { ownerId: user.id }) };
  const sentSelect = { viewedAt: true, deal: { select: { ownerId: true } } } as const;
  const callScope: Prisma.PhoneCallWhereInput = { workspaceId, ...(canViewAll ? {} : { userId: user.id }), status: { in: COUNTED_CALL_STATUSES } };
  const bucketRanges = callBuckets(period, tz, now);

  // Calls are counted in the database, not loaded: a team whose dialer logs
  // every dial has tens of thousands a month.
  const [callTally, bucketCounts, proposals, contractsSent, signed, members] = await Promise.all([
    // Per person and connected or not, which also adds up to the total.
    prisma.phoneCall.groupBy({ by: ["userId", "connected"], where: { ...callScope, startedAt: { gte: since } }, _count: { _all: true } }),
    Promise.all(
      bucketRanges.map((b) => prisma.phoneCall.count({ where: { ...callScope, startedAt: b.end ? { gte: b.start, lt: b.end } : { gte: b.start } } })),
    ),
    prisma.contract.findMany({ where: { sentAt: { gte: since }, deal: { ...dealScope, kind: "proposal" } }, select: sentSelect }),
    prisma.contract.findMany({ where: { sentAt: { gte: since }, deal: { ...dealScope, kind: { not: "proposal" } } }, select: sentSelect }),
    // Signed means fully signed: signedAt alone is set as soon as the client
    // signs, while a countersignature can still be missing.
    prisma.contract.findMany({
      where: { status: "signed", signedAt: { gte: since }, deal: { ...dealScope, kind: { not: "proposal" } } },
      select: { signedAt: true, sentAt: true, deal: { select: { ownerId: true, feeDisplay: true, source: true, leadId: true, lead: { select: { createdAt: true } } } } },
    }),
    canViewAll ? prisma.user.findMany({ where: { workspaceId }, select: { id: true, name: true, deactivatedAt: true }, orderBy: { name: "asc" } }) : [],
  ]);

  // The lead's first call, whoever on the team made it: days to signature
  // is the client's path, not one rep's.
  const leadIds = [...new Set(signed.map((c) => c.deal.leadId).filter((id): id is string => Boolean(id)))];
  const firstCalls = leadIds.length
    ? await prisma.phoneCall.groupBy({ by: ["leadId"], where: { workspaceId, leadId: { in: leadIds }, status: { notIn: ["discarded", "dialing"] } }, _min: { startedAt: true } })
    : [];
  const firstCallBy = new Map(firstCalls.map((r) => [r.leadId, r._min.startedAt]));

  const callCount = callTally.reduce((sum, r) => sum + r._count._all, 0);
  const connected = callTally.reduce((sum, r) => sum + (r.connected ? r._count._all : 0), 0);
  const viewed = proposals.filter((p) => p.viewedAt).length;
  const opened = contractsSent.filter((c) => c.viewedAt).length;
  const value = sumByCurrency(signed.map((c) => c.deal.feeDisplay));
  // A renewal isn't a new sale: its "first call" was a year or more ago.
  const newSales = signed.filter((c) => c.deal.source !== "renewal");
  const toSign = daysToSignature(
    newSales.map((c) => ({ signedAt: c.signedAt, firstCallAt: (c.deal.leadId && firstCallBy.get(c.deal.leadId)) || null, leadCreatedAt: c.deal.lead?.createdAt ?? null })),
  );
  const toSignMedian = median(toSign);
  // The same count, started from the send instead of the first call.
  const fromSend = median(daysToSignature(signed.map((c) => ({ signedAt: c.signedAt, firstCallAt: c.sentAt }))));
  const buckets = bucketRanges.map((b, i) => ({ label: b.label, count: bucketCounts[i] }));
  const maxBucket = Math.max(1, ...buckets.map((b) => b.count));
  const inPeriod = period.label.toLowerCase();
  const valueSigned = value.length ? formatMoney(value[0].total, value[0].currency, { short: true }) : "0";

  // Each teammate's numbers, for whoever sees the whole team and has one.
  // Deals with no owner and calls by someone since removed get their own row.
  let people: PersonNumbers[] = [];
  if (canViewAll && members.length > 1) {
    const NOBODY = "nobody";
    const tally = new Map(members.map((m) => [m.id, { id: m.id, name: m.id === user.id ? `${m.name} (you)` : m.name, gone: Boolean(m.deactivatedAt), calls: 0, proposals: 0, signed: 0, fees: [] as string[] }]));
    const of = (id: string | null) => {
      const key = id && tally.has(id) ? id : NOBODY;
      if (!tally.has(key)) tally.set(key, { id: NOBODY, name: "No owner", gone: false, calls: 0, proposals: 0, signed: 0, fees: [] });
      return tally.get(key)!;
    };
    for (const r of callTally) of(r.userId).calls += r._count._all;
    for (const p of proposals) of(p.deal.ownerId).proposals++;
    for (const c of signed) {
      const row = of(c.deal.ownerId);
      row.signed++;
      row.fees.push(c.deal.feeDisplay);
    }
    people = [...tally.values()]
      .filter((r) => !r.gone || r.calls + r.proposals + r.signed > 0)
      .map((r) => ({ id: r.id, name: r.name, calls: r.calls, proposals: r.proposals, signed: r.signed, value: r.fees.length ? moneyLine(sumByCurrency(r.fees)) : "0" }));
    // Someone removed counts only with numbers in the period, so whoever is
    // alone on the team now (with a former colleague, or only ownerless
    // deals beside them) gets no one-person table.
    if (people.filter((r) => r.id !== NOBODY).length < 2) people = [];
  }

  return (
    <>
      <div className="mb-4">
        <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Analytics</h1>
        <div className="mt-1 text-[14px]" style={{ color: "var(--ink-muted)" }}>
          {canViewAll ? "How the whole team is doing, from the first call to the signature." : "Your calls, proposals and contracts, from the first call to the signature."}
        </div>
      </div>

      <nav className="mb-3.5 flex flex-wrap gap-2" aria-label="Period">
        {ANALYTICS_PERIODS.map((p) => (
          <Link
            key={p.key}
            href={p.key === ANALYTICS_PERIODS[0].key ? "/analytics" : `/analytics?period=${p.key}`}
            aria-current={period.key === p.key ? "page" : undefined}
            className="btn btn-sm"
            style={period.key === p.key ? { background: "var(--primary)", color: "var(--on-primary)" } : { background: "var(--surface-1)", border: "1px solid var(--hairline)", color: "var(--ink-muted)" }}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3 2xl:grid-cols-6">
        <GlassStatCard label="Calls" value={n(callCount)} sub={callCount ? `${n(connected)} connected` : "None yet"} />
        <GlassStatCard
          label="Proposals sent"
          value={n(proposals.length)}
          sub={proposals.length ? `${n(viewed)} viewed (${Math.round((viewed / proposals.length) * 100)}%)` : "None sent"}
        />
        <GlassStatCard label="Contracts sent" value={n(contractsSent.length)} sub={contractsSent.length ? `${n(opened)} opened` : "None sent"} />
        <GlassStatCard
          label="Contracts signed"
          value={n(signed.length)}
          sub={fromSend !== null ? `Usually ${formatDays(fromSend)} ${formatDays(fromSend) === "1" ? "day" : "days"} after sending` : signed.length ? plural(signed.length, "contract", "contracts") : "None signed"}
        />
        <GlassStatCard
          label="Value signed"
          value={valueSigned}
          className={valueSigned.length > 8 ? LONG_VALUE : undefined}
          sub={value.length > 1 ? `+ ${moneyLine(value.slice(1))}` : signed.length ? `From ${plural(signed.length, "contract", "contracts")}` : "Nothing signed yet"}
        />
        <GlassStatCard
          label="Days to signature"
          value={toSignMedian === null ? "-" : formatDays(toSignMedian)}
          sub={
            toSignMedian !== null
              ? `From the first call, ${plural(toSign.length, "contract", "contracts")}`
              : newSales.length
                ? "No first call on record"
                : signed.length
                  ? "Renewals don't count here"
                  : "Shows once a contract is signed"
          }
        />
      </div>

      <div className="flex flex-col gap-4">
        <section className="glass-card glass-card-solid">
          <div className="flex items-baseline justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
            <h2 className="text-[15px] font-medium">{period.unit === "month" ? "Calls per month" : "Calls per week"}</h2>
            <span className="flex-none text-[12px]" style={{ color: "var(--ink-muted)" }}>{plural(callCount, "call", "calls")}</span>
          </div>
          {callCount === 0 ? (
            <div className="flex flex-col items-start gap-3 p-5">
              <div className="text-[14.5px] font-medium">No calls in the {inPeriod}</div>
              <div className="max-w-[460px] text-[13px]" style={{ color: "var(--ink-muted)" }}>
                {canViewAll ? "Calls anyone on the team makes, records or uploads in SealMe show up here." : "Calls you make, record or upload in SealMe show up here."}
              </div>
              <Link href="/deals/new" className="btn btn-primary btn-sm">Start a call</Link>
            </div>
          ) : (
            <div className="px-5 py-3">
              {buckets.map((b) => (
                <BarRow key={b.label} label={b.label} count={b.count} max={maxBucket} />
              ))}
            </div>
          )}
        </section>

        {people.length > 0 && <PeopleTable rows={people} />}
      </div>

      <div className="mt-3 max-w-[680px] text-[12px]" style={{ color: "var(--ink-muted)" }}>
        Numbers cover the {inPeriod}, today included. Calls are calls logged in SealMe; connected means someone picked up and talked. A proposal or contract
        counts once, on the last day it went out; viewed and opened mean the client opened it. Signed counts contracts fully signed, and the value adds up the fee
        written on each, every currency on its own. Days to signature is the middle value, from the first call with the lead (or when the lead was added) to the
        client&apos;s signature; renewals don&apos;t count there. Trashed and imported deals are left out.
      </div>
    </>
  );
}
