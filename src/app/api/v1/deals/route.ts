import { after } from "next/server";
import { prisma } from "@/lib/db";
import { apiGuard, apiJson, apiError, parseIsoParam, readJsonObject } from "@/lib/api-auth";
import { serializeDeal } from "@/lib/api-serialize";
import { announceNewDeal, finishTranscriptDeal } from "@/lib/api-deals";
import { reportError } from "@/lib/error-report";
import { findApiLead } from "@/lib/api-activity";
import { leadForClient } from "@/lib/client-lead";

// Reading terms from a long transcript can take a minute; it runs after
// the 202, within this route's time.
export const maxDuration = 300;

const MAX_TRANSCRIPT = 400_000;

const PAGE_SIZE = 50;

const DEAL_KINDS = ["contract", "proposal", "all"];

// GET /api/v1/deals?status=&updatedSince=&kind=&cursor=: a workspace's own IT
// team pulling deals into their own systems (a CRM sync, a BI dashboard).
// An API key is a workspace-wide credential (no per-user identity), so
// this deliberately sees every deal, the same way SCIM does, not scoped
// by dealVisibilityFilter, which is about a person's own view inside the
// app.
export async function GET(req: Request) {
  const auth = await apiGuard(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const cursor = url.searchParams.get("cursor");
  const since = parseIsoParam(url.searchParams.get("updatedSince"), "updatedSince");
  if ("error" in since) return apiError(400, since.error);
  const updatedSinceDate = since.date;
  // Contracts only unless asked: integrations written before proposals
  // existed treat every deal here as a contract.
  const kind = url.searchParams.get("kind") || "contract";
  if (!DEAL_KINDS.includes(kind)) return apiError(400, `kind must be one of: ${DEAL_KINDS.join(", ")}`);

  const deals = await prisma.deal.findMany({
    where: {
      workspaceId: auth.workspaceId,
      trashedAt: null,
      ...(kind === "all" ? {} : { kind }),
      ...(status ? { status } : {}),
      ...(updatedSinceDate ? { updatedAt: { gte: updatedSinceDate } } : {}),
    },
    include: { client: true, owner: { select: { name: true, email: true } } },
    orderBy: { id: "asc" },
    take: PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = deals.length > PAGE_SIZE;
  const page = hasMore ? deals.slice(0, PAGE_SIZE) : deals;

  return apiJson({
    data: page.map(serializeDeal),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  });
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

// POST /api/v1/deals: start a deal from outside SealMe. Two ways:
//  - { transcript, templateId, client? }: SealMe reads the agreed terms
//    from the call transcript, the same as "Paste a transcript" in the
//    app. Answers 202 right away with the deal "processing"; it becomes
//    "ready" or "missing_info" when the terms are in (deal.created fires
//    then), or "extraction_failed".
//  - { client | clientId, service, fee, templateId? }: a deal whose terms
//    are already known, "ready" straight away.
// ownerEmail gives the deal to a teammate; without it the deal has no
// owner, which everyone who can see deals can see. leadId or leadExternalId
// puts the deal on that lead (its client details fill in for a missing
// client); without them it goes on the client's lead, found by the client's
// earlier deals or email, or made from the client.
export async function POST(req: Request) {
  const auth = await apiGuard(req, { write: true });
  if (auth instanceof Response) return auth;
  const { workspaceId } = auth;

  const body = await readJsonObject(req);
  if (!body) return apiError(400, "The body must be a JSON object");

  const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
  if (transcript.length > MAX_TRANSCRIPT) return apiError(413, `transcript is too long (${MAX_TRANSCRIPT.toLocaleString("en-US")} characters at most)`);

  const templateId = text(body.templateId, 100);
  const template = templateId ? await prisma.contractTemplate.findFirst({ where: { id: templateId, workspaceId }, select: { id: true, clauses: true, kind: true } }) : null;
  if (templateId && !template) return apiError(400, "templateId doesn't match a template in this workspace. GET /api/v1/templates lists them");
  // The API makes contracts; a proposal template would make a contract
  // that reads like a proposal.
  if (template?.kind === "proposal") return apiError(400, "templateId must be a contract template (kind contract). GET /api/v1/templates lists them");

  const ownerEmail = text(body.ownerEmail, 200)?.toLowerCase() ?? null;
  const owner = ownerEmail ? await prisma.user.findFirst({ where: { workspaceId, email: { equals: ownerEmail, mode: "insensitive" }, deactivatedAt: null }, select: { id: true, teamId: true } }) : null;
  if (ownerEmail && !owner) return apiError(400, "ownerEmail doesn't match anyone active in this workspace");

  const clientIn = body.client && typeof body.client === "object" && !Array.isArray(body.client) ? (body.client as Record<string, unknown>) : null;
  const given = { name: text(clientIn?.name, 200), company: text(clientIn?.company, 200), email: text(clientIn?.email, 200)?.toLowerCase() ?? null };
  if (given.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(given.email)) return apiError(400, "client.email doesn't look like an email address");
  const clientId = text(body.clientId, 100);
  const pickedClient = clientId ? await prisma.client.findFirst({ where: { id: clientId, workspaceId } }) : null;
  if (clientId && !pickedClient) return apiError(400, "clientId doesn't match a client in this workspace");

  // Any value but a blank one goes to findApiLead, which takes a number too
  // (as the leads API stores it) and answers 400 or 404 for the rest, so a
  // lead asked for is never skipped for one made from the client.
  const leadAsked = (v: unknown) => v != null && !(typeof v === "string" && !v.trim());
  const named = leadAsked(body.leadId) || leadAsked(body.leadExternalId) ? await findApiLead(workspaceId, body) : null;
  if (named && "error" in named) return apiError(named.status, named.error);
  const lead = named?.lead ?? null;
  // A lead's deals all go to one client: the one its earlier deals went to.
  const leadClient = !pickedClient && lead?.convertedClientId ? await prisma.client.findFirst({ where: { id: lead.convertedClientId, workspaceId } }) : null;
  const existingClient = pickedClient ?? leadClient;
  if (lead && !existingClient && !given.name) Object.assign(given, { name: lead.name.slice(0, 200), company: given.company ?? lead.company, email: given.email ?? lead.email });
  const leadFor = async (client: { id: string; name: string; company: string; email: string | null }) => {
    if (!lead) return leadForClient(workspaceId, client, { ownerId: owner?.id ?? null, source: "api" });
    if (!lead.convertedClientId) await prisma.lead.update({ where: { id: lead.id }, data: { convertedClientId: client.id } });
    return lead.id;
  };

  if (transcript) {
    if (!template) return apiError(400, "templateId is required with a transcript, so SealMe knows which terms to look for");
    const client = existingClient ?? (await prisma.client.create({ data: { workspaceId, name: given.name ?? "New client", company: given.company ?? given.name ?? "New client", email: given.email } }));
    // Nobody said who the client is: the transcript names them, then the
    // deal goes on their lead (see finishTranscriptDeal).
    const unnamed = !lead && !existingClient && !given.name;
    const deal = await prisma.deal.create({
      data: {
        workspaceId,
        clientId: client.id,
        leadId: unnamed ? null : await leadFor(client),
        templateId: template.id,
        ownerId: owner?.id ?? null,
        teamId: owner?.teamId ?? null,
        service: "",
        feeDisplay: "",
        status: "processing",
        source: "api",
        calls: { create: { transcript, source: "api", endedAt: new Date() } },
      },
      include: { client: true, owner: { select: { name: true, email: true } }, calls: { select: { id: true } } },
    });
    await prisma.workspace.update({ where: { id: workspaceId }, data: { callsUsedThisMonth: { increment: 1 } } });
    after(() =>
      finishTranscriptDeal({
        workspaceId,
        dealId: deal.id,
        callId: deal.calls[0].id,
        clientId: client.id,
        transcript,
        templateClauses: template.clauses,
        clientGiven: existingClient ? { name: true, company: true, email: Boolean(existingClient.email) } : { name: Boolean(given.name), company: Boolean(given.company), email: Boolean(given.email) },
        linkLead: unnamed ? { ownerId: owner?.id ?? null } : undefined,
      }),
    );
    return apiJson(serializeDeal(deal), 202);
  }

  const service = text(body.service, 500);
  const fee = text(body.fee, 200);
  if (!service || !fee) return apiError(400, "Send either transcript and templateId, or service and fee");
  if (!existingClient && !given.name) return apiError(400, "client.name (or clientId) is required");
  const client = existingClient ?? (await prisma.client.create({ data: { workspaceId, name: given.name as string, company: given.company ?? (given.name as string), email: given.email } }));
  const deal = await prisma.deal.create({
    data: {
      workspaceId,
      clientId: client.id,
      leadId: await leadFor(client),
      templateId: template?.id ?? null,
      ownerId: owner?.id ?? null,
      teamId: owner?.teamId ?? null,
      service,
      feeDisplay: fee,
      status: "ready",
      source: "api",
      fields: {
        create: [
          { groupLabel: "Client & engagement", label: "Client", fieldKey: "clientName", value: client.name, status: "confirmed", orderIndex: 0 },
          { groupLabel: "Client & engagement", label: "Service", fieldKey: "service", value: service, status: "confirmed", orderIndex: 1 },
          { groupLabel: "Commercial terms", label: "Fee", fieldKey: "fee", value: fee, status: "confirmed", orderIndex: 2 },
        ],
      },
    },
    include: { client: true, owner: { select: { name: true, email: true } } },
  });
  await prisma.workspace.update({ where: { id: workspaceId }, data: { callsUsedThisMonth: { increment: 1 } } });
  after(() => announceNewDeal(workspaceId, deal.id).catch((err) => reportError(err, "Integrations after an API deal", { dealId: deal.id })));
  return apiJson(serializeDeal(deal), 201);
}
