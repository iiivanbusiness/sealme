// Puts every deal made before calls lived on leads onto a lead, and fills in
// the new lead columns (isClient, clientAt, pipelineStage, lastActivityAt).
//
// Run it after the 20261114120000_calls_on_leads migration, once before the
// deploy and once after (to pick up deals the old code made in between):
//
//   npx tsx -r dotenv/config scripts/link-deals-to-leads.ts            (dry run: reads only, prints what it would do)
//   npx tsx -r dotenv/config scripts/link-deals-to-leads.ts --apply    (writes)
//   ... --workspace <id>                                               (one workspace only)
//
// Safe to run again: it only links deals that have no lead yet, and works out
// the lead columns from scratch every time. It never sends a webhook, never
// deletes anything, and keeps every row's updatedAt (the stale-deal nudges
// and "last activity" go by it). Lead.stage (what the API and webhooks
// report) changes only on leads it marks a client, to "converted". Sandbox
// workspaces are skipped.
//
// A deal goes on, in this order: the lead it was converted from
// (Lead.convertedDealId); the one lead its calls are on; the lead its client's
// other deals went to (Lead.convertedClientId); a lead with the client's email
// or phone. A deal with none of those gets a new lead made from its client
// (one per client), unless the deal is in the trash.
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { pipelineStageFor } from "@/lib/lead-pipeline";

const apply = process.argv.includes("--apply");
const onlyWorkspace = process.argv.includes("--workspace") ? process.argv[process.argv.indexOf("--workspace") + 1] : null;

type Counts = Record<string, number>;
const bump = (c: Counts, key: string, n = 1) => (c[key] = (c[key] ?? 0) + n);

async function linkWorkspace(workspaceId: string, counts: Counts): Promise<void> {
  const deals = await prisma.deal.findMany({
    where: { workspaceId, leadId: null },
    select: { id: true, clientId: true, ownerId: true, trashedAt: true, updatedAt: true, client: { select: { id: true, name: true, company: true, email: true, phone: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (deals.length === 0) return;

  const leads = await prisma.lead.findMany({ where: { workspaceId }, select: { id: true, email: true, phone: true, convertedDealId: true, convertedClientId: true, updatedAt: true } });
  const leadUpdatedAt = new Map(leads.map((l) => [l.id, l.updatedAt]));
  const byConvertedDeal = new Map(leads.filter((l) => l.convertedDealId).map((l) => [l.convertedDealId!, l.id]));
  const byClient = new Map<string, string>();
  for (const l of leads) if (l.convertedClientId && !byClient.has(l.convertedClientId)) byClient.set(l.convertedClientId, l.id);
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  for (const l of leads) {
    if (l.email && !byEmail.has(l.email.toLowerCase())) byEmail.set(l.email.toLowerCase(), l.id);
    if (l.phone && !byPhone.has(l.phone)) byPhone.set(l.phone, l.id);
  }
  const calls = await prisma.phoneCall.findMany({
    where: { workspaceId, dealId: { in: deals.map((d) => d.id) } },
    select: { id: true, dealId: true, leadId: true, mode: true, startedAt: true },
    orderBy: { startedAt: "asc" },
  });

  for (const deal of deals) {
    const own = calls.filter((c) => c.dealId === deal.id);
    const callLeads = [...new Set(own.map((c) => c.leadId).filter((id): id is string => Boolean(id)))];
    const email = deal.client.email?.trim().toLowerCase() || null;
    const phone = normalizePhone(deal.client.phone);

    let leadId: string | null = null;
    let via = "";
    if (byConvertedDeal.has(deal.id)) [leadId, via] = [byConvertedDeal.get(deal.id)!, "converted from"];
    else if (callLeads.length === 1) [leadId, via] = [callLeads[0], "its calls"];
    else if (byClient.has(deal.clientId)) [leadId, via] = [byClient.get(deal.clientId)!, "client's lead"];
    else if (email && byEmail.has(email)) [leadId, via] = [byEmail.get(email)!, "client's email"];
    else if (phone && byPhone.has(phone)) [leadId, via] = [byPhone.get(phone)!, "client's phone"];

    if (!leadId) {
      if (deal.trashedAt) {
        bump(counts, "trashed deals left without a lead");
        continue;
      }
      via = "new lead";
      if (apply) {
        const created = await prisma.lead.create({
          data: {
            workspaceId,
            ownerId: deal.ownerId,
            name: deal.client.name.slice(0, 200),
            company: deal.client.company && deal.client.company !== deal.client.name ? deal.client.company.slice(0, 200) : null,
            email,
            phone,
            source: "manual",
            convertedClientId: deal.clientId,
          },
          select: { id: true },
        });
        leadId = created.id;
      } else {
        leadId = `new-lead-for-${deal.clientId}`;
      }
      byClient.set(deal.clientId, leadId);
      if (email) byEmail.set(email, leadId);
      if (phone) byPhone.set(phone, leadId);
    }
    bump(counts, `linked via ${via}`);
    if (!byClient.has(deal.clientId)) byClient.set(deal.clientId, leadId);

    // The call the deal was made from: its sales call, when it had one.
    const fromCall = own.find((c) => c.mode === "sales" && c.leadId === leadId) ?? null;
    if (apply) {
      await prisma.deal.update({ where: { id: deal.id }, data: { leadId, ...(fromCall ? { phoneCallId: fromCall.id } : {}), updatedAt: deal.updatedAt } });
      const leadWas = leadUpdatedAt.get(leadId);
      await prisma.lead.updateMany({ where: { id: leadId, convertedClientId: null }, data: { convertedClientId: deal.clientId, ...(leadWas ? { updatedAt: leadWas } : {}) } });
    }
  }
}

// isClient, clientAt, pipelineStage and lastActivityAt for every lead in the
// workspace, from its deals and calls.
async function fillLeadColumns(workspaceId: string, counts: Counts): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: { workspaceId },
    select: {
      id: true,
      stage: true,
      isClient: true,
      clientAt: true,
      pipelineStage: true,
      lastActivityAt: true,
      lastContactedAt: true,
      createdAt: true,
      updatedAt: true,
      convertedAt: true,
      deals: { where: { trashedAt: null }, select: { kind: true, updatedAt: true, contract: { select: { status: true, signedAt: true, sentAt: true } } } },
    },
  });
  for (const lead of leads) {
    const signed = lead.deals.filter((d) => d.kind === "contract" && d.contract?.status === "signed");
    const isClient = lead.isClient || signed.length > 0;
    const signedAts = signed.map((d) => d.contract!.signedAt).filter((d): d is Date => Boolean(d));
    const clientAt = lead.clientAt ?? (signedAts.length ? new Date(Math.min(...signedAts.map((d) => d.getTime()))) : isClient ? new Date() : null);
    // A lead marked lost stays lost, unless a proposal or contract of its is
    // out with the client (the stage then follows that).
    const fromDocs = pipelineStageFor({ isClient, pipelineStage: lead.pipelineStage }, lead.deals, { fromScratch: lead.pipelineStage === "new" });
    const pipelineStage = lead.stage === "lost" && lead.pipelineStage === "new" && fromDocs === "new" ? "lost" : fromDocs;
    // A client is "converted" for the API, as a signature makes it now.
    const converted = isClient && lead.stage !== "converted" ? { stage: "converted", convertedAt: lead.convertedAt ?? clientAt } : {};
    const times = [lead.lastActivityAt, lead.lastContactedAt, lead.createdAt, ...lead.deals.map((d) => d.updatedAt)].filter((d): d is Date => Boolean(d));
    const lastActivityAt = new Date(Math.max(...times.map((d) => d.getTime())));

    bump(counts, `stage ${pipelineStage}`);
    const changed =
      "stage" in converted ||
      isClient !== lead.isClient ||
      (clientAt?.getTime() ?? null) !== (lead.clientAt?.getTime() ?? null) ||
      pipelineStage !== lead.pipelineStage ||
      lastActivityAt.getTime() !== (lead.lastActivityAt?.getTime() ?? null);
    if (!changed) continue;
    bump(counts, "leads updated");
    if (isClient && !lead.isClient) bump(counts, "leads marked client");
    if (apply) await prisma.lead.update({ where: { id: lead.id }, data: { isClient, clientAt, pipelineStage, lastActivityAt, ...converted, updatedAt: lead.updatedAt } });
  }
}

async function main() {
  const workspaces = await prisma.workspace.findMany({
    where: { sandboxOfId: null, ...(onlyWorkspace ? { id: onlyWorkspace } : {}) },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(apply ? "Writing changes." : "Dry run: nothing is written. Add --apply to write.");
  const total: Counts = {};
  for (const ws of workspaces) {
    const counts: Counts = {};
    await linkWorkspace(ws.id, counts);
    // In a dry run the new links aren't in the database, so the lead columns
    // below are worked out from what's there now.
    await fillLeadColumns(ws.id, counts);
    const linked = Object.entries(counts).filter(([k]) => k.startsWith("linked") || k.startsWith("trashed") || k.startsWith("leads"));
    if (linked.length) console.log(`\n${ws.name} (${ws.id})\n${linked.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
    for (const [k, v] of Object.entries(counts)) bump(total, k, v);
  }
  console.log(`\nAll workspaces (${workspaces.length})`);
  for (const [k, v] of Object.entries(total).sort()) console.log(`  ${k}: ${v}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
