"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { logAudit } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { refreshLeadPipeline, syncLeadClient } from "@/lib/lead-pipeline";
import { leadForClient } from "@/lib/client-lead";

// The deals trash: put one back, or empty it for good.

export async function restoreDeal(dealId: string): Promise<void> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();

  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where, trashedAt: { not: null } },
    include: { client: { select: { id: true, name: true, company: true, email: true, phone: true } }, contract: { select: { status: true } } },
  });
  if (!deal) throw new Error("Deal not found in trash");

  // Its lead was deleted since: it goes back on the lead for its client (or
  // a new one), so it shows on Leads again.
  const leadId = deal.leadId ?? (await leadForClient(workspaceId, deal.client, { ownerId: deal.ownerId }));
  await prisma.deal.update({ where: { id: dealId }, data: { trashedAt: null, leadId } });
  // A signed contract back out of the trash makes its lead a client again
  // (a lead is a client exactly when it has one). Only then: putting back
  // anything else can't change who's a client.
  if (deal.kind === "contract" && deal.contract?.status === "signed") await syncLeadClient(leadId);
  await refreshLeadPipeline(leadId);

  const session = await auth();
  await logAudit({ workspaceId, actorEmail: session?.user?.email, action: "deal.restored", targetType: "Deal", targetId: dealId });

  revalidatePath("/leads");
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

  revalidatePath("/leads");
  revalidatePath("/deals/trash");
  return { deleted: ids.length };
}
