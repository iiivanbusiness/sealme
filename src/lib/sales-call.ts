import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { createDealFromTranscriptText, finishTranscriptDealInBackground } from "@/lib/transcript-deal";
import { leadHistoryNote } from "@/lib/lead-history";
import { clientCrmIds } from "@/lib/crm-leads";
import { autoGenerateAndSendContract } from "@/lib/auto-send";
import { createNotification } from "@/lib/notifications";
import { sendContractReadyEmail } from "@/lib/email";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { dispatchCallCompleted, dispatchLeadsUpdated, dispatchTasksCompleted, leadChanges } from "@/lib/webhook-events";
import { reportError } from "@/lib/error-report";
import { recordAiUsage } from "@/lib/ai-usage";

type TemplateOption = { id: string; name: string; description: string };

// Which template fits a sales call, when the rep didn't pick one. A single
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
        "You pick which contract template fits what was agreed on a sales call. " +
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
    await reportError(err, "Template suggestion for a sales call");
  }
  return templates[0].id;
}

// A processed sales call from the Calls inbox: the lead becomes a client and
// a deal on the call's template, with the contract drafted (or sent, when
// the workspace doesn't require approval and nothing is missing), and the
// rep hears about it in the app and by email. draftOnly: SealMe itself
// decided this was a sales call, so the contract waits for the rep
// whatever the workspace allows.
export async function applySalesCall(callId: string, options: { draftOnly?: boolean } = {}): Promise<void> {
  const call = await prisma.phoneCall.findUniqueOrThrow({
    where: { id: callId },
    include: {
      lead: { include: { phoneCalls: { where: { status: "processed" }, orderBy: { startedAt: "asc" }, include: { user: { select: { name: true } } } } } },
      user: { select: { id: true, name: true, email: true, teamId: true } },
      workspace: { select: { id: true, requireApproval: true } },
    },
  });
  const { lead, user, workspace } = call;
  if (!lead || !user || !call.transcript) throw new Error("This call has no lead, rep or transcript");

  const templates = await prisma.contractTemplate.findMany({ where: { workspaceId: workspace.id }, select: { id: true, name: true, description: true }, orderBy: { name: "asc" } });
  if (templates.length === 0) throw new Error("This workspace has no contract templates yet");
  const templateId = call.templateId && templates.some((t) => t.id === call.templateId) ? call.templateId : await suggestTemplateId(call.transcript, templates);

  const made = await createDealFromTranscriptText({
    workspaceId: workspace.id,
    ownerId: user.id,
    teamId: user.teamId,
    templateId,
    transcript: call.transcript,
    callSource: call.source === "phone" ? "phone" : "recording",
    dealSource: "phone",
    knownClient: { name: lead.name, company: lead.company, email: lead.email, phone: lead.phone, ...clientCrmIds(lead) },
    requireEmail: true,
    note: { authorEmail: user.email, authorName: user.name, body: leadHistoryNote(lead, lead.phoneCalls, `after ${user.name}'s sales call`) },
  });

  const now = new Date();
  const closing = await prisma.task.findMany({ where: { leadId: lead.id, assigneeId: user.id, status: "open", type: "sales_call" }, select: { id: true } });
  const leadData = { stage: "converted", convertedAt: lead.convertedAt ?? now, convertedClientId: made.clientId, convertedDealId: made.dealId, lastContactedAt: now };
  await prisma.$transaction([
    prisma.phoneCall.update({ where: { id: call.id }, data: { status: "processed", mode: "sales", templateId, dealId: made.dealId, summary: made.summary, connected: true, processedAt: now } }),
    prisma.phoneCall.updateMany({ where: { leadId: lead.id, dealId: null }, data: { dealId: made.dealId } }),
    prisma.lead.update({ where: { id: lead.id }, data: leadData }),
    prisma.task.updateMany({ where: { id: { in: closing.map((t) => t.id) }, status: "open" }, data: { status: "done", completedAt: now } }),
  ]);

  await dispatchLeadsUpdated(workspace.id, [leadChanges(lead.id, lead, leadData)]);
  await dispatchCallCompleted(workspace.id, call.id);
  await dispatchTasksCompleted(workspace.id, closing.map((t) => t.id), { callId: call.id });

  await dispatchWebhookEvent(workspace.id, "lead.converted", { leadId: lead.id, dealId: made.dealId, clientId: made.clientId, name: lead.name, company: lead.company, convertedAt: now.toISOString() }).catch((err) =>
    reportError(err, "lead.converted webhook after a sales call", { dealId: made.dealId }),
  );

  // The contract: drafted for review, or out to the client right away when
  // the workspace lets complete deals send on their own.
  let sent = false;
  if (!made.hasMissing) {
    if (!workspace.requireApproval && !options.draftOnly) sent = await autoGenerateAndSendContract(made.dealId);
    if (!sent) await prisma.contract.upsert({ where: { dealId: made.dealId }, create: { dealId: made.dealId, templateId, status: "draft" }, update: {} });
  }
  await tellRep({ workspaceId: workspace.id, user, dealId: made.dealId, clientName: made.clientName, hasMissing: made.hasMissing, sent });

  await finishTranscriptDealInBackground(workspace.id, made.dealId, made.callId, call.transcript);
}

async function tellRep(o: { workspaceId: string; user: { id: string; email: string }; dealId: string; clientName: string; hasMissing: boolean; sent: boolean }): Promise<void> {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  const n = o.sent
    ? { title: `Contract sent to ${o.clientName}`, body: "Everything was in the call, so it went out on its own.", path: `/deals/${o.dealId}`, action: "Open the deal" }
    : o.hasMissing
      ? { title: `Deal for ${o.clientName} needs a few details`, body: "Fill in what the call didn't cover, then send the contract.", path: `/deals/${o.dealId}`, action: "Fill in the details" }
      : { title: `Contract for ${o.clientName} is ready`, body: "Review it and send it.", path: `/deals/${o.dealId}/contract`, action: "Review the contract" };
  await createNotification({ workspaceId: o.workspaceId, userId: o.user.id, type: "contract.ready", title: n.title, body: n.body, linkUrl: n.path }).catch((err) =>
    reportError(err, "Contract-ready notification", { dealId: o.dealId }),
  );
  await sendContractReadyEmail({ to: o.user.email, subject: n.title, message: n.body, actionLabel: n.action, url: `${base}${n.path}` }).catch((err) =>
    reportError(err, "Contract-ready email", { dealId: o.dealId }),
  );
}
