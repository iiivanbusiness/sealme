import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { NEW_LEAD_NAME } from "@/lib/cold-call";

export type MeetingLead = { id: string; name: string; company: string | null; email: string | null; isClient: boolean };

// Who a meeting is with: the lead on file when there is one the viewer can
// see, else what the calendar says (a name, an email or both).
export type MeetingPerson = { lead: MeetingLead | null; name: string | null; email: string | null };

type Meeting = { id: string; clientName: string | null; attendeeEmail: string | null };

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+$/.test(s);
const key = (s: string) => s.trim().toLowerCase();

// The name a meeting gives, when it's a name and not the email standing in
// for one (see syncWorkspaceCalendar).
function meetingName(m: Meeting): string | null {
  const name = m.clientName?.trim();
  return name && !looksLikeEmail(name) ? name : null;
}

// Matches meetings to leads, from the leads the viewer can see (listed most
// recently updated first). By email first: the attendee's email on a lead is
// that lead, the latest if several have it. Else by name, only when exactly
// one lead has that name and nothing says it's someone else (it has no
// email, or the meeting doesn't either): two "Dana Lee"s, or a Dana Lee on
// file with another email, could be another person, so Start call asks.
export function matchMeetingPeople(meetings: Meeting[], leads: MeetingLead[]): Map<string, MeetingPerson> {
  const byEmail = new Map<string, MeetingLead>();
  const byName = new Map<string, MeetingLead[]>();
  for (const lead of leads) {
    if (lead.email && !byEmail.has(key(lead.email))) byEmail.set(key(lead.email), lead);
    if (lead.name !== NEW_LEAD_NAME) byName.set(key(lead.name), [...(byName.get(key(lead.name)) ?? []), lead]);
  }
  const people = new Map<string, MeetingPerson>();
  for (const m of meetings) {
    const email = m.attendeeEmail ? key(m.attendeeEmail) : null;
    const name = meetingName(m);
    const named = name ? byName.get(key(name)) : undefined;
    const onlyOne = named?.length === 1 && (!email || !named[0].email) ? named[0] : null;
    people.set(m.id, { lead: (email ? byEmail.get(email) : undefined) ?? onlyOne, name, email });
  }
  return people;
}

// The same, looking the leads up: one query for the emails and names of
// all the meetings at once, inside what the viewer can see (leadAccess).
export async function meetingPeople(workspaceId: string, visible: Prisma.LeadWhereInput, meetings: Meeting[]): Promise<Map<string, MeetingPerson>> {
  const emails = [...new Set(meetings.flatMap((m) => (m.attendeeEmail ? [key(m.attendeeEmail)] : [])))];
  const names = [...new Set(meetings.flatMap((m) => meetingName(m) ?? []))];
  if (emails.length === 0 && names.length === 0) return matchMeetingPeople(meetings, []);
  // OR of equals rather than `in`: a lead's email or name isn't always
  // stored in lower case (imports keep what the file had).
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId,
      AND: [
        visible,
        {
          OR: [
            ...emails.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })),
            ...names.map((name) => ({ name: { equals: name, mode: "insensitive" as const } })),
          ],
        },
      ],
    },
    select: { id: true, name: true, company: true, email: true, isClient: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return matchMeetingPeople(meetings, leads);
}

// What Start call opens with for this person: their lead, or the email (and
// the name, so a lead made from it is named) or the name to search by.
export function startCallFor(person: MeetingPerson | undefined): { leadId?: string; who?: string; name?: string } {
  if (!person) return {};
  if (person.lead) return { leadId: person.lead.id };
  if (person.email) return { who: person.email, ...(person.name ? { name: person.name } : {}) };
  return person.name ? { who: person.name } : {};
}
