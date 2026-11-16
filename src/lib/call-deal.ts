import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { createDealFromTranscriptText, finishTranscriptDealInBackground } from "@/lib/transcript-deal";
import { clientCrmIds } from "@/lib/crm-leads";
import { NEW_LEAD_NAME } from "@/lib/cold-call";
import { createNotification } from "@/lib/notifications";
import { sendContractReadyEmail } from "@/lib/email";
import { reportError } from "@/lib/error-report";
import { recordAiUsage } from "@/lib/ai-usage";

export type DealKind = "proposal" | "contract";

type TemplateOption = { id: string; name: string; description: string };

// Which template fits a call, when the rep didn't pick one. A single
// template needs no question; otherwise Haiku reads the call and picks by
// name and description, and anything unusable falls back to the first.
export async function suggestTemplateId(transcript: string, templates: TemplateOption[]): Promise<string> {
  if (templates.length <= 1) return templates[0].id;
  try {
    // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
    // overloaded call can't run past the 300 s its request gets.
    const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
    const message = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 50,
      system:
        "You pick which template fits what was agreed on a sales call. " +
        "Reply with the number of the best template and nothing else.",
      messages: [
        {
          role: "user",
          content: `Templates:\n${templates.map((t, i) => `${i + 1}. ${t.name}${t.description ? `: ${t.description}` : ""}`).join("\n")}\n\nCall transcript:\n${transcript.slice(0, 20_000)}`,
        },
      ],
    });
    recordAiUsage(message);
    const text = message.content.find((c) => c.type === "text")?.text ?? "";
    const n = Number(text.match(/\d+/)?.[0]);
    if (Number.isInteger(n) && n >= 1 && n <= templates.length) return templates[n - 1].id;
  } catch (err) {
    await reportError(err, "Template suggestion for a call");
  }
  return templates[0].id;
}

const KIND_LABEL: Record<DealKind, string> = { proposal: "proposal", contract: "contract" };

// A proposal or a contract from a call that's already written up: a deal on
// the call's lead, read off the same transcript, on the template the rep
// picked or the one that fits. Every proposal and contract for a lead goes to
// the same client. It's always a draft, however complete: nothing goes to
// the client until the rep sends it.
//
// Nothing here makes the lead a client: that happens when a contract is
// signed (see markLeadClient). quiet: the rep asked for it on the lead and is
// waiting for it, so there's nobody to tell.
export async function buildDealFromCall(callId: string, kind: DealKind, options: { quiet?: boolean; ownerId?: string } = {}): Promise<{ dealId: string }> {
  const call = await prisma.phoneCall.findUniqueOrThrow({
    where: { id: callId },
    include: {
      lead: true,
      user: { select: { id: true, name: true, email: true, teamId: true, deactivatedAt: true } },
      workspace: { select: { id: true } },
    },
  });
  const { lead, workspace } = call;
  if (!lead || !call.transcript) throw new Error("This call has no lead or transcript");
  // A call logged through the API may have no rep: the deal goes to whoever
  // owns the lead, and nobody is told.
  const user = call.user && !call.user.deactivatedAt ? call.user : null;
  // Made by hand from the lead's page: it's whoever asked for it, so they
  // can open it.
  const asked = options.ownerId ? await prisma.user.findFirst({ where: { id: options.ownerId, workspaceId: workspace.id, deactivatedAt: null }, select: { id: true, teamId: true } }) : null;
  const owner = asked ?? user ?? (lead.ownerId ? await prisma.user.findFirst({ where: { id: lead.ownerId, workspaceId: workspace.id, deactivatedAt: null }, select: { id: true, teamId: true } }) : null);

  const templates = await prisma.contractTemplate.findMany({ where: { workspaceId: workspace.id, kind }, select: { id: true, name: true, description: true }, orderBy: { name: "asc" } });
  if (templates.length === 0) throw new Error(`This workspace has no ${KIND_LABEL[kind]} templates yet`);
  const templateId = call.templateId && templates.some((t) => t.id === call.templateId) ? call.templateId : await suggestTemplateId(call.transcript, templates);

  // The lead's client from an earlier proposal or contract, when it's still there.
  const client = lead.convertedClientId ? await prisma.client.findFirst({ where: { id: lead.convertedClientId, workspaceId: workspace.id }, select: { id: true } }) : null;

  const made = await createDealFromTranscriptText({
    workspaceId: workspace.id,
    ownerId: owner?.id ?? null,
    teamId: owner?.teamId ?? null,
    templateId,
    transcript: call.transcript,
    // How the deal's timeline and audit trail name the call: a pasted
    // transcript, a desktop recording, a phone call or an uploaded recording.
    callSource: call.source === "phone" ? "phone" : call.source === "paste" ? "upload" : call.source === "desktop" ? "local" : "recording",
    dealSource: call.source === "phone" ? "phone" : "upload",
    // A lead still called "New lead from a call" has no name yet: the one
    // heard on the call names the client, and no field gets the placeholder.
    knownClient: { name: lead.name === NEW_LEAD_NAME ? "" : lead.name, company: lead.company, title: lead.title, email: lead.email, phone: lead.phone, ...clientCrmIds(lead) },
    clientId: client?.id ?? null,
    requireEmail: true,
    link: { leadId: lead.id, phoneCallId: call.id, kind },
  });

  const now = new Date();
  const leadData = { lastActivityAt: now, ...(client ? {} : { convertedClientId: made.clientId }) };
  await prisma.$transaction([
    // The call points at its contract (or its proposal, when that's all it
    // made), the way the Calls inbox and the API read it. Its template stays
    // the contract's: a proposal made first mustn't take the rep's pick.
    prisma.phoneCall.update({ where: { id: call.id }, data: kind === "contract" ? { dealId: made.dealId, templateId } : !call.dealId ? { dealId: made.dealId } : {} }),
    prisma.lead.update({ where: { id: lead.id }, data: leadData }),
  ]);

  // Everything the call covered: a draft ready for the rep to review and
  // send. One with gaps waits on the details first.
  if (!made.hasMissing) await prisma.contract.upsert({ where: { dealId: made.dealId }, create: { dealId: made.dealId, templateId, status: "draft" }, update: {} });
  if (user && !options.quiet) await tellRep({ workspaceId: workspace.id, user, kind, dealId: made.dealId, clientName: made.clientName, hasMissing: made.hasMissing });

  await finishTranscriptDealInBackground(workspace.id, made.dealId, made.callId, call.transcript, { announce: kind === "contract" });
  return { dealId: made.dealId };
}

// The proposal or contract a call asked for couldn't be made: the notes are
// saved either way, so the rep hears what's missing instead of finding it
// gone.
export async function tellRepDealFailed(o: { workspaceId: string; userId: string | null; leadId: string; kind: DealKind; reason: string }): Promise<void> {
  if (!o.userId) return;
  await createNotification({
    workspaceId: o.workspaceId,
    userId: o.userId,
    type: "contract.ready",
    title: `SealMe couldn't make the ${KIND_LABEL[o.kind]} from your call`,
    body: `${o.reason}. The notes are saved; make the ${KIND_LABEL[o.kind]} from the call on the lead.`,
    linkUrl: `/leads/${o.leadId}`,
  }).catch((err) => reportError(err, "Deal failed notification", { leadId: o.leadId }));
}

async function tellRep(o: { workspaceId: string; user: { id: string; email: string }; kind: DealKind; dealId: string; clientName: string; hasMissing: boolean }): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const what = KIND_LABEL[o.kind];
  const What = what[0].toUpperCase() + what.slice(1);
  const n = o.hasMissing
    ? { title: `${What} for ${o.clientName} needs a few details`, body: `Fill in what the call didn't cover, then send the ${what}.`, path: `/deals/${o.dealId}`, action: "Fill in the details" }
    : { title: `${What} for ${o.clientName} is ready`, body: "Review it and send it.", path: `/deals/${o.dealId}`, action: `Review the ${what}` };
  await createNotification({ workspaceId: o.workspaceId, userId: o.user.id, type: "contract.ready", title: n.title, body: n.body, linkUrl: n.path }).catch((err) =>
    reportError(err, "Contract-ready notification", { dealId: o.dealId }),
  );
  await sendContractReadyEmail({ to: o.user.email, subject: n.title, message: n.body, actionLabel: n.action, url: `${base}${n.path}` }).catch((err) =>
    reportError(err, "Contract-ready email", { dealId: o.dealId }),
  );
}
