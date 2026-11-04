import { prisma } from "@/lib/db";
import { sendStaleDealsEmail } from "@/lib/email";

const STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// A deal sitting in "ready" or "missing_info" (someone needs to review it
// or fill something in, and nothing else nudges that) with no activity
// for a week gets bundled into one digest email per person, not one
// email per deal. Re-fires every 7 days for as long as it stays genuinely
// untouched (staleReminderSentAt only counts if it's *after* the deal's
// last real update), so a deal forgotten for a month doesn't just quietly
// stop being mentioned after the first nudge.
export async function runStaleDealsDigest(): Promise<{ checked: number; sent: number }> {
  const cutoff = new Date(Date.now() - STALE_AFTER_DAYS * DAY_MS);

  const staleDeals = await prisma.deal.findMany({
    where: {
      trashedAt: null,
      status: { in: ["ready", "missing_info"] },
      updatedAt: { lte: cutoff },
      OR: [{ staleReminderSentAt: null }, { staleReminderSentAt: { lte: cutoff } }],
    },
    // Active users only: deactivatedAt also covers self-deleted accounts,
    // whose placeholder address would just bounce.
    include: { client: true, workspace: { include: { users: { where: { deactivatedAt: null }, include: { role: true } } } } },
  });

  const byWorkspace = new Map<string, typeof staleDeals>();
  for (const deal of staleDeals) {
    if (!byWorkspace.has(deal.workspaceId)) byWorkspace.set(deal.workspaceId, []);
    byWorkspace.get(deal.workspaceId)!.push(deal);
  }

  let sent = 0;
  for (const [workspaceId, workspaceDeals] of byWorkspace) {
    // Deals that went out to at least one person. One nobody got (every
    // send failed, or nobody active may open it) stays unmarked and comes
    // up again tomorrow.
    const reached = new Set<string>();
    for (const user of workspaceDeals[0].workspace.users) {
      // Same people who can open the deal (see dealVisibilityFilter): its
      // owner, anyone who sees every deal, and everyone for an ownerless deal.
      const visible = workspaceDeals.filter((d) => !d.ownerId || d.ownerId === user.id || user.role?.canViewAllDeals);
      if (visible.length === 0) continue;
      try {
        await sendStaleDealsEmail({
          to: [user.email],
          deals: visible.map((d) => ({
            clientName: d.client.name,
            service: d.service,
            daysSinceUpdate: Math.floor((Date.now() - d.updatedAt.getTime()) / DAY_MS),
            dealUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/deals/${d.id}`,
          })),
        });
        for (const d of visible) reached.add(d.id);
      } catch (err) {
        console.error(`Failed to send stale-deals digest to user ${user.id} in workspace ${workspaceId}`, err);
      }
    }
    if (reached.size === 0) continue;

    // updatedAt is written back unchanged: the nudge isn't activity, and
    // bumping it would reset "untouched N days" and drop the Stale badge on
    // the Deals page. Matching on it skips a deal someone touched since it
    // was read, so that real update isn't rolled back.
    const now = new Date();
    try {
      for (const d of workspaceDeals) {
        if (!reached.has(d.id)) continue;
        await prisma.deal.updateMany({ where: { id: d.id, updatedAt: d.updatedAt }, data: { staleReminderSentAt: now, updatedAt: d.updatedAt } });
      }
      sent += reached.size;
    } catch (err) {
      console.error(`Failed to mark stale-deals digest as sent for workspace ${workspaceId}`, err);
    }
  }

  return { checked: staleDeals.length, sent };
}
