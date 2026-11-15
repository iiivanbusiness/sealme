// Which proposal and contract belong to which call on a lead. The lead page
// (what shows under each call) and "Delete call" (what goes to the trash
// with it, and what keeps it) both go by these, so they never disagree.

// The calls a lead's page shows in full, with their notes. Only these lay
// claim to a shared old pointer (see below).
export const LEAD_PAGE_CALL_STATUSES = ["processed", "processing", "recording"];

// A call that couldn't be written up, or that nothing was heard on, still
// shows on the lead (as a row that says so and where to fix it), so it never
// just disappears. It has no notes, and it never takes a shared old pointer
// away from a call that has notes.
export const LEAD_PAGE_SET_ASIDE_STATUSES = ["failed", "skipped"];

// The old pointer (call.dealId, from before documents knew their call) is a
// call's own only when no other call on the lead that shows shares it: older
// code pointed every call on a lead at the lead's one deal, which belongs to
// none of them. A skipped call sharing it doesn't count, so the document
// stays under (and keeps) the call it shows under.
export function sharingPointerWhere(call: { id: string; leadId: string; dealId: string }) {
  return { leadId: call.leadId, dealId: call.dealId, id: { not: call.id }, status: { in: LEAD_PAGE_CALL_STATUSES } };
}

// The same rule over a lead's calls already in hand: each call's pointer when
// no other call that shows shares it, else null. A set-aside call counts
// the calls that show the way Delete call does: all of them are "other".
export function ownPointers(calls: { status: string; dealId: string | null }[]): (call: { status: string; dealId: string | null }) => string | null {
  const use = new Map<string, number>();
  for (const c of calls) if (c.dealId && LEAD_PAGE_CALL_STATUSES.includes(c.status)) use.set(c.dealId, (use.get(c.dealId) ?? 0) + 1);
  return (c) => {
    if (!c.dealId) return null;
    const others = (use.get(c.dealId) ?? 0) - (LEAD_PAGE_CALL_STATUSES.includes(c.status) ? 1 : 0);
    return others === 0 ? c.dealId : null;
  };
}

// The automatic proposal or contract a call asked for couldn't be written
// (runCallProcessing records it as extracted.docFailed): nothing is on its
// way, so the rep can make one by hand right away.
export function docFailed(extracted: unknown, kind: "proposal" | "contract"): boolean {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return false;
  const failed = (extracted as Record<string, unknown>).docFailed;
  if (!failed || typeof failed !== "object" || Array.isArray(failed)) return false;
  return (failed as Record<string, unknown>)[kind] === true;
}

type DatedDoc = {
  status: string;
  createdAt: Date;
  contract: { status: string; sentAt: Date | null; viewedAt: Date | null; signedAt: Date | null; expiresAt: Date | null } | null;
};

// The day that goes with a document's status under a call (see docStatus):
// when it was signed, opened, sent or ran out, else when it was made.
export function docDate(deal: DatedDoc): Date {
  const c = deal.contract;
  // "Being written" or "Couldn't read the call": about the deal, not what went out.
  if (!c || deal.status === "processing" || deal.status === "extraction_failed") return deal.createdAt;
  switch (c.status) {
    case "signed":
      return c.signedAt ?? c.sentAt ?? deal.createdAt;
    case "sent":
      return c.viewedAt ?? c.sentAt ?? deal.createdAt;
    case "expired":
      return c.expiresAt ?? c.sentAt ?? deal.createdAt;
    case "partially_signed":
    case "changes_requested":
    case "not_signed":
      return c.sentAt ?? deal.createdAt;
    default:
      return deal.createdAt;
  }
}

// Whether a call's proposal can go out from the lead page, and if not, why:
// the same rule, and words, as the proposal's own page. Not while SealMe is
// still reading the call, and not until the document is made with nothing
// missing.
export function docReadiness(deal: { status: string; hasDocument: boolean; missing: number }): { ready: boolean; hint: string | null } {
  if (deal.status === "processing" || deal.status === "extraction_failed") return { ready: false, hint: "Ready once SealMe has read the call." };
  if (!deal.hasDocument || deal.missing > 0) return { ready: false, hint: "Fill in the missing details first." };
  return { ready: true, hint: null };
}

// The modes "Process anyway" on the Calls page takes (see its History tab).
const PROCESS_ANYWAY_MODES = new Set(["cold", "sales", "notes"]);

export type SetAsideRow = { label: string; chip: string; reason: string | null; fix: { href: string; label: string } | null };

// What a set-aside call's row on the lead says, and the way forward where
// there is one today: Try again (failed) or Process anyway (skipped, with a
// transcript), both on the Calls page. That page shows a rep only their own
// calls, so the link is there only when the call will be on it.
export function setAsideRow(
  call: { status: string; transcript: string | null; mode: string; extracted: unknown },
  options: { onCallsPage: boolean; skipLabels: Record<string, string> },
): SetAsideRow | null {
  if (!LEAD_PAGE_SET_ASIDE_STATUSES.includes(call.status)) return null;
  if (call.status === "failed") {
    return { label: "Couldn't write this call up", chip: "chip-warn", reason: null, fix: options.onCallsPage ? { href: "/calls", label: "Try again in Calls" } : null };
  }
  const extracted = call.extracted && typeof call.extracted === "object" && !Array.isArray(call.extracted) ? (call.extracted as Record<string, unknown>) : {};
  const reason = typeof extracted.skipped === "string" ? (options.skipLabels[extracted.skipped] ?? null) : null;
  const canForce = options.onCallsPage && Boolean(call.transcript?.trim()) && PROCESS_ANYWAY_MODES.has(call.mode);
  return { label: "Nothing was heard on this call", chip: "chip-neutral", reason, fix: canForce ? { href: "/calls?tab=history", label: "Process anyway in Calls" } : null };
}
