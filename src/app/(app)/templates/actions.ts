"use server";

import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/permissions";
import { logAudit } from "@/lib/audit";

type ClauseInput = { title: string; body: string };

function countPlaceholders(clauses: ClauseInput[]): number {
  const placeholders = new Set<string>();
  for (const clause of clauses) {
    for (const m of clause.body.matchAll(/\{(\w+)\}/g)) placeholders.add(m[1]);
  }
  return placeholders.size;
}

function parseClausesJson(raw: string): ClauseInput[] {
  try {
    return (JSON.parse(raw) as ClauseInput[]).filter((c) => c.title.trim() || c.body.trim());
  } catch {
    return [];
  }
}

export async function createTemplate(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const clauses = parseClausesJson(String(formData.get("clausesJson") ?? "[]"));

  if (!name) throw new Error("Template name is required");
  if (clauses.length === 0) throw new Error("Add at least one clause");

  const user = await requirePermission("canManageTemplates");
  const workspaceId = user.workspaceId;

  const template = await prisma.contractTemplate.create({
    data: {
      workspaceId,
      name,
      description: description || `Custom template with ${clauses.length} clauses.`,
      requiredFieldCount: countPlaceholders(clauses),
      clauses: JSON.stringify(clauses),
    },
  });

  redirect(`/templates/${template.id}`);
}

export async function updateTemplate(templateId: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const clauses = parseClausesJson(String(formData.get("clausesJson") ?? "[]"));

  if (!name) throw new Error("Template name is required");
  if (clauses.length === 0) throw new Error("Add at least one clause");

  const user = await requirePermission("canManageTemplates");
  const workspaceId = user.workspaceId;

  const template = await prisma.contractTemplate.findFirst({ where: { id: templateId, workspaceId } });
  if (!template) throw new Error("Template not found");
  if (template.locked && !user.role?.canApproveTemplates) {
    throw new Error("This template is locked. Ask someone who can approve templates to unlock it first");
  }

  await prisma.contractTemplate.updateMany({
    where: { id: templateId, workspaceId },
    data: {
      name,
      description,
      requiredFieldCount: countPlaceholders(clauses),
      clauses: JSON.stringify(clauses),
    },
  });

  redirect(`/templates/${templateId}`);
}

export async function deleteTemplate(templateId: string) {
  const user = await requirePermission("canManageTemplates");
  const workspaceId = user.workspaceId;

  const template = await prisma.contractTemplate.findFirst({ where: { id: templateId, workspaceId } });
  if (!template) throw new Error("Template not found");
  if (template.locked && !user.role?.canApproveTemplates) {
    throw new Error("This template is locked. Ask someone who can approve templates to unlock it first");
  }

  const inUse = await prisma.deal.count({ where: { templateId } });
  if (inUse > 0) {
    throw new Error("This template is used by one or more deals and can't be deleted.");
  }
  await prisma.contractTemplate.deleteMany({ where: { id: templateId, workspaceId } });
  redirect("/templates");
}

export async function lockTemplate(templateId: string) {
  const user = await requirePermission("canApproveTemplates");
  const template = await prisma.contractTemplate.findFirst({ where: { id: templateId, workspaceId: user.workspaceId } });
  if (!template) throw new Error("Template not found");

  await prisma.contractTemplate.update({
    where: { id: templateId },
    data: { locked: true, lockedByUserId: user.id, lockedAt: new Date() },
  });

  await logAudit({ workspaceId: user.workspaceId, actorEmail: user.email, action: "template.locked", targetType: "ContractTemplate", targetId: templateId, metadata: { name: template.name } });

  redirect(`/templates/${templateId}`);
}

export async function unlockTemplate(templateId: string) {
  const user = await requirePermission("canApproveTemplates");
  const template = await prisma.contractTemplate.findFirst({ where: { id: templateId, workspaceId: user.workspaceId } });
  if (!template) throw new Error("Template not found");

  await prisma.contractTemplate.update({
    where: { id: templateId },
    data: { locked: false, lockedByUserId: null, lockedAt: null },
  });

  await logAudit({ workspaceId: user.workspaceId, actorEmail: user.email, action: "template.unlocked", targetType: "ContractTemplate", targetId: templateId, metadata: { name: template.name } });

  redirect(`/templates/${templateId}`);
}
