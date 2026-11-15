"use server";

import { prisma } from "@/lib/db";
import { requireProspecting } from "@/lib/prospecting";
import { leadAccess } from "@/lib/lead-visibility";
import { normalizePhone } from "@/lib/phone";
import { NEW_LEAD_NAME } from "@/lib/cold-call";

export type CallLeadOption = { id: string; name: string; company: string | null; email: string | null; isClient: boolean; calls: number };

// Suggestions for "Who's on the call?": anyone this person can see, by name,
// company, email or phone, clients and lost leads included (a call with a
// client stacks under them, a call with a lost lead makes them active again).
// Not the leads a call made for itself that have no name yet ("New lead from
// a call"): they say nothing about who they are, and typing "new" or "call"
// would list them all.
export async function searchCallLeads(q: string): Promise<CallLeadOption[]> {
  const workspace = await requireProspecting();
  const access = await leadAccess();
  const term = typeof q === "string" ? q.trim().slice(0, 100) : "";
  if (term.length < 2) return [];
  const phone = /\d{4,}/.test(term) ? normalizePhone(term) : null;
  const leads = await prisma.lead.findMany({
    where: {
      workspaceId: workspace.id,
      AND: [
        access.where,
        { name: { not: NEW_LEAD_NAME } },
        {
          OR: [
            { name: { contains: term, mode: "insensitive" } },
            { company: { contains: term, mode: "insensitive" } },
            { email: { contains: term, mode: "insensitive" } },
            ...(phone ? [{ phone }] : []),
          ],
        },
      ],
    },
    select: { id: true, name: true, company: true, email: true, isClient: true, _count: { select: { phoneCalls: { where: { status: "processed" } } } } },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  return leads.map((l) => ({ id: l.id, name: l.name, company: l.company, email: l.email, isClient: l.isClient, calls: l._count.phoneCalls }));
}
