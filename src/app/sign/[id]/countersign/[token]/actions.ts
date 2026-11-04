"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { notifyChangesRequested } from "@/lib/review";
import { advanceSigningOrFinalize } from "@/lib/signing";
import { countersignPageState, signPageMessage } from "../../sign-state";

// The contract filter matching countersignPageState's "open": out for
// signature on SealMe's own pages, and a "sent" one not past its expiry.
// Part of the same write as the signer's own update, so a contract that
// moved on since the page loaded isn't signed or declined anyway.
function openForCountersigning(now: Date): Prisma.ContractWhereInput {
  return {
    deliveryMethod: "sealme",
    OR: [{ status: "partially_signed" }, { status: "sent", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
  };
}

// Why nothing changed: a signer who already decided just sees their page
// again; otherwise the contract isn't open for them, and they're told why.
async function notOpenResult(contractId: string, token: string, now: Date): Promise<{ error: string }> {
  const signer = await prisma.contractSigner.findFirst({ where: { contractId, token }, include: { contract: { include: { deal: { include: { workspace: true } } } } } });
  if (!signer) return { error: "Not found" };
  if (signer.status !== "pending") redirect(`/sign/${contractId}/countersign/${token}`);
  const state = countersignPageState(signer.contract, now);
  return { error: signPageMessage(state, signer.contract.deal.workspace.name) ?? "This agreement can't be signed right now. Refresh the page." };
}

export async function signAsCountersigner(contractId: string, token: string, formData: FormData): Promise<{ error?: string }> {
  const signatureImage = String(formData.get("signatureImage") ?? "").trim();
  if (!signatureImage) return { error: "Draw your signature before signing" };

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdrs.get("x-real-ip") ?? "unknown";
  const allowed = await checkRateLimit(`countersign:${token}`, 10, 60 * 60 * 1000);
  if (!allowed) return { error: "Too many attempts. Try again later." };

  const signer = await prisma.contractSigner.findFirst({ where: { contractId, token } });
  if (!signer) return { error: "Not found" };

  // Same atomic-guard pattern as the client's own signContract — a
  // pending-only filter means a double-submit or an already-decided
  // signer can't overwrite the record.
  const now = new Date();
  const result = await prisma.contractSigner.updateMany({
    where: { id: signer.id, status: "pending", contract: openForCountersigning(now) },
    data: { status: "signed", signedAt: now, signatureImage, signerIp: ip },
  });
  if (result.count === 0) return notOpenResult(contractId, token, now);

  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, include: { deal: true } });
  await logAudit({
    workspaceId: contract.deal.workspaceId,
    actorEmail: signer.email,
    action: "contract.countersigned",
    targetType: "Contract",
    targetId: contractId,
    ip,
    metadata: { signerName: signer.name, role: signer.role },
  });

  await advanceSigningOrFinalize(contractId);

  redirect(`/sign/${contractId}/countersign/${token}`);
}

export async function declineToSign(contractId: string, token: string, formData: FormData): Promise<{ error?: string }> {
  const reason = String(formData.get("reason") ?? "").trim();

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdrs.get("x-real-ip") ?? "unknown";
  const allowed = await checkRateLimit(`countersign-decline:${token}`, 10, 60 * 60 * 1000);
  if (!allowed) return { error: "Too many attempts. Try again later." };

  const signer = await prisma.contractSigner.findFirst({ where: { contractId, token } });
  if (!signer) return { error: "Not found" };

  const now = new Date();
  const result = await prisma.contractSigner.updateMany({
    where: { id: signer.id, status: "pending", contract: openForCountersigning(now) },
    data: { status: "declined", declinedReason: reason || null },
  });
  if (result.count === 0) return notOpenResult(contractId, token, now);

  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });
  // Guarded too: a contract finalized by another signer in the meantime
  // isn't pulled back.
  const moved = await prisma.contract.updateMany({ where: { id: contractId, status: { in: ["sent", "partially_signed"] } }, data: { status: "changes_requested" } });
  if (moved.count === 0) redirect(`/sign/${contractId}/countersign/${token}`);
  await prisma.deal.update({ where: { id: contract.dealId }, data: { status: "changes_requested" } });

  const { workspaceId } = await prisma.deal.findUniqueOrThrow({ where: { id: contract.dealId }, select: { workspaceId: true } });
  await dispatchWebhookEvent(workspaceId, "contract.declined", {
    dealId: contract.dealId,
    contractId,
    signerName: signer.name,
    signerEmail: signer.email,
    reason: reason || null,
    declinedAt: new Date().toISOString(),
  });

  await logAudit({
    workspaceId,
    actorEmail: signer.email,
    action: "contract.countersign_declined",
    targetType: "Contract",
    targetId: contractId,
    ip,
    metadata: { signerName: signer.name, reason },
  });

  await notifyChangesRequested(contract.dealId, signer.name, reason ? `Declined to sign: ${reason}` : "Declined to sign");

  redirect(`/sign/${contractId}/countersign/${token}`);
}
