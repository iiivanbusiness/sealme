import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { sendAdminAlertEmail, sendReminderEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit";

// Runs daily (see vercel.json). Two independent sweeps over "sent"
// contracts, sharing this one cron slot (Hobby plan caps at 2 total —
// see stale-deals.ts for the other consolidation): the "still unsigned"
// nudge, and marking contracts past their configured expiry.
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let reminded = 0;
  let expired = 0;

  try {
    // Reminder cadence is per-workspace (reminderIntervalDays) since it
    // moved off a hardcoded 3 days — can't push that into the query
    // itself, so pull every still-eligible candidate and check each one.
    // Only SealMe's own sign link gets nudged: a DocuSign contract is signed
    // on DocuSign, and a deal in Trash is one the rep gave up on.
    const reminderCandidates = await prisma.contract.findMany({
      where: {
        status: "sent",
        deliveryMethod: "sealme",
        reminderSentAt: null,
        // The expiry sweep below runs after this one; a lapsed link isn't worth a nudge.
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        deal: { trashedAt: null, workspace: { autoRemind: true } },
      },
      include: { deal: { include: { client: true, workspace: true } } },
    });

    for (const contract of reminderCandidates) {
      if (!contract.sentAt || !contract.deal.client.email) continue;
      const dueAt = contract.sentAt.getTime() + contract.deal.workspace.reminderIntervalDays * 24 * 60 * 60 * 1000;
      if (dueAt > Date.now()) continue;

      try {
        const verifiedSenderEmail = contract.deal.workspace.senderDomainStatus === "verified" ? contract.deal.workspace.senderEmail : null;
        await sendReminderEmail({
          to: contract.deal.client.email,
          clientName: contract.deal.client.name,
          workspaceName: contract.deal.workspace.name,
          signLink: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/sign/${contract.id}`,
          verifiedSenderEmail,
        });
        await prisma.contract.update({ where: { id: contract.id }, data: { reminderSentAt: new Date() } });
        reminded++;
      } catch (err) {
        console.error(`Failed to send reminder for contract ${contract.id}`, err);
      }
    }
  } catch (err) {
    console.error("Reminder sweep crashed", err);
    try {
      await sendAdminAlertEmail({ subject: "Reminder cron crashed", details: err instanceof Error ? (err.stack ?? err.message) : String(err) });
    } catch (alertErr) {
      console.error("Failed to send admin alert email", alertErr);
    }
  }

  try {
    // DocuSign envelopes expire on DocuSign's own schedule; expiring one
    // here would offer "Send again" while the envelope is still signable.
    const expiredResult = await prisma.contract.findMany({
      where: { status: "sent", deliveryMethod: "sealme", expiresAt: { lte: new Date() } },
      include: { deal: { select: { id: true, workspaceId: true } } },
    });
    for (const contract of expiredResult) {
      // Guarded so a client signing in the same second keeps their signature.
      const moved = await prisma.contract.updateMany({ where: { id: contract.id, status: "sent" }, data: { status: "expired" } });
      if (moved.count === 0) continue;
      await logAudit({ workspaceId: contract.deal.workspaceId, action: "contract.expired", targetType: "Contract", targetId: contract.id });
      await dispatchWebhookEvent(contract.deal.workspaceId, "contract.expired", { dealId: contract.deal.id, contractId: contract.id, sentAt: contract.sentAt?.toISOString() ?? null, expiredAt: new Date().toISOString() });
      expired++;
    }
  } catch (err) {
    console.error("Expiry sweep crashed", err);
  }

  return NextResponse.json({ reminded, expired });
}
