import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";

type ClientForLead = { id: string; name: string; company: string | null; email: string | null; phone?: string | null };

// The lead a deal made without a call belongs to (typed in, started from the
// API or the desktop app): the lead this client's earlier deals went to, then
// a lead with the client's email, else a new lead made from the client. Every
// deal is on a lead, so it shows under them on the Leads list. A new lead
// makes no lead.created event: the deal is what happened, and deal.created
// says so.
export async function leadForClient(workspaceId: string, client: ClientForLead, options: { ownerId?: string | null; source?: string } = {}): Promise<string> {
  const known = await prisma.lead.findFirst({ where: { workspaceId, convertedClientId: client.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (known) return known.id;
  // A lead this client's deals went to, even after a merge took that lead's
  // client id with it.
  const dealtWith = await prisma.lead.findFirst({ where: { workspaceId, deals: { some: { clientId: client.id } } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (dealtWith) return dealtWith.id;
  const email = client.email?.trim().toLowerCase() || null;
  if (email) {
    const byEmail = await prisma.lead.findFirst({ where: { workspaceId, email: { equals: email, mode: "insensitive" } }, orderBy: { createdAt: "asc" }, select: { id: true, convertedClientId: true } });
    if (byEmail) {
      if (!byEmail.convertedClientId) await prisma.lead.update({ where: { id: byEmail.id }, data: { convertedClientId: client.id } });
      return byEmail.id;
    }
  }
  const created = await prisma.lead.create({
    data: {
      workspaceId,
      ownerId: options.ownerId ?? null,
      name: client.name.slice(0, 200),
      company: client.company && client.company !== client.name ? client.company.slice(0, 200) : null,
      email,
      phone: normalizePhone(client.phone),
      source: options.source ?? "manual",
      convertedClientId: client.id,
      lastActivityAt: new Date(),
    },
    select: { id: true },
  });
  return created.id;
}
