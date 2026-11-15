import { prisma } from "@/lib/db";

// A sandbox is a workspace of its own (see Workspace.sandboxOfId) with the
// parent's templates and a little sample data, for building and testing an
// integration through the API and webhooks. It has no users and no CRM
// connection, so nothing done in it reaches a real client.

export async function findSandbox(parentId: string) {
  return prisma.workspace.findFirst({ where: { sandboxOfId: parentId }, select: { id: true, name: true, createdAt: true, prospectingEnabled: true } });
}

export async function createSandbox(parentId: string): Promise<string> {
  const existing = await findSandbox(parentId);
  if (existing) return existing.id;
  const parent = await prisma.workspace.findUniqueOrThrow({ where: { id: parentId }, select: { name: true, prospectingEnabled: true, sandboxOfId: true } });
  if (parent.sandboxOfId) throw new Error("A sandbox can't have its own sandbox");
  const sandbox = await prisma.workspace.create({ data: { name: `${parent.name} (sandbox)`, sandboxOfId: parentId, prospectingEnabled: parent.prospectingEnabled } });
  // kind keeps proposal templates in the proposal list. A locked template
  // stays locked; who locked it is a person in the parent workspace.
  const templates = await prisma.contractTemplate.findMany({ where: { workspaceId: parentId }, select: { name: true, description: true, clauses: true, requiredFieldCount: true, kind: true, locked: true } });
  if (templates.length) await prisma.contractTemplate.createMany({ data: templates.map((t) => ({ ...t, workspaceId: sandbox.id })) });
  await seedSandbox(sandbox.id);
  return sandbox.id;
}

// Sample clients, deals and leads, so the API returns something on the
// first call.
export async function seedSandbox(sandboxId: string): Promise<void> {
  const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: sandboxId }, select: { sandboxOfId: true, prospectingEnabled: true } });
  if (!ws.sandboxOfId) throw new Error("Not a sandbox");
  // The sample deals are contracts, so they use a contract template.
  const template = await prisma.contractTemplate.findFirst({ where: { workspaceId: sandboxId, kind: { not: "proposal" } }, select: { id: true } });

  const samples = [
    { name: "Avery Chen", company: "Northwind Studio", email: "avery.chen@example.com", service: "Brand identity refresh", fee: "$8,500", status: "ready", missing: false },
    { name: "Jordan Patel", company: "Bluefin Logistics", email: "jordan.patel@example.com", service: "Quarterly analytics retainer", fee: "$4,000 a month", status: "missing_info", missing: true },
  ];
  for (const s of samples) {
    const client = await prisma.client.create({ data: { workspaceId: sandboxId, name: s.name, company: s.company, email: s.email } });
    await prisma.deal.create({
      data: {
        workspaceId: sandboxId,
        clientId: client.id,
        templateId: template?.id ?? null,
        service: s.service,
        feeDisplay: s.fee,
        status: s.status,
        source: "manual",
        summary: `Sample deal for testing: ${s.service} for ${s.company}.`,
        fields: {
          create: [
            { groupLabel: "Client & engagement", label: "Client", fieldKey: "clientName", value: s.name, status: "confirmed", orderIndex: 0 },
            { groupLabel: "Client & engagement", label: "Service", fieldKey: "service", value: s.service, status: "confirmed", orderIndex: 1 },
            { groupLabel: "Commercial terms", label: "Fee", fieldKey: "fee", value: s.fee, status: "confirmed", orderIndex: 2 },
            ...(s.missing ? [{ groupLabel: "Commercial terms", label: "Start date", fieldKey: "startDate", value: null, status: "missing", orderIndex: 3 }] : []),
          ],
        },
      },
    });
  }

  {
    await prisma.lead.createMany({
      data: [
        { workspaceId: sandboxId, name: "Sam Rivera", company: "Acme Freight", title: "Head of Revenue Operations", email: "sam.rivera@example.com", phone: "+12025550161", stage: "new", source: "manual", campaign: "Sample campaign", externalId: "sample-1001" },
        { workspaceId: sandboxId, name: "Morgan Lee", company: "Lumen Health", title: "VP Sales", email: "morgan.lee@example.com", phone: "+12025550162", stage: "contacted", interest: "warm", source: "manual", campaign: "Sample campaign", externalId: "sample-1002" },
        { workspaceId: sandboxId, name: "Taylor Brooks", company: "Orbit Labs", title: "COO", email: "taylor.brooks@example.com", phone: "+12025550163", stage: "interested", interest: "hot", source: "manual" },
      ],
    });
  }
}

// Deletes what's in a sandbox. keepSetup leaves its templates, keys and
// webhooks (a reset); otherwise the sandbox itself goes too. Refuses
// anything that isn't a sandbox, so a real workspace can never be wiped
// through here.
export async function purgeSandbox(sandboxId: string, options: { keepSetup: boolean }): Promise<void> {
  const ws = await prisma.workspace.findUnique({ where: { id: sandboxId }, select: { sandboxOfId: true, _count: { select: { users: true } } } });
  if (!ws?.sandboxOfId) throw new Error("Not a sandbox");
  if (ws._count.users > 0) throw new Error("This sandbox has users; refusing to delete it");
  const where = { workspaceId: sandboxId };

  await prisma.$transaction([
    prisma.task.deleteMany({ where }),
    prisma.callIntent.deleteMany({ where }),
    prisma.phoneCall.deleteMany({ where }),
    prisma.lead.deleteMany({ where }),
    prisma.leadImport.deleteMany({ where }),
    prisma.contract.deleteMany({ where: { deal: where } }),
    prisma.deal.deleteMany({ where }),
    prisma.client.deleteMany({ where }),
    prisma.calendarEvent.deleteMany({ where }),
    prisma.notification.deleteMany({ where }),
  ]);
  if (options.keepSetup) return;

  await prisma.$transaction([
    prisma.contractTemplate.deleteMany({ where }),
    prisma.apiKey.deleteMany({ where }),
    prisma.webhookEndpoint.deleteMany({ where }),
    prisma.upgradeRequest.deleteMany({ where }),
    prisma.auditLog.deleteMany({ where }),
    prisma.onboardingProfile.deleteMany({ where }),
    prisma.workspace.delete({ where: { id: sandboxId } }),
  ]);
}
