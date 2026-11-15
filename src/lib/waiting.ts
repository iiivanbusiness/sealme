// What's out with a client and waiting on their answer: the Dashboard's
// Waiting on an answer, and the proposals under Needs you that are due a
// reminder. Pure, so the rules can be tested; the queries are in
// dashboard-data.ts and the reminder itself in deals/[id]/reminder-actions.ts.
import { contractExpired } from "@/lib/contract-status";
import { dayInZone, instantInZone } from "@/lib/viewer-time";

const DAY = 24 * 60 * 60 * 1000;

// A proposal with no answer for this many days shows under Needs you with
// Send reminder, and a reminder goes out at most this often.
export const REMIND_AFTER_DAYS = 5;

export type WaitingDoc = {
  kind: string; // the deal's: "proposal" or "contract"
  status: string; // the contract row's
  sentAt: Date;
  viewedAt: Date | null;
  reminderSentAt: Date | null;
  deliveryMethod: string;
  expiresAt: Date | null;
  // A contract made from this proposal went out to the client and isn't in
  // the trash. A draft nobody sent yet doesn't answer the proposal.
  madeContract: boolean;
  // Who it's for. Null on a document with no lead (older ones).
  lead: {
    isClient: boolean;
    // When they became a client. Null when unknown (older data): then their
    // signing answers every proposal.
    clientAt: Date | null;
    inactive: boolean; // leadIsInactive: lost, not now, not signed, or nothing for 30 days
    lastCallAt: Date | null; // the latest call where they picked up and talked (no answer or a failed call doesn't count)
    // When the lead's other proposals and contracts went to them.
    otherDocs: { kind: string; sentAt: Date }[];
  } | null;
};

// Calendar days from a to b on the viewer's clock: 0 on the same day, never
// below 0. Formatted on the server, so the page reads the same before and
// after hydration.
export function daysBetween(a: Date, b: Date, tz: string): number {
  const days = Math.round((Date.parse(dayInZone(b, tz)) - Date.parse(dayInZone(a, tz))) / DAY);
  return Math.max(0, days);
}

// "Today", "1 day", "12 days".
export function daysLabel(days: number): string {
  if (days <= 0) return "Today";
  return `${days.toLocaleString("en-US")} ${days === 1 ? "day" : "days"}`;
}

// Still waiting on the client. A contract: out for signature with a link
// that still works (one marked not signed or expired isn't "sent" anymore,
// and a SealMe link past its date counts already, see contractExpired). A
// proposal never closes by itself, so it waits until a contract answers it
// (one made from it that went out, or any contract sent to the lead after
// it, the same rule as the lead's stage), or the lead signs or goes inactive.
// Signing only answers proposals sent before it: one sent to a lead who was
// already a client is a new offer (an upsell) and waits like any other.
export function stillWaiting(doc: WaitingDoc, now = new Date()): boolean {
  if (doc.kind !== "proposal") return (doc.status === "sent" || doc.status === "partially_signed") && !contractExpired(doc, now);
  if (doc.status !== "sent" || doc.madeContract) return false;
  if (!doc.lead) return true;
  if (doc.lead.isClient && (!doc.lead.clientAt || doc.lead.clientAt.getTime() >= doc.sentAt.getTime())) return false;
  if (doc.lead.inactive) return false;
  return !doc.lead.otherDocs.some((d) => d.kind !== "proposal" && d.sentAt.getTime() > doc.sentAt.getTime());
}

// Since when nothing has happened: it went out, the last reminder, or the
// latest call where they talked, whichever came last. The client opening it
// isn't an answer. Waiting on an answer sorts and counts by this, and so
// does the reminder under Needs you.
export function quietSince(doc: WaitingDoc): Date {
  const times = [doc.sentAt, doc.reminderSentAt, doc.lead?.lastCallAt].filter((d): d is Date => d != null).map((d) => d.getTime());
  return new Date(Math.max(...times));
}

// Due a "Send reminder": a proposal still waiting, quiet for `days` days on
// the viewer's calendar, and the newest thing the lead got (when a newer
// proposal or contract went to them, that's the one in play).
export function needsReminder(doc: WaitingDoc, now = new Date(), days = REMIND_AFTER_DAYS, tz = "UTC"): boolean {
  if (doc.kind !== "proposal" || !stillWaiting(doc, now)) return false;
  if (doc.lead?.otherDocs.some((d) => d.sentAt.getTime() > doc.sentAt.getTime())) return false;
  return daysBetween(quietSince(doc), now, tz) >= days;
}

// The instant the last reminder has to be older than for another to go
// out: the start of the viewer's day (days - 1) days back, so "5 days"
// means five calendar days on their clock, the same as needsReminder. The
// days are counted on the date, not in 24-hour steps, so a week the clocks
// change doesn't land a day off.
export function reminderCutoff(now: Date, tz: string, days = REMIND_AFTER_DAYS): Date {
  const day = new Date(Date.parse(dayInZone(now, tz)) - (days - 1) * DAY).toISOString().slice(0, 10);
  return instantInZone(day, "00:00", tz);
}

// Who a proposal's reminder goes to: the address its latest email send
// went to (the rep can type any address on the Send page, and it isn't kept
// on the client), else the client's email, else the lead's. lastSend is
// that send's audit metadata ({"to": ...}). A proposal only ever shared by
// Copy link may have none.
export function proposalRecipient(lastSend: string | null | undefined, clientEmail: string | null | undefined, leadEmail: string | null | undefined): string | null {
  let sentTo: string | null = null;
  try {
    const to = lastSend ? (JSON.parse(lastSend) as { to?: unknown }).to : null;
    sentTo = typeof to === "string" && to.includes("@") ? to.trim() : null;
  } catch {
    sentTo = null;
  }
  return sentTo || clientEmail?.trim() || leadEmail?.trim() || null;
}
