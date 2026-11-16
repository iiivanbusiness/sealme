import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { inactiveCutoff, leadIsInactive, leadTabWhere } from "@/lib/lead-pipeline";
import { NEW_LEAD_NAME, PLACEHOLDER_CLIENT } from "@/lib/cold-call";
import { docStatus } from "@/lib/doc-status";
import { currentUserWithRole } from "@/lib/permissions";
import { REMIND_AFTER_DAYS, daysBetween, needsReminder, proposalRecipient, quietSince, reminderCutoff, stillWaiting, type WaitingDoc } from "@/lib/waiting";

type UserWithRole = Awaited<ReturnType<typeof currentUserWithRole>>;

// Waiting on an answer lists this many, longest silence first, then says
// how many more. Each group under Needs you shows GROUP_SHOWN.
const WAITING_SHOWN = 50;
const GROUP_SHOWN = 10;
// How many sent documents are read, oldest first, to find those. Past
// that the rest are only counted.
const SENT_LOADED = 500;

// A contract made from a proposal that answers it: one that went out to the
// client and isn't in the trash.
const ANSWERING_CONTRACT = { trashedAt: null, kind: { not: "proposal" }, contract: { sentAt: { not: null } } } satisfies Prisma.DealWhereInput;

// A call where someone picked up and talked (what Analytics counts as
// connected). Ringing out, no answer, voicemail or a failed call isn't
// hearing back, so it doesn't restart the quiet days.
const TALKED = { status: "processed", connected: true } satisfies Prisma.PhoneCallWhereInput;

export type WaitingRow = {
  dealId: string;
  kind: "proposal" | "contract";
  name: string;
  service: string;
  days: number; // quiet for, on the viewer's calendar (see quietSince)
  opened: boolean;
  partlySigned: boolean;
  calledDays: number | null; // the last call where they talked, when it came after the send
  remindedDays: number | null;
  owner: string | null; // only on the team's list
};

export type ReminderRow = { dealId: string; contractId: string; name: string; quietDays: number; opened: boolean; to: string | null };
export type ToSendRow = { dealId: string; name: string; service: string; label: string; chip: string; href: string; cta: string };
export type ApprovalRow = { dealId: string; name: string; service: string };

export type NeedsYouData = {
  reminders: { rows: ReminderRow[]; more: number };
  toSend: { rows: ToSendRow[]; more: number };
  approvals: ApprovalRow[];
  // count is calls, leads the leads they're on (naming one lead names all
  // its calls).
  unnamed: { count: number; leads: number; href: string } | null;
  callsToCheck: number;
};

export type WaitingData = { rows: WaitingRow[]; more: number; team: boolean };

// Who a document is with, by name: the lead's name, else the client's,
// skipping "New lead from a call" and "New client" when the other one has
// a real name.
function whoName(leadName: string | null | undefined, clientName: string): string {
  const real = (n: string | null | undefined) => Boolean(n && n !== NEW_LEAD_NAME && n !== PLACEHOLDER_CLIENT);
  return [leadName, clientName].find(real) ?? leadName ?? clientName;
}

// What can still be waiting on the client, narrowed in the query so the
// proposals that went nowhere don't take the room (a proposal stays "sent"
// for good). The same rules as stillWaiting, which still has the last word:
// a contract sent to the lead after the proposal, or whether a client signed
// before or after it went out, can't be told here.
function canStillWait(now: Date): Prisma.ContractWhereInput {
  return {
    sentAt: { not: null },
    OR: [
      // Out for signature, unless its SealMe link ran out (contractExpired).
      {
        status: { in: ["sent", "partially_signed"] },
        deal: { kind: { not: "proposal" } },
        OR: [{ status: "partially_signed" }, { deliveryMethod: { not: "sealme" } }, { expiresAt: null }, { expiresAt: { gt: now } }],
      },
      // A proposal no contract made from it went out for, for a lead that
      // hasn't signed or gone inactive (or with no lead at all), or for a
      // client, who may have signed before it went out (an upsell). A draft
      // contract nobody sent yet leaves the proposal waiting.
      {
        status: "sent",
        deal: {
          kind: "proposal",
          derivedDeals: { none: ANSWERING_CONTRACT },
          OR: [{ leadId: null }, { lead: leadTabWhere("active", now) }, { lead: { isClient: true, clientAt: { not: null } } }],
        },
      },
    ],
  };
}

// Sent documents with what stillWaiting and needsReminder need, longest
// out first (Waiting on an answer then sorts them by silence).
function loadSent(where: Prisma.ContractWhereInput) {
  return prisma.contract.findMany({
    where,
    select: {
      id: true,
      status: true,
      sentAt: true,
      viewedAt: true,
      reminderSentAt: true,
      deliveryMethod: true,
      expiresAt: true,
      deal: {
        select: {
          id: true,
          kind: true,
          service: true,
          ownerId: true,
          owner: { select: { name: true } },
          client: { select: { name: true, email: true } },
          derivedDeals: { where: ANSWERING_CONTRACT, select: { id: true }, take: 1 },
          lead: {
            select: {
              name: true,
              email: true,
              isClient: true,
              clientAt: true,
              pipelineStage: true,
              lastActivityAt: true,
              createdAt: true,
              phoneCalls: { where: TALKED, orderBy: { startedAt: "desc" }, take: 1, select: { startedAt: true } },
              deals: { where: { trashedAt: null, contract: { sentAt: { not: null } } }, select: { id: true, kind: true, contract: { select: { sentAt: true } } } },
            },
          },
        },
      },
    },
    orderBy: { sentAt: "asc" },
    take: SENT_LOADED,
  });
}

type SentContract = Awaited<ReturnType<typeof loadSent>>[number];

// The ones stillWaiting keeps, in the order read.
function waitingFrom(sent: SentContract[], now: Date) {
  return sent
    .map((c) => {
      const lead = c.deal.lead;
      const doc: WaitingDoc = {
        kind: c.deal.kind === "proposal" ? "proposal" : "contract",
        status: c.status,
        sentAt: c.sentAt!,
        viewedAt: c.viewedAt,
        reminderSentAt: c.reminderSentAt,
        deliveryMethod: c.deliveryMethod,
        expiresAt: c.expiresAt,
        madeContract: c.deal.derivedDeals.length > 0,
        lead: lead && {
          isClient: lead.isClient,
          clientAt: lead.clientAt,
          inactive: leadIsInactive(lead, now),
          lastCallAt: lead.phoneCalls[0]?.startedAt ?? null,
          otherDocs: lead.deals.filter((d) => d.id !== c.deal.id && d.contract?.sentAt).map((d) => ({ kind: d.kind, sentAt: d.contract!.sentAt! })),
        },
      };
      return { c, doc, name: whoName(lead?.name, c.deal.client.name) };
    })
    .filter(({ doc }) => stillWaiting(doc, now));
}

// How many matched past the SENT_LOADED that were read: 0 when the window
// wasn't full, else counted, so "and N more" stays true.
async function unread(loaded: number, where: Prisma.ContractWhereInput): Promise<number> {
  if (loaded < SENT_LOADED) return 0;
  return Math.max(0, (await prisma.contract.count({ where })) - loaded);
}

// Everything below the Start a call card that isn't the calendar: what
// needs the viewer, and what's out with clients. On the iPhone app (phone)
// the proposals and contracts stay on the computer (see phone-app.ts), so
// only calls are asked about there.
export async function dashboardData(o: { workspaceId: string; me: UserWithRole; tz: string; now?: Date; phone?: boolean }): Promise<{ needs: NeedsYouData; waiting: WaitingData | null }> {
  const { workspaceId, me, tz } = o;
  const now = o.now ?? new Date();
  const docs = !o.phone;
  const { where: visibility, canViewAll } = await dealVisibilityFilter(me);

  // The viewer's own documents. One with no owner (made through the API, or
  // older data) is whoever owns its lead's, and when the lead has no owner
  // either (or there's no lead), it's for the people who see every deal, so
  // it still reaches someone.
  const mine: Prisma.DealWhereInput = {
    OR: [
      { ownerId: me.id },
      { ownerId: null, lead: { ownerId: me.id } },
      ...(canViewAll ? [{ ownerId: null, OR: [{ leadId: null }, { lead: { ownerId: null } }] }] : []),
    ],
  };
  // Out with a client. Someone who sees every deal sees the team's, the
  // rest their own. Filtered on the contract's status, never the deal's: a
  // contract marked not signed keeps its deal at "sent".
  const sentWhere: Prisma.ContractWhereInput = { AND: [canStillWait(now), { deal: { workspaceId, trashedAt: null, AND: [visibility, canViewAll ? {} : mine] } }] };
  // The viewer's own proposals quiet since before the reminder cutoff, read
  // on their own so a busy team's sends don't push them out of the window.
  const cutoff = reminderCutoff(now, tz);
  const dueWhere: Prisma.ContractWhereInput = {
    AND: [
      canStillWait(now),
      { sentAt: { lt: cutoff }, OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: cutoff } }] },
      { deal: { workspaceId, trashedAt: null, kind: "proposal", AND: [visibility, mine] } },
    ],
  };

  // The viewer's written-up calls whose lead still has no name. Only recent
  // ones: by 30 days the lead counts as inactive anyway.
  const unnamedWhere: Prisma.PhoneCallWhereInput = { workspaceId, userId: me.id, status: "processed", leadId: { not: null }, startedAt: { gte: inactiveCutoff(now) }, lead: { name: NEW_LEAD_NAME } };

  const [sent, dueSent, toSend, approvals, unnamed, unnamedCalls, callsToCheck, members] = await Promise.all([
    docs ? loadSent(sentWhere) : Promise.resolve([]),
    docs ? loadSent(dueWhere) : Promise.resolve([]),
    // The viewer's contracts that are theirs to finish and send (one with
    // no owner goes by mine, like the reminders).
    docs
      ? prisma.deal.findMany({
          where: { workspaceId, trashedAt: null, kind: { not: "proposal" }, status: { in: ["ready", "missing_info", "changes_requested"] }, AND: [visibility, mine] },
          select: { id: true, status: true, service: true, client: { select: { name: true } }, lead: { select: { name: true } }, contract: { select: { status: true, viewedAt: true } } },
          orderBy: { updatedAt: "desc" },
          take: 100,
        })
      : Promise.resolve([]),
    // Contracts waiting on the viewer's approval.
    docs
      ? prisma.reviewStep.findMany({
          where: { status: "pending", assigneeId: me.id, contract: { status: "pending_approval", deal: { workspaceId, trashedAt: null } } },
          select: {
            id: true,
            contract: {
              select: {
                reviewSteps: { where: { status: "pending" }, orderBy: { order: "asc" }, take: 1, select: { id: true } },
                deal: { select: { id: true, service: true, client: { select: { name: true } }, lead: { select: { name: true } } } },
              },
            },
          },
          take: 20,
        })
      : Promise.resolve([]),
    // The leads those calls are on, for the link, and how many calls.
    prisma.phoneCall.findMany({ where: unnamedWhere, select: { leadId: true }, distinct: ["leadId"], orderBy: { startedAt: "desc" }, take: 100 }),
    prisma.phoneCall.count({ where: unnamedWhere }),
    // Calls waiting for the viewer to say who they were with, or to try again.
    prisma.phoneCall.count({ where: { workspaceId, userId: me.id, status: { in: ["pending", "failed"] } } }),
    canViewAll ? prisma.user.count({ where: { workspaceId, deactivatedAt: null } }) : 1,
  ]);

  // Longest silence on top: quiet since the send, the last call where they
  // talked or the last reminder, whichever came last (see quietSince). A
  // tie keeps the oldest send first.
  const waitingDocs = waitingFrom(sent, now)
    .map((d) => ({ ...d, quiet: quietSince(d.doc) }))
    .sort((a, b) => a.quiet.getTime() - b.quiet.getTime());

  // The viewer's own proposals with no answer for 5 days, quietest first.
  const due = waitingFrom(dueSent, now)
    .filter(({ doc }) => needsReminder(doc, now, REMIND_AFTER_DAYS, tz))
    .map((d) => ({ ...d, quietDays: daysBetween(quietSince(d.doc), now, tz) }))
    .sort((a, b) => b.quietDays - a.quietDays);
  const dueShown = due.slice(0, GROUP_SHOWN);
  const [lastSends, waitingUnread, dueUnread] = await Promise.all([
    dueShown.length
      ? prisma.auditLog.findMany({
          where: { workspaceId, action: "proposal.sent", targetType: "Deal", targetId: { in: dueShown.map((d) => d.c.deal.id) } },
          orderBy: { createdAt: "desc" },
          select: { targetId: true, metadata: true },
        })
      : Promise.resolve([]),
    unread(sent.length, sentWhere),
    unread(dueSent.length, dueWhere),
  ]);
  const lastSendFor = (dealId: string) => lastSends.find((a) => a.targetId === dealId)?.metadata ?? null;

  // Owners' names only on a team: alone, every row would say you.
  const team = canViewAll && members >= 2;
  const waiting: WaitingData | null = docs
    ? {
        rows: waitingDocs.slice(0, WAITING_SHOWN).map(({ c, doc, name, quiet }) => {
          const call = doc.lead?.lastCallAt;
          return {
            dealId: c.deal.id,
            kind: doc.kind as "proposal" | "contract",
            name,
            service: c.deal.service,
            days: daysBetween(quiet, now, tz),
            opened: Boolean(c.viewedAt),
            partlySigned: c.status === "partially_signed",
            // A call after the send is said on the row: the days may count
            // from it rather than from the send.
            calledDays: call && call.getTime() > doc.sentAt.getTime() ? daysBetween(call, now, tz) : null,
            remindedDays: c.reminderSentAt ? daysBetween(c.reminderSentAt, now, tz) : null,
            owner: team ? (c.deal.owner?.name ?? "Unassigned") : null,
          };
        }),
        more: Math.max(0, waitingDocs.length + waitingUnread - WAITING_SHOWN),
        team,
      }
    : null;

  const myApprovals = approvals.filter((s) => s.contract.reviewSteps[0]?.id === s.id).map((s) => s.contract.deal);
  const unnamedIds = unnamed.map((c) => c.leadId).filter((id): id is string => Boolean(id));

  return {
    waiting,
    needs: {
      reminders: {
        rows: dueShown.map(({ c, name, quietDays }) => ({
          dealId: c.deal.id,
          contractId: c.id,
          name,
          quietDays,
          opened: Boolean(c.viewedAt),
          to: proposalRecipient(lastSendFor(c.deal.id), c.deal.client.email, c.deal.lead?.email),
        })),
        more: Math.max(0, due.length + dueUnread - GROUP_SHOWN),
      },
      toSend: {
        rows: toSend.slice(0, GROUP_SHOWN).map((d) => {
          const status = docStatus(d);
          const details = d.status === "missing_info" || !d.contract;
          return {
            dealId: d.id,
            name: whoName(d.lead?.name, d.client.name),
            service: d.service,
            label: d.status === "ready" ? "Ready to send" : status.label,
            chip: d.status === "ready" ? "chip-active" : status.chip,
            // The contract screen: opened on its terms list when there are
            // blanks to fill in.
            href: details ? `/deals/${d.id}#missing` : `/deals/${d.id}`,
            cta: details ? "Fill in details" : "Review and send",
          };
        }),
        more: Math.max(0, toSend.length - GROUP_SHOWN),
      },
      approvals: myApprovals.map((d) => ({ dealId: d.id, name: whoName(d.lead?.name, d.client.name), service: d.service })),
      // One lead goes straight to its edit form; several to Leads, searched.
      unnamed: unnamedIds.length
        ? {
            // Read apart from the list, so a call written up in between can't
            // make it say fewer calls than leads.
            count: Math.max(unnamedCalls, unnamedIds.length),
            leads: unnamedIds.length,
            href: unnamedIds.length === 1 ? `/leads/${unnamedIds[0]}?edit=1` : `/leads?tab=all&q=${encodeURIComponent(NEW_LEAD_NAME)}`,
          }
        : null,
      callsToCheck,
    },
  };
}

// The setup guide's questions about deals, without loading every deal:
// any deal at all, a contract that went out, and the latest contract that
// can go out now.
export async function guideDeals(workspaceId: string, me: UserWithRole): Promise<{ hasDeal: boolean; hasSentContract: boolean; readyDealId: string | null }> {
  const { where: visibility } = await dealVisibilityFilter(me);
  const base = { workspaceId, trashedAt: null, AND: [visibility] };
  const [any, sentContract, ready] = await Promise.all([
    prisma.deal.findFirst({ where: base, select: { id: true } }),
    // The guide's steps are about contracts: a sent proposal doesn't count.
    prisma.deal.findFirst({ where: { ...base, kind: { not: "proposal" }, status: { in: ["sent", "signed"] } }, select: { id: true } }),
    prisma.deal.findFirst({ where: { ...base, kind: { not: "proposal" }, status: { in: ["ready", "pending_approval", "changes_requested"] } }, select: { id: true }, orderBy: { updatedAt: "desc" } }),
  ]);
  return { hasDeal: Boolean(any), hasSentContract: Boolean(sentContract), readyDealId: ready?.id ?? null };
}
