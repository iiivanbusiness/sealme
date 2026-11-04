import { NextResponse } from "next/server";
import { discardStaleCalls, fillTelnyxCosts } from "@/lib/call-inbox";
import { syncPendingDocusignContracts } from "@/lib/docusign-sync";
import { keepDocusignConnectionsAlive } from "@/lib/docusign";
import { prisma } from "@/lib/db";
import { sendAdminAlertEmail, sendRenewalReminderEmail, sendReviewOverdueEmail } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { runStaleDealsDigest } from "@/lib/stale-deals";
import { runTaskDigest } from "@/lib/task-digest";
import { syncCrmLeadsIfDue } from "@/lib/crm-lead-autosync";
import { cleanupRateLimitHits } from "@/lib/rate-limit-cleanup";
import { reportError } from "@/lib/error-report";
import { retryDueWebhookDeliveries } from "@/lib/webhooks";

const WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Runs daily (see vercel.json). Sends exactly one "renews/ends soon" nudge
// per contract, once its renewalDate falls within the next 30 days — no
// per-workspace opt-in toggle, unlike the signature reminder: this is
// informational to the team, not client-facing, so there's no reason to
// gate it.
//
// Also runs the overdue-review reminder (a ReviewStep past its dueAt),
// the stale-deals digest (see src/lib/stale-deals.ts), the morning task
// email (see src/lib/task-digest.ts), and the
// RateLimitHit table cleanup (see src/lib/rate-limit-cleanup.ts) in the same
// request — Vercel's Hobby plan caps a project at 2 cron jobs, and this
// project already has 2 without them (remind, renewals), so extra daily
// jobs get piggybacked here instead of registered separately in
// vercel.json. Each check is independent — a failure in one doesn't stop
// the others.
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + WINDOW_DAYS * DAY_MS);

    const dueContracts = await prisma.contract.findMany({
      where: {
        status: "signed",
        renewalDate: { gte: now, lte: windowEnd },
        renewalReminderSentAt: null,
        deal: { trashedAt: null },
      },
      // Active users only: deactivatedAt also covers self-deleted accounts,
      // whose placeholder address would just bounce.
      include: { deal: { include: { client: true, workspace: { include: { users: { where: { deactivatedAt: null }, include: { role: true } } } } } }, template: true },
    });

    let sent = 0;
    for (const contract of dueContracts) {
      // Same people who can open the deal (see dealVisibilityFilter): its
      // owner, anyone who sees every deal, and everyone for an ownerless deal.
      const { ownerId } = contract.deal;
      const recipients = contract.deal.workspace.users
        .filter((u) => !ownerId || u.id === ownerId || u.role?.canViewAllDeals)
        .map((u) => u.email);
      if (recipients.length === 0 || !contract.renewalDate) continue;
      try {
        await sendRenewalReminderEmail({
          to: recipients,
          clientName: contract.deal.client.name,
          templateName: contract.template?.name ?? "contract",
          renewalDate: contract.renewalDate,
          autoRenews: contract.autoRenews,
          renewalNote: contract.renewalNote,
          dealUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/deals/${contract.dealId}/contract`,
        });
        await prisma.contract.update({ where: { id: contract.id }, data: { renewalReminderSentAt: new Date() } });
        sent++;
      } catch (err) {
        console.error(`Failed to send renewal reminder for contract ${contract.id}`, err);
      }
    }

    let overdueReviewResult = { checked: 0, sent: 0 };
    try {
      const overdueSteps = await prisma.reviewStep.findMany({
        where: { status: "pending", dueAt: { lte: now }, dueReminderSentAt: null },
        include: { assignee: true, contract: { include: { deal: { include: { client: true, template: true, workspace: true } } } } },
      });
      let overdueSent = 0;
      for (const step of overdueSteps) {
        const dealUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/deals/${step.contract.deal.id}`;
        try {
          await sendReviewOverdueEmail({
            to: step.assignee.email,
            clientName: step.contract.deal.client.name,
            templateName: step.contract.deal.template?.name ?? "contract",
            dealUrl,
          });
          await createNotification({
            workspaceId: step.contract.deal.workspaceId,
            userId: step.assigneeId,
            type: "review.overdue",
            title: `Overdue: ${step.contract.deal.client.name}`,
            body: "Your review is past its due date.",
            linkUrl: dealUrl,
          });
          await prisma.reviewStep.update({ where: { id: step.id }, data: { dueReminderSentAt: new Date() } });
          overdueSent++;
        } catch (err) {
          console.error(`Failed overdue reminder for review step ${step.id}`, err);
        }
      }
      overdueReviewResult = { checked: overdueSteps.length, sent: overdueSent };
    } catch (err) {
      console.error("Overdue-review reminder (piggybacked on renewals cron) crashed", err);
      try {
        await sendAdminAlertEmail({
          subject: "Overdue-review reminder crashed",
          details: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      } catch (alertErr) {
        console.error("Failed to send admin alert email", alertErr);
      }
    }

    let staleResult = { checked: 0, sent: 0 };
    try {
      staleResult = await runStaleDealsDigest();
    } catch (err) {
      console.error("Stale-deals digest (piggybacked on renewals cron) crashed", err);
      try {
        await sendAdminAlertEmail({
          subject: "Stale-deals digest crashed",
          details: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      } catch (alertErr) {
        console.error("Failed to send admin alert email", alertErr);
      }
    }

    // Morning "your tasks" email for reps (see src/lib/task-digest.ts).
    let taskDigestResult = { checked: 0, sent: 0 };
    try {
      taskDigestResult = await runTaskDigest();
    } catch (err) {
      console.error("Task digest (piggybacked on renewals cron) crashed", err);
      try {
        await sendAdminAlertEmail({
          subject: "Task digest crashed",
          details: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      } catch (alertErr) {
        console.error("Failed to send admin alert email", alertErr);
      }
    }

    // Daily catch-up of CRM leads for workspaces that bring them in, in case
    // nobody opened Leads and a webhook was missed.
    let crmLeadSync = { workspaces: 0 };
    try {
      const importing = await prisma.workspace.findMany({
        where: { prospectingEnabled: true, OR: [{ salesforceLeadImport: true }, { hubspotLeadImport: true }] },
        select: { id: true, salesforceLeadImport: true, salesforceRefreshToken: true, salesforceLeadsSyncedAt: true, hubspotLeadImport: true, hubspotAccessToken: true, hubspotLeadsSyncedAt: true },
      });
      for (const ws of importing) await syncCrmLeadsIfDue(ws, { force: true, budgetMs: 20_000 });
      crmLeadSync = { workspaces: importing.length };
    } catch (err) {
      console.error("CRM lead sync (piggybacked on renewals cron) crashed", err);
    }

    // Webhook retries that came due while nobody was using the app, and
    // delivery history older than 30 days.
    let webhookRetries = { attempted: 0, pruned: 0 };
    try {
      const { attempted } = await retryDueWebhookDeliveries({ limit: 200, budgetMs: 20_000 });
      const pruned = await prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 30 * 86_400_000) }, status: { not: "pending" } } });
      webhookRetries = { attempted, pruned: pruned.count };
    } catch (err) {
      console.error("Webhook retries (piggybacked on renewals cron) crashed", err);
      await reportError(err, "Webhook retries");
    }

    // Calls in the Calls inbox nobody processed or discarded within a day.
    let staleCalls = { discarded: 0 };
    try {
      staleCalls = { discarded: await discardStaleCalls(now) };
    } catch (err) {
      console.error("Stale call cleanup (piggybacked on renewals cron) crashed", err);
      await reportError(err, "Stale call cleanup");
    }

    // What Telnyx billed for recent calls, so a call's cost is the real one.
    let callCosts = { filled: 0 };
    try {
      callCosts = { filled: await fillTelnyxCosts(now) };
    } catch (err) {
      console.error("Telnyx call costs (piggybacked on renewals cron) crashed", err);
      await reportError(err, "Telnyx call costs");
    }

    // DocuSign contracts whose "completed" event never arrived.
    let docusign = { signed: 0, refreshed: 0 };
    try {
      docusign = { signed: await syncPendingDocusignContracts(), refreshed: await keepDocusignConnectionsAlive() };
    } catch (err) {
      console.error("DocuSign status check (piggybacked on renewals cron) crashed", err);
      await reportError(err, "DocuSign status check");
    }

    let rateLimitResult = { deleted: 0 };
    try {
      rateLimitResult = await cleanupRateLimitHits();
    } catch (err) {
      console.error("RateLimitHit cleanup (piggybacked on renewals cron) crashed", err);
      try {
        await sendAdminAlertEmail({
          subject: "RateLimitHit cleanup crashed",
          details: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      } catch (alertErr) {
        console.error("Failed to send admin alert email", alertErr);
      }
    }

    // The "this month" counters (calls shown on Deals/Analytics, the AI chat
    // allowance) had no reset at all, so they only ever grew. This job runs
    // daily at 09:00 UTC, so the 1st of the month is the reset point.
    let monthlyReset = { workspaces: 0 };
    if (now.getUTCDate() === 1) {
      try {
        const result = await prisma.workspace.updateMany({ data: { callsUsedThisMonth: 0, aiChatMessagesUsedThisMonth: 0 } });
        monthlyReset = { workspaces: result.count };
      } catch (err) {
        console.error("Monthly usage reset (piggybacked on renewals cron) crashed", err);
        await reportError(err, "Monthly usage reset");
      }
    }

    return NextResponse.json({ renewals: { checked: dueContracts.length, sent }, overdueReviews: overdueReviewResult, staleDeals: staleResult, taskDigest: taskDigestResult, crmLeadSync, webhookRetries, staleCalls, callCosts, docusign, rateLimitCleanup: rateLimitResult, monthlyReset });
  } catch (err) {
    console.error("Renewal reminder cron crashed", err);
    try {
      await sendAdminAlertEmail({
        subject: "Renewal reminder cron crashed",
        details: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    } catch (alertErr) {
      console.error("Failed to send admin alert email", alertErr);
    }
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
