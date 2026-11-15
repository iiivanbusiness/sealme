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
// Safe to run again: it only links deals that have no lead yet, and works a
// lead's stage out from scratch only for the leads it links a deal to (a
// lead the app already moved, say with Reactivate, keeps what the app set).
// It never sends a webhook, never deletes anything, and keeps every row's
// updatedAt (the stale-deal nudges and "last activity" go by it). A row the
// app changes while it runs is left alone and counted; run it again to
// finish those. Lead.stage (what the API and webhooks report) changes only on
// leads it marks a client, to "converted". Sandbox workspaces are skipped.
// Run the second time right after the deploy: a lead whose old stage is lost
// gets the Lost stage on the Leads list too, and a late "not interested" call
// sent through the API after the deploy leaves that pair on purpose.
//
// A deal goes on, in this order: the lead it was converted from
// (Lead.convertedDealId); the one lead its calls are on; the lead its client's
// other deals went to (Lead.convertedClientId, or a lead one of them is
// already on); a lead with the client's email or phone. A deal with none of
// those gets a new lead made from its client (one per client), dated from
// that client's first deal, unless the deal is in the trash. A deal the app
// is still making (processing, started in the last 10 minutes) waits for the
// next run.
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { pipelineStageFor } from "@/lib/lead-pipeline";

const STILL_MAKING_MS = 10 * 60 * 1000;

const apply = process.argv.includes("--apply");
const onlyWorkspace = process.argv.includes("--workspace") ? process.argv[process.argv.indexOf("--workspace") + 1] : null;

type Counts = Record<string, number>;
const bump = (c: Counts, key: string, n = 1) => (c[key] = (c[key] ?? 0) + n);

// Links the workspace's deals that have no lead, and returns the leads it put
// a deal on (or would, in a dry run): their stage is worked out from scratch.
async function linkWorkspace(workspaceId: string, counts: Counts, log: string[]): Promise<Set<string>> {
  const touched = new Set<string>();
  const deals = await prisma.deal.findMany({
    where: { workspaceId, leadId: null },
    select: { id: true, status: true, clientId: true, ownerId: true, trashedAt: true, createdAt: true, updatedAt: true, client: { select: { id: true, name: true, company: true, email: true, phone: true } } },
    orderBy: { createdAt: "asc" },
  });
  if (deals.length === 0) return touched;

  const leads = await prisma.lead.findMany({ where: { workspaceId }, select: { id: true, email: true, phone: true, convertedDealId: true, convertedClientId: true, updatedAt: true } });
  const leadUpdatedAt = new Map(leads.map((l) => [l.id, l.updatedAt]));
  const byConvertedDeal = new Map(leads.filter((l) => l.convertedDealId).map((l) => [l.convertedDealId!, l.id]));
  const byClient = new Map<string, string>();
  for (const l of leads) if (l.convertedClientId && !byClient.has(l.convertedClientId)) byClient.set(l.convertedClientId, l.id);
  // A lead one of the client's deals is already on, even after a merge took
  // that lead's client id with it (as leadForClient does).
  const onLeads = await prisma.deal.findMany({ where: { workspaceId, leadId: { not: null } }, select: { clientId: true, leadId: true }, orderBy: { createdAt: "asc" } });
  for (const d of onLeads) if (!byClient.has(d.clientId)) byClient.set(d.clientId, d.leadId!);
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

  const now = Date.now();
  for (const deal of deals) {
    if (deal.status === "processing" && now - deal.createdAt.getTime() < STILL_MAKING_MS) {
      bump(counts, "left: still being made (run again in a few minutes)");
      continue;
    }
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
      // A lead the app made for this client since the deals were read.
      const madeSince = apply
        ? await prisma.lead.findFirst({ where: { workspaceId, OR: [{ convertedClientId: deal.clientId }, { deals: { some: { clientId: deal.clientId } } }] }, orderBy: { createdAt: "asc" }, select: { id: true } })
        : null;
      if (madeSince) [leadId, via] = [madeSince.id, "client's lead"];
      else if (apply) {
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
            // Dated from the client's first deal (deals come oldest first),
            // not today: otherwise every old deal would show up as a fresh,
            // active lead for the next 30 days.
            createdAt: deal.createdAt,
            lastActivityAt: deal.createdAt,
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
    if (!byClient.has(deal.clientId)) byClient.set(deal.clientId, leadId);

    // The call the deal was made from: its sales call, when it had one.
    const fromCall = own.find((c) => c.mode === "sales" && c.leadId === leadId) ?? null;
    if (apply) {
      // Only if the app hasn't touched the deal since it was read: it may have
      // put it on a lead itself.
      const { count } = await prisma.deal.updateMany({
        where: { id: deal.id, leadId: null, updatedAt: deal.updatedAt },
        data: { leadId, ...(fromCall ? { phoneCallId: fromCall.id } : {}), updatedAt: deal.updatedAt },
      });
      if (count === 0) {
        bump(counts, "left: changed by the app meanwhile (run again)");
        continue;
      }
      const leadWas = leadUpdatedAt.get(leadId);
      await prisma.lead.updateMany({
        where: { id: leadId, convertedClientId: null, ...(leadWas ? { updatedAt: leadWas } : {}) },
        data: { convertedClientId: deal.clientId, ...(leadWas ? { updatedAt: leadWas } : {}) },
      });
      log.push(`  deal ${deal.id} -> lead ${leadId} (${via})`);
    }
    bump(counts, `linked via ${via}`);
    touched.add(leadId);
  }
  return touched;
}

// isClient, clientAt, pipelineStage and lastActivityAt for every lead in the
// workspace, from its deals and calls. touched: the leads this run put a deal
// on, whose stage is worked out from scratch.
async function fillLeadColumns(workspaceId: string, counts: Counts, touched: Set<string>): Promise<void> {
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
    // Lost on the Leads list while its old stage says otherwise: only the old
    // code (live between the two runs) moves a lead out of lost that way, so
    // it counts as not set aside. The app always changes both together.
    const was = lead.pipelineStage === "lost" && lead.stage !== "lost" ? "new" : lead.pipelineStage;
    // From scratch (an unsigned contract counts) only for a lead that just got
    // its deals: one the app has since brought back (Reactivate, a new call)
    // is "new" on purpose.
    const fromDocs = pipelineStageFor({ isClient, pipelineStage: was }, lead.deals, { fromScratch: was === "new" && touched.has(lead.id) });
    // A lead marked lost stays lost, unless a proposal or contract of its is
    // out with the client (the stage then follows that).
    const pipelineStage = lead.stage === "lost" && was === "new" && fromDocs === "new" ? "lost" : fromDocs;
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
    if (apply) {
      // Only if the app hasn't changed the lead since it was read (a
      // signature marking it a client, say): this would undo that.
      const { count } = await prisma.lead.updateMany({
        where: { id: lead.id, updatedAt: lead.updatedAt },
        data: { isClient, clientAt, pipelineStage, lastActivityAt, ...converted, updatedAt: lead.updatedAt },
      });
      if (count === 0) {
        bump(counts, "left: lead changed by the app meanwhile (run again)");
        continue;
      }
    }
    bump(counts, "leads updated");
    if (isClient && !lead.isClient) bump(counts, "leads marked client");
  }
}

async function main() {
  const workspaces = await prisma.workspace.findMany({
    where: { sandboxOfId: null, ...(onlyWorkspace ? { id: onlyWorkspace } : {}) },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(
    apply
      ? "Writing changes."
      : "Dry run: nothing is written. Add --apply to write.\nThe lead counts (stage, leads updated) are for leads as they are now: leads that get deals are worked out with --apply.",
  );
  const total: Counts = {};
  for (const ws of workspaces) {
    const counts: Counts = {};
    const log: string[] = [];
    const touched = await linkWorkspace(ws.id, counts, log);
    // In a dry run the new links aren't in the database, so the lead columns
    // below are worked out from what's there now.
    await fillLeadColumns(ws.id, counts, touched);
    const linked = Object.entries(counts).filter(([k]) => k.startsWith("linked") || k.startsWith("trashed") || k.startsWith("leads") || k.startsWith("left"));
    if (linked.length) console.log(`\n${ws.name} (${ws.id})\n${linked.map(([k, v]) => `  ${k}: ${v}`).join("\n")}`);
    // What was linked where, to look back at (or undo) later.
    if (log.length) console.log(log.join("\n"));
    for (const [k, v] of Object.entries(counts)) bump(total, k, v);
  }
  console.log(`\nAll workspaces (${workspaces.length})`);
  for (const [k, v] of Object.entries(total).sort()) console.log(`  ${k}: ${v}`);
  if (Object.keys(total).some((k) => k.startsWith("left:"))) console.log("\nSome rows were left for the next run (see \"left\" above): run it again in a few minutes.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
