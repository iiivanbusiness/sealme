import { renderToBuffer } from "@react-pdf/renderer";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { currentUserWithRole } from "@/lib/permissions";
import { AuditTrailPdfDocument, formatAuditTime, type AuditEvent } from "@/lib/audit-trail-pdf";
import { attachmentDisposition } from "@/lib/contract-pdf";
import { parseContractSnapshot } from "@/lib/contract-snapshot";

const CALL_SOURCE_LABEL: Record<string, string> = {
  local: "Recorded locally",
  upload: "Pasted transcript",
  recording: "Uploaded recording",
  phone: "Phone call",
  api: "Sent through the API",
};

// Compliance-sensitive (review decisions, signer IPs) — gated on
// canManageWorkspace, the same admin tier that configures the review
// chain itself, not the general canManageTemplates permission a regular
// teammate might hold.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let user;
  try {
    user = await currentUserWithRole();
  } catch {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!user.role?.canManageWorkspace) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const deal = await prisma.deal.findFirst({
    where: { id, workspaceId: user.workspaceId },
    include: {
      client: true,
      workspace: true,
      calls: { orderBy: { startedAt: "asc" } },
      fieldChanges: { orderBy: { changedAt: "asc" } },
      contract: {
        include: {
          template: true,
          reviewSteps: { include: { assignee: true, decidedByUser: true }, orderBy: { order: "asc" } },
        },
      },
    },
  });
  if (!deal) return new NextResponse("Not found", { status: 404 });

  const auditLogs = deal.contract
    ? await prisma.auditLog.findMany({
        where: { workspaceId: user.workspaceId, OR: [{ targetId: deal.id }, { targetId: deal.contract.id }] },
        orderBy: { createdAt: "asc" },
      })
    : await prisma.auditLog.findMany({
        where: { workspaceId: user.workspaceId, targetId: deal.id },
        orderBy: { createdAt: "asc" },
      });

  const events: AuditEvent[] = [];

  events.push({ when: deal.createdAt, label: "Deal created", detail: `${deal.client.name} - ${deal.service}` });

  for (const call of deal.calls) {
    events.push({
      when: call.startedAt,
      label: `Call recorded (${CALL_SOURCE_LABEL[call.source] ?? call.source})`,
      detail: call.endedAt ? `Ended ${formatAuditTime(call.endedAt)}` : "In progress",
    });
  }

  for (const change of deal.fieldChanges) {
    events.push({
      when: change.changedAt,
      label: `Field changed: ${change.fieldKey}`,
      detail: `"${change.oldValue ?? "-"}" → "${change.newValue ?? "-"}" (${change.changedBy === "manual" ? "edited manually" : "from a call"})`,
    });
  }

  if (deal.contract) {
    for (const step of deal.contract.reviewSteps) {
      if (step.status === "pending") continue;
      events.push({
        when: step.decidedAt ?? deal.contract.createdAt,
        label: `Review ${step.status} - ${step.assignee.name}`,
        detail: [step.decidedByUser ? `by ${step.decidedByUser.name} (${step.decidedByUser.email})` : null, step.note ? `"${step.note}"` : null]
          .filter(Boolean)
          .join(", "),
      });
    }
    if (deal.contract.sentAt) {
      events.push({ when: deal.contract.sentAt, label: "Contract sent to client" });
    }
    if (deal.contract.viewedAt) {
      events.push({ when: deal.contract.viewedAt, label: "Client viewed the sign page" });
    }
    if (deal.contract.signedAt) {
      events.push({
        when: deal.contract.signedAt,
        label: "Contract signed",
        detail: [deal.contract.signerName ? `by ${deal.contract.signerName}` : null, deal.contract.signerIp ? `from IP ${deal.contract.signerIp}` : null]
          .filter(Boolean)
          .join(" "),
      });
    }
  }

  for (const entry of auditLogs) {
    let detail: string | null = null;
    if (entry.metadata) {
      try {
        const parsed = JSON.parse(entry.metadata) as Record<string, unknown>;
        detail = Object.entries(parsed)
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ") || null;
      } catch {
        // ignore malformed metadata
      }
    }
    events.push({
      when: entry.createdAt,
      label: `System log: ${entry.action}`,
      detail: [entry.actorEmail, detail, entry.ip ? `IP ${entry.ip}` : null].filter(Boolean).join(", ") || null,
    });
  }

  events.sort((a, b) => a.when.getTime() - b.when.getTime());

  const buffer = await renderToBuffer(
    <AuditTrailPdfDocument
      clientName={deal.client.name}
      templateName={parseContractSnapshot(deal.contract?.snapshot)?.templateName ?? deal.contract?.template?.name ?? deal.service}
      workspaceName={deal.workspace.name}
      generatedAt={new Date()}
      events={events}
    />
  );

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": attachmentDisposition(`Audit-Trail-${deal.client.name.replace(/\s+/g, "-")}.pdf`),
    },
  });
}
