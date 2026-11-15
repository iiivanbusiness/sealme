import { describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { REMIND_AFTER_DAYS, daysBetween, daysLabel, needsReminder, proposalRecipient, quietSince, reminderCutoff, stillWaiting, type WaitingDoc } from "./waiting";

const NOW = new Date("2026-11-14T12:00:00Z");
const daysAgo = (n: number, hour = 12) => new Date(Date.UTC(2026, 10, 14 - n, hour));

function proposal(over: Partial<WaitingDoc> = {}, lead: Partial<NonNullable<WaitingDoc["lead"]>> | null = {}): WaitingDoc {
  return {
    kind: "proposal",
    status: "sent",
    sentAt: daysAgo(6),
    viewedAt: null,
    reminderSentAt: null,
    deliveryMethod: "sealme",
    expiresAt: null,
    madeContract: false,
    lead: lead && { isClient: false, clientAt: null, inactive: false, lastCallAt: null, otherDocs: [], ...lead },
    ...over,
  };
}

const contract = (over: Partial<WaitingDoc> = {}) => proposal({ kind: "contract", ...over });

describe("Days on the viewer's calendar", () => {
  it("counts calendar days, not 24-hour stretches", () => {
    expect(daysBetween(new Date("2026-11-13T23:00:00Z"), new Date("2026-11-14T01:00:00Z"), "UTC")).toBe(1);
    expect(daysBetween(new Date("2026-11-14T01:00:00Z"), new Date("2026-11-14T23:00:00Z"), "UTC")).toBe(0);
    // 23:30 UTC is already the next day in Belgrade.
    expect(daysBetween(new Date("2026-11-13T23:30:00Z"), new Date("2026-11-14T09:00:00Z"), "Europe/Belgrade")).toBe(0);
    expect(daysBetween(NOW, daysAgo(2), "UTC")).toBe(0);
  });

  it("reads as Today, 1 day or N days", () => {
    expect(daysLabel(0)).toBe("Today");
    expect(daysLabel(1)).toBe("1 day");
    expect(daysLabel(12)).toBe("12 days");
  });
});

describe("What's still waiting on an answer", () => {
  it("keeps a contract out for signature, partly signed or not, until its link runs out", () => {
    expect(stillWaiting(contract(), NOW)).toBe(true);
    expect(stillWaiting(contract({ status: "partially_signed" }), NOW)).toBe(true);
    expect(stillWaiting(contract({ expiresAt: daysAgo(1) }), NOW)).toBe(false);
    expect(stillWaiting(contract({ expiresAt: daysAgo(-3) }), NOW)).toBe(true);
    expect(stillWaiting(contract({ status: "expired" }), NOW)).toBe(false);
    expect(stillWaiting(contract({ status: "not_signed" }), NOW)).toBe(false);
    // DocuSign runs its own expiry.
    expect(stillWaiting(contract({ deliveryMethod: "docusign", expiresAt: daysAgo(1) }), NOW)).toBe(true);
  });

  it("keeps a proposal until a contract answers it, or the lead signs or goes quiet", () => {
    expect(stillWaiting(proposal(), NOW)).toBe(true);
    expect(stillWaiting(proposal({}, null), NOW)).toBe(true);
    expect(stillWaiting(proposal({ madeContract: true }), NOW)).toBe(false);
    expect(stillWaiting(proposal({}, { otherDocs: [{ kind: "contract", sentAt: daysAgo(2) }] }), NOW)).toBe(false);
    // A contract from before the proposal doesn't answer it.
    expect(stillWaiting(proposal({}, { otherDocs: [{ kind: "contract", sentAt: daysAgo(20) }] }), NOW)).toBe(true);
    // Nor does a newer proposal.
    expect(stillWaiting(proposal({}, { otherDocs: [{ kind: "proposal", sentAt: daysAgo(2) }] }), NOW)).toBe(true);
    expect(stillWaiting(proposal({}, { isClient: true }), NOW)).toBe(false);
    expect(stillWaiting(proposal({}, { isClient: true, clientAt: daysAgo(2) }), NOW)).toBe(false);
    expect(stillWaiting(proposal({}, { inactive: true }), NOW)).toBe(false);
    expect(stillWaiting(proposal({ status: "draft" }), NOW)).toBe(false);
  });
});

describe("A new offer to someone who's already a client", () => {
  it("waits on an answer when they signed before it went out", () => {
    const upsell = proposal({ sentAt: daysAgo(10) }, { isClient: true, clientAt: daysAgo(40), otherDocs: [{ kind: "contract", sentAt: daysAgo(45) }] });
    expect(stillWaiting(upsell, NOW)).toBe(true);
    expect(needsReminder(upsell, NOW)).toBe(true);
    // A contract sent after it still answers it.
    expect(stillWaiting(proposal({ sentAt: daysAgo(10) }, { isClient: true, clientAt: daysAgo(40), otherDocs: [{ kind: "contract", sentAt: daysAgo(3) }] }), NOW)).toBe(false);
  });

  it("is answered when they sign after it went out, or when it isn't known when they did", () => {
    expect(stillWaiting(proposal({ sentAt: daysAgo(10) }, { isClient: true, clientAt: daysAgo(4) }), NOW)).toBe(false);
    expect(stillWaiting(proposal({ sentAt: daysAgo(10) }, { isClient: true, clientAt: daysAgo(10) }), NOW)).toBe(false);
    expect(stillWaiting(proposal({ sentAt: daysAgo(10) }, { isClient: true, clientAt: null }), NOW)).toBe(false);
  });
});

describe("A proposal due a reminder", () => {
  it("shows after 5 days with no answer, not after 4", () => {
    expect(needsReminder(proposal({ sentAt: daysAgo(4) }), NOW)).toBe(false);
    expect(needsReminder(proposal({ sentAt: daysAgo(5) }), NOW)).toBe(true);
    // Five calendar days, even when it's a few hours short of five full days.
    expect(needsReminder(proposal({ sentAt: daysAgo(5, 20) }), NOW)).toBe(true);
    expect(needsReminder(proposal({ sentAt: daysAgo(4, 1) }), NOW)).toBe(false);
  });

  it("counts the days on the viewer's calendar", () => {
    // Sent at 23:30 UTC on Nov 9: already Nov 10 in Belgrade, so only 4 days there.
    const sentAt = new Date("2026-11-09T23:30:00Z");
    expect(needsReminder(proposal({ sentAt }), NOW, 5, "UTC")).toBe(true);
    expect(needsReminder(proposal({ sentAt }), NOW, 5, "Europe/Belgrade")).toBe(false);
  });

  it("still counts one the client opened as having no answer", () => {
    expect(needsReminder(proposal({ viewedAt: daysAgo(3) }), NOW)).toBe(true);
  });

  it("starts the 5 days again after a call with them", () => {
    const doc = proposal({ sentAt: daysAgo(10) }, { lastCallAt: daysAgo(3) });
    expect(quietSince(doc)).toEqual(daysAgo(3));
    expect(needsReminder(doc, NOW)).toBe(false);
    expect(needsReminder(proposal({ sentAt: daysAgo(12) }, { lastCallAt: daysAgo(6) }), NOW)).toBe(true);
    // A call from before it went out changes nothing.
    expect(needsReminder(proposal({ sentAt: daysAgo(6) }, { lastCallAt: daysAgo(9) }), NOW)).toBe(true);
  });

  it("starts the 5 days again after a reminder", () => {
    expect(needsReminder(proposal({ sentAt: daysAgo(12), reminderSentAt: daysAgo(4) }), NOW)).toBe(false);
    expect(needsReminder(proposal({ sentAt: daysAgo(12), reminderSentAt: daysAgo(5) }), NOW)).toBe(true);
  });

  it("leaves one a newer contract replaced, and one a newer proposal took over from", () => {
    expect(needsReminder(proposal({ sentAt: daysAgo(10) }, { otherDocs: [{ kind: "contract", sentAt: daysAgo(8) }] }), NOW)).toBe(false);
    expect(needsReminder(proposal({ sentAt: daysAgo(10) }, { otherDocs: [{ kind: "proposal", sentAt: daysAgo(8) }] }), NOW)).toBe(false);
    expect(needsReminder(proposal({ sentAt: daysAgo(10), madeContract: true }), NOW)).toBe(false);
    // Something older than it doesn't.
    expect(needsReminder(proposal({ sentAt: daysAgo(10) }, { otherDocs: [{ kind: "proposal", sentAt: daysAgo(30) }] }), NOW)).toBe(true);
  });

  it("is only ever for a proposal", () => {
    expect(needsReminder(contract({ sentAt: daysAgo(10) }), NOW)).toBe(false);
    expect(needsReminder(contract({ status: "partially_signed", sentAt: daysAgo(10) }), NOW)).toBe(false);
    expect(needsReminder(contract({ sentAt: daysAgo(10), expiresAt: daysAgo(1) }), NOW)).toBe(false);
    expect(needsReminder(proposal({ sentAt: daysAgo(10) }, { isClient: true }), NOW)).toBe(false);
  });
});

describe("The reminder's own limit", () => {
  it("lets the next one go out five calendar days after the last", () => {
    const cutoff = reminderCutoff(NOW, "UTC");
    expect(cutoff.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    // Sent late on Nov 9 (5 days back): older than the cutoff, so another can go.
    expect(new Date("2026-11-09T23:00:00Z") < cutoff).toBe(true);
    // Sent early on Nov 10 (4 days back): not yet.
    expect(new Date("2026-11-10T00:10:00Z") < cutoff).toBe(false);
    expect(reminderCutoff(NOW, "Europe/Belgrade").toISOString()).toBe("2026-11-09T23:00:00.000Z");
  });

  // Due a reminder by the Dashboard's count, and allowed one by the claim.
  const lastReminded = (reminderSentAt: Date) => proposal({ sentAt: new Date("2026-01-05T12:00:00Z"), reminderSentAt }, null);
  const shown = (reminderSentAt: Date, now: Date, tz: string) => needsReminder(lastReminded(reminderSentAt), now, REMIND_AFTER_DAYS, tz);
  const claimed = (reminderSentAt: Date, now: Date, tz: string) => reminderSentAt < reminderCutoff(now, tz);

  it("agrees with the Send reminder button the week clocks spring forward", () => {
    // New York moved to summer time on Mar 8. Reminded Mar 6 at 10:00, and
    // it's 00:30 on Mar 11: five calendar days.
    let at = new Date("2026-03-06T15:00:00Z");
    let now = new Date("2026-03-11T04:30:00Z");
    expect(reminderCutoff(now, "America/New_York").toISOString()).toBe("2026-03-07T05:00:00.000Z");
    expect(shown(at, now, "America/New_York")).toBe(true);
    expect(claimed(at, now, "America/New_York")).toBe(true);
    // Reminded at 23:30 on Mar 7 (still winter time), and it's noon on
    // Mar 12: midnight on the 8th was 05:00 UTC, not 04:00.
    at = new Date("2026-03-08T04:30:00Z");
    now = new Date("2026-03-12T16:00:00Z");
    expect(reminderCutoff(now, "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(shown(at, now, "America/New_York")).toBe(true);
    expect(claimed(at, now, "America/New_York")).toBe(true);
    // Belgrade moved on Mar 29. Reminded Mar 28 at 14:00, and it's 00:30 on Apr 2.
    at = new Date("2026-03-28T13:00:00Z");
    now = new Date("2026-04-01T22:30:00Z");
    expect(reminderCutoff(now, "Europe/Belgrade").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(shown(at, now, "Europe/Belgrade")).toBe(true);
    expect(claimed(at, now, "Europe/Belgrade")).toBe(true);
  });

  it("agrees with the Send reminder button the week clocks fall back", () => {
    // New York went back to winter time on Nov 1. Reminded Oct 31 at 10:00,
    // and it's 23:30 on Nov 4: only four calendar days, so neither lets it go.
    let at = new Date("2026-10-31T14:00:00Z");
    let now = new Date("2026-11-05T04:30:00Z");
    expect(reminderCutoff(now, "America/New_York").toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(shown(at, now, "America/New_York")).toBe(false);
    expect(claimed(at, now, "America/New_York")).toBe(false);
    // Belgrade went back on Oct 25. Reminded Oct 24 at 10:00, and it's 23:30 on Oct 28.
    at = new Date("2026-10-24T08:00:00Z");
    now = new Date("2026-10-28T22:30:00Z");
    expect(reminderCutoff(now, "Europe/Belgrade").toISOString()).toBe("2026-10-23T22:00:00.000Z");
    expect(shown(at, now, "Europe/Belgrade")).toBe(false);
    expect(claimed(at, now, "Europe/Belgrade")).toBe(false);
  });

  it("draws the line at the same instant as the button, every half hour around a clock change", () => {
    const changes: [string, string][] = [
      ["America/New_York", "2026-03-08T00:00:00Z"],
      ["America/New_York", "2026-11-01T00:00:00Z"],
      ["Europe/Belgrade", "2026-03-29T00:00:00Z"],
      ["Europe/Belgrade", "2026-10-25T00:00:00Z"],
    ];
    for (const [tz, change] of changes) {
      // From the day before the change to a week after it.
      for (let t = Date.parse(change) - 24 * 3600_000; t < Date.parse(change) + 8 * 24 * 3600_000; t += 30 * 60_000) {
        const now = new Date(t);
        const cutoff = reminderCutoff(now, tz);
        // A reminder a minute before the cutoff is due and can be claimed;
        // one at the cutoff is neither. Earlier or later only moves further
        // the same way.
        const before = new Date(cutoff.getTime() - 60_000);
        expect([tz, now.toISOString(), shown(before, now, tz)]).toEqual([tz, now.toISOString(), true]);
        expect([tz, now.toISOString(), shown(cutoff, now, tz)]).toEqual([tz, now.toISOString(), false]);
      }
    }
  });
});

describe("Who a reminder goes to", () => {
  it("goes where the proposal was emailed, else the client's or the lead's email", () => {
    expect(proposalRecipient(JSON.stringify({ to: "jane@acme.test" }), "office@acme.test", "lead@acme.test")).toBe("jane@acme.test");
    expect(proposalRecipient(null, "office@acme.test", "lead@acme.test")).toBe("office@acme.test");
    expect(proposalRecipient(null, null, "lead@acme.test")).toBe("lead@acme.test");
    expect(proposalRecipient("not json", " ", null)).toBeNull();
    expect(proposalRecipient(JSON.stringify({ to: 42 }), null, null)).toBeNull();
  });
});
