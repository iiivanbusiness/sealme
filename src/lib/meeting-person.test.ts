import { describe, expect, it, vi } from "vitest";

const { lead } = vi.hoisted(() => ({ lead: { findMany: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: { lead } }));

import { matchMeetingPeople, meetingPeople, startCallFor, type MeetingLead } from "./meeting-person";
import { startCallHref } from "./start-call";

const dana: MeetingLead = { id: "l-dana", name: "Dana Lee", company: "Northgate", email: "Dana@Northgate.io", isClient: false };
const sam: MeetingLead = { id: "l-sam", name: "Sam Ortiz", company: null, email: null, isClient: true };

describe("Who a meeting is with", () => {
  it("finds the lead by the attendee's email, whatever the case", () => {
    const people = matchMeetingPeople([{ id: "m1", clientName: "dana@northgate.io", attendeeEmail: "dana@northgate.io" }], [dana]);
    expect(people.get("m1")).toEqual({ lead: dana, name: null, email: "dana@northgate.io" });
  });

  it("takes the most recently updated lead when two have the email", () => {
    const older = { ...dana, id: "l-old" };
    expect(matchMeetingPeople([{ id: "m1", clientName: null, attendeeEmail: "dana@northgate.io" }], [dana, older]).get("m1")?.lead?.id).toBe("l-dana");
  });

  it("goes by name only when exactly one lead has it", () => {
    expect(matchMeetingPeople([{ id: "m1", clientName: "sam ortiz", attendeeEmail: null }], [sam]).get("m1")?.lead).toEqual(sam);
    const twin = { ...sam, id: "l-sam-2" };
    expect(matchMeetingPeople([{ id: "m1", clientName: "Sam Ortiz", attendeeEmail: null }], [sam, twin]).get("m1")?.lead).toBeNull();
  });

  it("doesn't take a same-name lead who has another email", () => {
    const people = matchMeetingPeople([{ id: "m1", clientName: "Dana Lee", attendeeEmail: "dana.lee@other.com" }], [dana]);
    expect(people.get("m1")).toEqual({ lead: null, name: "Dana Lee", email: "dana.lee@other.com" });
    // A same-name lead with no email on file can be them.
    const noEmail = { ...dana, email: null };
    expect(matchMeetingPeople([{ id: "m1", clientName: "Dana Lee", attendeeEmail: "dana.lee@other.com" }], [noEmail]).get("m1")?.lead).toEqual(noEmail);
  });

  it("never matches a lead still waiting for a call to name it", () => {
    const placeholder = { ...sam, name: "New lead from a call" };
    expect(matchMeetingPeople([{ id: "m1", clientName: "New lead from a call", attendeeEmail: null }], [placeholder]).get("m1")?.lead).toBeNull();
  });

  it("looks the leads up once, inside what the viewer can see", async () => {
    lead.findMany.mockResolvedValueOnce([dana]);
    const visible = { OR: [{ ownerId: "u1" }] };
    const people = await meetingPeople("ws-1", visible, [
      { id: "m1", clientName: "Dana", attendeeEmail: "DANA@northgate.io" },
      { id: "m2", clientName: "dana@northgate.io", attendeeEmail: "dana@northgate.io" },
      { id: "m3", clientName: null, attendeeEmail: null },
    ]);
    expect(lead.findMany).toHaveBeenCalledTimes(1);
    const where = lead.findMany.mock.calls[0][0].where;
    expect(where.workspaceId).toBe("ws-1");
    expect(where.AND[0]).toBe(visible);
    expect(where.AND[1].OR).toEqual([
      { email: { equals: "dana@northgate.io", mode: "insensitive" } },
      { name: { equals: "Dana", mode: "insensitive" } },
    ]);
    expect(people.get("m1")?.lead?.id).toBe("l-dana");
    expect(people.get("m2")?.lead?.id).toBe("l-dana");
    expect(people.get("m3")).toEqual({ lead: null, name: null, email: null });
  });

  it("asks nothing when no meeting names anyone", async () => {
    lead.findMany.mockClear();
    await meetingPeople("ws-1", {}, [{ id: "m1", clientName: null, attendeeEmail: null }]);
    expect(lead.findMany).not.toHaveBeenCalled();
  });
});

describe("Starting a call from a meeting", () => {
  it("opens on the lead, else the email with the name, else the name", () => {
    expect(startCallFor({ lead: dana, name: "Dana", email: "dana@northgate.io" })).toEqual({ leadId: "l-dana" });
    expect(startCallFor({ lead: null, name: "Kim Park", email: "kim@client.com" })).toEqual({ who: "kim@client.com", name: "Kim Park" });
    expect(startCallFor({ lead: null, name: null, email: "kim@client.com" })).toEqual({ who: "kim@client.com" });
    expect(startCallFor({ lead: null, name: "Kim Park", email: null })).toEqual({ who: "Kim Park" });
    expect(startCallFor({ lead: null, name: null, email: null })).toEqual({});
  });

  it("links to Start call with only what's known, recording live in the desktop app", () => {
    expect(startCallHref({ leadId: "l-dana", who: "ignored@x.com" }, false)).toBe("/deals/new?lead=l-dana");
    expect(startCallHref({ who: "kim@client.com", name: "Kim Park" }, false)).toBe("/deals/new?who=kim%40client.com&name=Kim+Park");
    expect(startCallHref({ who: "kim@client.com" }, true)).toBe("/deals/new?who=kim%40client.com&mode=local");
    expect(startCallHref({}, false)).toBe("/deals/new");
    expect(startCallHref({}, true)).toBe("/deals/new?mode=local");
  });
});
