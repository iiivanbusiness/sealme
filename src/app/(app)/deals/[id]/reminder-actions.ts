"use server";

import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { logAudit } from "@/lib/audit";
import { reportError } from "@/lib/error-report";
import { isEmailConfigured, sendProposalReminderEmail } from "@/lib/email";
import { clientDocumentUrl } from "@/lib/document-links";
import { cookieTimeZone } from "@/lib/viewer-time";
import { NEW_LEAD_NAME, PLACEHOLDER_CLIENT } from "@/lib/cold-call";
import { REMIND_AFTER_DAYS, proposalRecipient, reminderCutoff } from "@/lib/waiting";

const ALREADY_REMINDED = `Already reminded in the last ${REMIND_AFTER_DAYS} days`;
const EMAIL_OFF = "Email sending isn't set up yet, so the reminder wasn't sent";

// The proposal a reminder is for, if this person can see it and it's out
// with the client. Contracts never get one from here: DocuSign reminds the
// client itself, and a SealMe sign link has the workspace's auto-remind.
async function proposalOut(dealId: string) {
  const workspaceId = await requireWorkspaceId();
  const { where } = await dealVisibilityFilter();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    select: {
      id: true,
      kind: true,
      trashedAt: true,
      leadId: true,
      client: { select: { name: true, email: true } },
      lead: { select: { name: true, email: true } },
      workspace: { select: { name: true, senderEmail: true, senderDomainStatus: true } },
      contract: { select: { id: true, status: true, reminderSentAt: true } },
    },
  });
  if (!deal) return { error: "Proposal not found" } as const;
  if (deal.kind !== "proposal") return { error: "Reminders from SealMe are for proposals only" } as const;
  if (deal.trashedAt) return { error: "This proposal is in the trash. Restore it first" } as const;
  if (!deal.contract || deal.contract.status !== "sent") return { error: "This proposal isn't out with the client" } as const;
  return { workspaceId, deal, contract: deal.contract } as const;
}

// Takes the reminder slot: at most one every REMIND_AFTER_DAYS days on the
// clicker's calendar, however many people click at once (the update only
// matches while the last reminder is old enough).
async function claimReminder(contractId: string, now: Date): Promise<boolean> {
  const cutoff = reminderCutoff(now, await cookieTimeZone());
  const { count } = await prisma.contract.updateMany({
    where: { id: contractId, status: "sent", OR: [{ reminderSentAt: null }, { reminderSentAt: { lt: cutoff } }] },
    data: { reminderSentAt: now },
  });
  return count > 0;
}

// What a reminder (or the link copied for one) does besides: it's on the
// record, and it's the rep working the lead, so the lead stays active.
// Nothing here refreshes the page: any revalidatePath in an action
// re-renders the Dashboard in the same response, and the row would leave
// Needs you before "Reminder sent" could be seen. SendReminderButton
// refreshes it a moment later instead (and every page this touches is
// read fresh on the next visit).
async function afterReminder(o: { workspaceId: string; dealId: string; leadId: string | null; action: string; now: Date; metadata?: Record<string, unknown> }) {
  const session = await auth();
  await logAudit({ workspaceId: o.workspaceId, actorEmail: session?.user?.email, action: o.action, targetType: "Deal", targetId: o.dealId, metadata: o.metadata });
  if (o.leadId) await prisma.lead.updateMany({ where: { id: o.leadId, workspaceId: o.workspaceId }, data: { lastActivityAt: o.now } });
}

// "Send reminder" on a proposal that's had no answer (Needs you on the
// Dashboard): one short email to the client with the link to the proposal
// they already have. Only ever on a rep's click, never from a cron or a page
// load, and at most once every REMIND_AFTER_DAYS days.
export async function sendDocumentReminder(dealId: string): Promise<{ error?: string; sentTo?: string }> {
  const found = await proposalOut(dealId);
  if ("error" in found) return { error: found.error };
  const { workspaceId, deal, contract } = found;
  // Said plainly, before the slot is taken: trying again won't help.
  if (!isEmailConfigured()) return { error: EMAIL_OFF };

  const lastSend = await prisma.auditLog.findFirst({
    where: { workspaceId, action: "proposal.sent", targetType: "Deal", targetId: deal.id },
    orderBy: { createdAt: "desc" },
    select: { metadata: true },
  });
  const to = proposalRecipient(lastSend?.metadata, deal.client.email, deal.lead?.email);
  if (!to) return { error: "There's no email for this client. Copy the link and send it yourself" };

  const now = new Date();
  if (!(await claimReminder(contract.id, now))) return { error: ALREADY_REMINDED };

  const session = await auth();
  const name = [deal.lead?.name, deal.client.name].find((n) => n && n !== NEW_LEAD_NAME && n !== PLACEHOLDER_CLIENT) ?? null;
  try {
    await sendProposalReminderEmail({
      to,
      clientName: name,
      workspaceName: deal.workspace.name,
      proposalLink: clientDocumentUrl(contract.id, "proposal"),
      // The same as the proposal's own email: replies go to whoever sent it,
      // here the rep who clicked.
      replyTo: session?.user?.email ?? null,
      verifiedSenderEmail: deal.workspace.senderDomainStatus === "verified" ? deal.workspace.senderEmail : null,
    });
  } catch (err) {
    // Nothing went out, so the slot goes back and the rep can try again.
    await prisma.contract.updateMany({ where: { id: contract.id, reminderSentAt: now }, data: { reminderSentAt: contract.reminderSentAt } });
    await reportError(err, "Proposal reminder", { dealId });
    return { error: "Couldn't send the reminder. Try again in a minute" };
  }

  await afterReminder({ workspaceId, dealId: deal.id, leadId: deal.leadId, action: "proposal.reminder_sent", now, metadata: { to } });
  return { sentTo: to };
}

// Copy link on a proposal due a reminder whose client has no email: the rep
// sends the link themselves, so it counts as the reminder and leaves Needs
// you the same way. Nothing is emailed. A second copy within the 5 days
// only copies.
export async function recordReminderLinkCopied(dealId: string): Promise<{ error?: string }> {
  const found = await proposalOut(dealId);
  if ("error" in found) return { error: found.error };
  const { workspaceId, deal, contract } = found;
  const now = new Date();
  if (!(await claimReminder(contract.id, now))) return {};
  await afterReminder({ workspaceId, dealId: deal.id, leadId: deal.leadId, action: "proposal.reminder_link_copied", now });
  return {};
}
