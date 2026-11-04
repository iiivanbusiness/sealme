"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { auth } from "@/lib/auth";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

export async function createReviewChain(formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Name the chain, e.g. \"EMEA >€50k\"" };

  const teamId = String(formData.get("teamId") ?? "") || null;
  if (teamId) {
    const team = await prisma.team.findFirst({ where: { id: teamId, workspaceId: user.workspaceId } });
    if (!team) return { error: "Team not found" };
  }

  const rawMinValue = String(formData.get("minDealValue") ?? "").trim();
  const minDealValue = rawMinValue ? Number(rawMinValue) : null;
  if (minDealValue != null && (!Number.isFinite(minDealValue) || minDealValue < 0)) {
    return { error: "Minimum deal value must be a positive number" };
  }

  const maxOrder = await prisma.reviewChain.aggregate({ where: { workspaceId: user.workspaceId }, _max: { order: true } });
  const order = (maxOrder._max.order ?? -1) + 1;

  await prisma.reviewChain.create({ data: { workspaceId: user.workspaceId, name, teamId, minDealValue, order } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "review_chain.created", metadata: { name, teamId, minDealValue } });

  revalidatePath("/settings");
  return {};
}

export async function deleteReviewChain(chainId: string): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const chain = await prisma.reviewChain.findFirst({ where: { id: chainId, workspaceId: user.workspaceId } });
  if (!chain) return { error: "Chain not found" };

  await prisma.reviewChain.delete({ where: { id: chainId } });
  await prisma.reviewChain.updateMany({
    where: { workspaceId: user.workspaceId, order: { gt: chain.order } },
    data: { order: { decrement: 1 } },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "review_chain.deleted", metadata: { name: chain.name } });

  revalidatePath("/settings");
  return {};
}

export async function moveReviewChain(chainId: string, direction: "up" | "down"): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const chain = await prisma.reviewChain.findFirst({ where: { id: chainId, workspaceId: user.workspaceId } });
  if (!chain) return { error: "Chain not found" };

  const neighborOrder = direction === "up" ? chain.order - 1 : chain.order + 1;
  const neighbor = await prisma.reviewChain.findFirst({ where: { workspaceId: user.workspaceId, order: neighborOrder } });
  if (!neighbor) return {};

  await prisma.$transaction([
    prisma.reviewChain.update({ where: { id: chain.id }, data: { order: -1 } }),
    prisma.reviewChain.update({ where: { id: neighbor.id }, data: { order: chain.order } }),
    prisma.reviewChain.update({ where: { id: chain.id }, data: { order: neighborOrder } }),
  ]);

  revalidatePath("/settings");
  return {};
}

export async function addReviewChainStep(chainId: string, formData: FormData): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const assigneeId = String(formData.get("assigneeId") ?? "");
  if (!assigneeId) return { error: "Choose a teammate" };

  const chain = await prisma.reviewChain.findFirst({ where: { id: chainId, workspaceId: user.workspaceId } });
  if (!chain) return { error: "Chain not found" };

  const assignee = await prisma.user.findFirst({ where: { id: assigneeId, workspaceId: user.workspaceId, deactivatedAt: null } });
  if (!assignee) return { error: "Teammate not found" };

  const existing = await prisma.reviewChainStep.findFirst({ where: { chainId, assigneeId } });
  if (existing) return { error: "That person is already a step in this chain" };

  const maxOrder = await prisma.reviewChainStep.aggregate({ where: { chainId }, _max: { order: true } });
  const order = (maxOrder._max.order ?? 0) + 1;

  await prisma.reviewChainStep.create({ data: { chainId, assigneeId, order } });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "review_chain_step.added", metadata: { chain: chain.name, assignee: assignee.name, order } });

  revalidatePath("/settings");
  return {};
}

export async function removeReviewChainStep(stepId: string): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const step = await prisma.reviewChainStep.findFirst({ where: { id: stepId, chain: { workspaceId: user.workspaceId } } });
  if (!step) return { error: "Step not found" };

  await prisma.reviewChainStep.delete({ where: { id: stepId } });

  await prisma.reviewChainStep.updateMany({
    where: { chainId: step.chainId, order: { gt: step.order } },
    data: { order: { decrement: 1 } },
  });

  const session = await auth();
  await logAudit({ workspaceId: user.workspaceId, actorEmail: session?.user?.email, action: "review_chain_step.removed", metadata: { assignee: step.assigneeId } });

  revalidatePath("/settings");
  return {};
}

export async function moveReviewChainStep(stepId: string, direction: "up" | "down"): Promise<{ error?: string }> {
  const user = await requirePermission("canManageWorkspace");
  const step = await prisma.reviewChainStep.findFirst({ where: { id: stepId, chain: { workspaceId: user.workspaceId } } });
  if (!step) return { error: "Step not found" };

  const neighborOrder = direction === "up" ? step.order - 1 : step.order + 1;
  const neighbor = await prisma.reviewChainStep.findFirst({ where: { chainId: step.chainId, order: neighborOrder } });
  if (!neighbor) return {}; // already at the edge, nothing to do

  // @@unique([chainId, order]) means both rows can't briefly share an
  // order value mid-swap — stage the moving step on an out-of-range order
  // first so the swap never collides.
  await prisma.$transaction([
    prisma.reviewChainStep.update({ where: { id: step.id }, data: { order: -1 } }),
    prisma.reviewChainStep.update({ where: { id: neighbor.id }, data: { order: step.order } }),
    prisma.reviewChainStep.update({ where: { id: step.id }, data: { order: neighborOrder } }),
  ]);

  revalidatePath("/settings");
  return {};
}
