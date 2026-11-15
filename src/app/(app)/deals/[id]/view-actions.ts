"use server";

import { prisma } from "@/lib/db";
import { requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";

export type DocumentViewState = {
  contractStatus: string | null;
  sentAt: string | null;
  viewedAt: string | null;
};

// Polled by the deal page while a sent proposal hasn't been opened yet, so
// "Viewed" shows up the moment the client opens it, without a reload. Kept
// to the three columns that answer that, since it runs every few seconds.
// null when the deal isn't there or this user can't see it.
export async function documentViewState(dealId: string): Promise<DocumentViewState | null> {
  const { where } = await dealVisibilityFilter();
  const workspaceId = await requireWorkspaceId();
  const deal = await prisma.deal.findFirst({
    where: { id: dealId, workspaceId, ...where },
    select: { contract: { select: { status: true, sentAt: true, viewedAt: true } } },
  });
  if (!deal) return null;
  return {
    contractStatus: deal.contract?.status ?? null,
    sentAt: deal.contract?.sentAt?.toISOString() ?? null,
    viewedAt: deal.contract?.viewedAt?.toISOString() ?? null,
  };
}
