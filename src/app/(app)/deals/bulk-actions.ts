"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { sendReminderEmail } from "@/lib/email";
import { requestOrSendReview } from "@/lib/review";
import { logAudit } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { contractExpired } from "@/lib/contract-status";

// Statuses a drag-and-drop board move is allowed to set directly — pure
// review-state flags with no side effect on anything outside this row.
// Everything else (pending_approval, sent, signed, extraction_failed) is
// the result of a real action (an approval chain resolving, an email
// actually going out, a signature actually being captured) and has to
// stay reachable only through that action, not a drag — a board move
// can't fake a signature or skip an approval gate. updateDealStatus
// rejects any drop into or out of those with a clear error rather than
// silently no-op'ing, so the board can tell the user why it didn't move.
const DRAGGABLE_STATUSES = ["processing", "missing_info", "changes_requested", "ready"] as const;

export async function updateDealStatus(dealId: string, newStatus: string): Promise<{ error?: string }> {
  if (!DRAGGABLE_STATUSES.includes(newStatus as (typeof DRAGGABLE_STATUSES)[number])) {
    return { error: "That status can only be reached through its real action (send, approve, sign), not by dragging." };
  }

  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where } });
  if (!deal) return { error: "Deal not found" };
  if (!DRAGGABLE_STATUSES.includes(deal.status as (typeof DRAGGABLE_STATUSES)[number])) {
    return { error: "This deal has already moved past manual review. Its status can't be dragged anymore." };
  }

  await prisma.deal.update({ where: { id: dealId }, data: { status: newStatus } });

  const session = await auth();
  await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "deal.status_dragged", targetType: "Deal", targetId: dealId, metadata: { from: deal.status, to: newStatus } });

  revalidatePath("/deals");
  return {};
}

// An explicit manual nudge, not the automated 3-day cron — bypasses that
// cron's cutoff and its per-workspace autoRemind opt-in (someone actively
// chose to remind these clients right now), but still sets reminderSentAt
// so the cron doesn't also send a duplicate later.
export async function bulkRemind(dealIds: string[]): Promise<{ sent: number; skipped: number }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deals = await prisma.deal.findMany({
    where: { id: { in: dealIds }, workspaceId, ...where },
    include: { client: true, workspace: true, contract: true },
  });

  let sent = 0;
  let skipped = 0;
  for (const deal of deals) {
    if (!deal.contract || deal.contract.status !== "sent" || deal.contract.deliveryMethod !== "sealme" || contractExpired(deal.contract) || !deal.client.email) {
      skipped++;
      continue;
    }
    try {
      const verifiedSenderEmail = deal.workspace.senderDomainStatus === "verified" ? deal.workspace.senderEmail : null;
      await sendReminderEmail({
        to: deal.client.email,
        clientName: deal.client.name,
        workspaceName: deal.workspace.name,
        signLink: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/sign/${deal.contract.id}`,
        verifiedSenderEmail,
      });
      await prisma.contract.update({ where: { id: deal.contract.id }, data: { reminderSentAt: new Date() } });
      sent++;
    } catch (err) {
      console.error(`Bulk remind failed for deal ${deal.id}`, err);
      skipped++;
    }
  }

  const session = await auth();
  await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "deals.bulk_reminded", metadata: { count: sent } });

  revalidatePath("/deals");
  return { sent, skipped };
}

// Soft-delete — just stamps trashedAt so the deal drops out of the normal
// list/board. Nothing about the deal or its contract is touched otherwise,
// so restoring it (bulkRestore) puts it back exactly as it was.
export async function bulkTrash(dealIds: string[]): Promise<{ trashed: number }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();

  const result = await prisma.deal.updateMany({
    where: { id: { in: dealIds }, workspaceId, ...where, trashedAt: null },
    data: { trashedAt: new Date() },
  });

  const session = await auth();
  await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "deals.bulk_trashed", metadata: { count: result.count } });

  revalidatePath("/deals");
  revalidatePath("/deals/trash");
  return { trashed: result.count };
}

export async function restoreDeal(dealId: string): Promise<void> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();

  const deal = await prisma.deal.findFirst({ where: { id: dealId, workspaceId, ...where, trashedAt: { not: null } } });
  if (!deal) throw new Error("Deal not found in trash");

  await prisma.deal.update({ where: { id: dealId }, data: { trashedAt: null } });

  const session = await auth();
  await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "deal.restored", targetType: "Deal", targetId: dealId });

  revalidatePath("/deals");
  revalidatePath("/deals/trash");
}

// The real, irreversible delete — everything currently in the trash, gone
// for good. Contract has no cascade off Deal (a live deal's contract
// should never disappear just because the deal row does), so it has to be
// deleted explicitly first; Contract's own children (signers, clause
// comments, approvals) and Deal's own children (fields, calls, notes,
// etc.) already cascade in the schema.
export async function emptyTrash(): Promise<{ deleted: number }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();

  const trashed = await prisma.deal.findMany({
    where: { workspaceId, ...where, trashedAt: { not: null } },
    select: { id: true },
  });
  const ids = trashed.map((d) => d.id);
  if (ids.length === 0) return { deleted: 0 };

  await prisma.$transaction([
    prisma.contract.deleteMany({ where: { dealId: { in: ids } } }),
    prisma.deal.deleteMany({ where: { id: { in: ids } } }),
  ]);

  const session = await auth();
  await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "deals.trash_emptied", metadata: { count: ids.length } });

  revalidatePath("/deals");
  revalidatePath("/deals/trash");
  return { deleted: ids.length };
}

// Sends every selected draft contract with the same default subject/message
// the individual Send page would pre-fill — only for deals that already
// have a reviewed contract sitting in draft with somewhere to send it.
export async function bulkSend(dealIds: string[]): Promise<{ sent: number; skipped: number }> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const deals = await prisma.deal.findMany({
    where: { id: { in: dealIds }, workspaceId, ...where },
    include: { client: true, template: true, contract: true },
  });

  const session = await auth();
  let sent = 0;
  let skipped = 0;
  for (const deal of deals) {
    if (!deal.contract || deal.contract.status !== "draft" || !deal.client.email || !deal.template) {
      skipped++;
      continue;
    }
    try {
      const subject = `${deal.template.name} from ${workspace.name}`;
      const message = `Hi ${deal.client.name.split(" ")[0]},\n\nThanks again for the call. Here's the ${deal.template.name.toLowerCase()} we discussed. Take a look and sign whenever you're ready.\n\nLet me know if anything needs adjusting.`;
      await requestOrSendReview(deal.id, { to: deal.client.email, subject, message }, session?.user?.email);
      sent++;
    } catch (err) {
      console.error(`Bulk send failed for deal ${deal.id}`, err);
      skipped++;
    }
  }

  revalidatePath("/deals");
  return { sent, skipped };
}
