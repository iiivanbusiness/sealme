"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import { notifyChangesRequested } from "@/lib/review";
import { advanceSigningOrFinalize } from "@/lib/signing";
import { canCommentOnClauses, signPageMessage, signPageState } from "./sign-state";

export async function signContract(contractId: string, formData: FormData): Promise<{ error?: string }> {
  const signerName = String(formData.get("signerName") ?? "").trim();
  const signatureImage = String(formData.get("signatureImage") ?? "").trim();
  if (!signerName) return { error: "Name is required" };
  if (!signatureImage) return { error: "Draw your signature before signing" };

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdrs.get("x-real-ip") ?? "unknown";

  const [contractOk, ipOk] = await Promise.all([
    checkRateLimit(`sign:contract:${contractId}`, 10, 60 * 60 * 1000),
    checkRateLimit(`sign:ip:${ip}`, 20, 60 * 60 * 1000),
  ]);
  if (!contractOk || !ipOk) return { error: "Too many attempts. Try again later." };

  // updateMany with a status filter makes this atomic: a contract that's
  // already been signed, or has moved on to waiting for a counter-signer,
  // or a concurrent double-submit, can't overwrite the existing
  // signerName/signatureImage/signedAt. That's the legally significant
  // record, it shouldn't be replaceable after the fact. Only a contract
  // still sitting at "sent" (the client hasn't acted yet), on SealMe's own
  // page and not past its expiry, can be signed. The status moves off
  // "sent" in this same write, so a second submit racing this one finds
  // nothing to update; advanceSigningOrFinalize then settles on
  // partially_signed or signed.
  const now = new Date();
  const result = await prisma.contract.updateMany({
    where: { id: contractId, status: "sent", deliveryMethod: "sealme", OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    data: { status: "partially_signed", signedAt: now, signerName, signerIp: ip, signatureImage },
  });
  if (result.count === 0) {
    const current = await prisma.contract.findUnique({ where: { id: contractId }, include: { deal: { include: { workspace: true } } } });
    if (!current) return { error: "Not found" };
    const state = signPageState(current, now);
    // A double-submit after the first one went through: just show it signed.
    if (state === "signed") redirect(`/sign/${contractId}`);
    return { error: signPageMessage(state, current.deal.workspace.name) ?? "This agreement can't be signed right now. Refresh the page." };
  }

  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractId } });

  await logAudit({
    workspaceId: (await prisma.deal.findUniqueOrThrow({ where: { id: contract.dealId }, select: { workspaceId: true } })).workspaceId,
    actorEmail: signerName,
    action: "contract.signed",
    targetType: "Contract",
    targetId: contract.id,
    ip,
  });

  // finalizeContractSigned (when nobody else needs to sign) or
  // notifying the next counter-signer (when someone does) both happen
  // here — the client's own signing action doesn't need to know which.
  await advanceSigningOrFinalize(contractId);

  redirect(`/sign/${contractId}`);
}

// A client leaving feedback on one specific clause before they've decided
// to sign — the "sign-or-nothing" gap. Reuses the changes_requested status
// (same one an internal approval rejection sets), so the contract page's
// existing "Send again" flow just works with no separate code path.
export async function requestClauseChange(contractId: string, clauseTitle: string, formData: FormData): Promise<{ error?: string }> {
  const comment = String(formData.get("comment") ?? "").trim();
  const fromName = String(formData.get("fromName") ?? "").trim() || "The client";
  if (!comment) return { error: "Add a comment before sending" };

  const hdrs = await headers();
  const ip = hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? hdrs.get("x-real-ip") ?? "unknown";
  const allowed = await checkRateLimit(`clause-comment:contract:${contractId}`, 10, 60 * 60 * 1000);
  if (!allowed) return { error: "Too many requests. Try again later." };

  const contract = await prisma.contract.findUnique({ where: { id: contractId }, include: { deal: { include: { workspace: true } } } });
  if (!contract) return { error: "Not found" };
  const closed = signPageMessage(signPageState(contract), contract.deal.workspace.name) ?? "This agreement can no longer be changed";
  if (!canCommentOnClauses(contract)) return { error: closed };

  // Guarded the same way as signing: a contract that moved into approval
  // or got signed since the page loaded doesn't get pulled back.
  const moved = await prisma.contract.updateMany({
    where: { id: contractId, status: { in: ["sent", "changes_requested"] } },
    data: { status: "changes_requested" },
  });
  if (moved.count === 0) return { error: closed };
  await prisma.clauseComment.create({ data: { contractId, clauseTitle, comment, fromName } });
  await prisma.deal.update({ where: { id: contract.dealId }, data: { status: "changes_requested" } });

  await logAudit({
    workspaceId: contract.deal.workspaceId,
    actorEmail: fromName,
    action: "contract.clause_change_requested",
    targetType: "Contract",
    targetId: contractId,
    ip,
    metadata: { clauseTitle, comment },
  });

  await notifyChangesRequested(contract.dealId, fromName, `On "${clauseTitle}": ${comment}`);

  redirect(`/sign/${contractId}?feedbackSent=1`);
}
