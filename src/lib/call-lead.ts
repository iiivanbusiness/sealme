import { prisma } from "@/lib/db";
import { NEW_LEAD_NAME } from "@/lib/cold-call";
import { normalizePhone } from "@/lib/phone";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Who the call is with, from "Who's on the call?": a lead picked from the
// suggestions; else what was typed (an email or phone already on a lead is
// that lead, an email otherwise starts a lead the call names, anything else
// is the new lead's name); else nothing, and the call names a new lead.
// nameHint: the name a meeting gives the email typed in, so a lead started
// from that email has it. fresh: a lead the call still has to name, which
// may turn out to be someone already on file (see applyColdCall).
export async function leadForCall(workspaceId: string, userId: string, picked: string, typed: string, visible: object, nameHint?: string): Promise<{ id: string; fresh: boolean } | null> {
  if (picked && picked !== "new") {
    const lead = await prisma.lead.findFirst({ where: { id: picked, workspaceId, AND: [visible] }, select: { id: true } });
    return lead ? { id: lead.id, fresh: false } : null;
  }
  const email = EMAIL.test(typed) ? typed.toLowerCase() : null;
  const phone = !email ? normalizePhone(typed) : null;
  if (email || phone) {
    const known = await prisma.lead.findFirst({ where: { workspaceId, AND: [visible], ...(email ? { email: { equals: email, mode: "insensitive" } } : { phone }) }, orderBy: { updatedAt: "desc" }, select: { id: true } });
    if (known) return { id: known.id, fresh: false };
  }
  // A name typed in is the lead's name; an email or phone takes the meeting's.
  const name = email || phone ? nameHint?.trim() : typed;
  const named = name ? name.slice(0, 200) : null;
  const created = await prisma.lead.create({
    data: { workspaceId, ownerId: userId, name: named ?? NEW_LEAD_NAME, email, phone, source: "call", lastActivityAt: new Date() },
    select: { id: true },
  });
  return { id: created.id, fresh: !named };
}

