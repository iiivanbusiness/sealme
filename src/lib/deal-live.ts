import { prisma } from "@/lib/db";
import { extractDealFromTranscript, buildDealFieldRows } from "@/lib/extract-deal";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lives in a prisma-free module so LiveDealView hides the Edit button by the
// same rule the server actions enforce.
export { contractLocksTerms } from "@/lib/contract-status";

// Runs an extraction pass against the given transcript and writes the result onto
// an existing deal — upserting fields (never overwriting a human-confirmed or
// user-edited value) and flipping deal status the moment nothing is missing,
// even mid-call. Used by both the live realtime webhook and the final post-call pass.
export async function applyExtractionToDeal(
  dealId: string,
  transcript: string,
  placeholderKeys: string[],
  callId?: string
): Promise<{ hasMissing: boolean }> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { contract: { select: { status: true } }, client: { select: { email: true } } },
  });
  if (!deal) throw new Error("Deal not found");
  if (deal.status === "sent" || deal.status === "signed") return { hasMissing: false };
  // Once an approver or the client is looking at the contract, a call that's
  // still recording must not rewrite the terms under them. After the client
  // asks for changes, a continued call may update terms, but the deal stays
  // "changes_requested" until the rep sends it again.
  const contractStatus = deal.contract?.status;
  if (contractStatus && contractStatus !== "draft" && contractStatus !== "changes_requested") return { hasMissing: false };

  const extracted = await extractDealFromTranscript(transcript, placeholderKeys, deal.lastExtractedTranscript);
  const { fieldRows, service, fee } = buildDealFieldRows(extracted, placeholderKeys);

  // Compare-and-set, after the slow part: two passes over the same call can
  // overlap (a mid-call one still reading when the end-of-call one starts on
  // the whole transcript), and the one that finishes last must not write
  // older terms over newer ones. This pass writes when nothing was read
  // since it started, or when what was read since is the start of its own
  // transcript (a transcript only grows, so that pass was older; the same
  // words again, a retry, also write). A newer pass's longer transcript
  // wins. Never by length alone: "Record another call" reads a new
  // transcript that starts short, after a long one from the call.
  // One statement, so no other pass can slip in between the check and the
  // claim; everything after it is quick writes. The contract is checked
  // again in it too, by the rule above: the rep can send it while the call
  // is still on, and a reading that started before must not rewrite terms
  // an approver or the client already has.
  const claimed = await prisma.$executeRaw`UPDATE "Deal" SET "lastExtractedTranscript" = ${transcript} WHERE id = ${dealId} AND ("lastExtractedTranscript" IS NOT DISTINCT FROM ${deal.lastExtractedTranscript} OR starts_with(${transcript}, COALESCE("lastExtractedTranscript", ''))) AND NOT EXISTS (SELECT 1 FROM "Contract" WHERE "Contract"."dealId" = ${dealId} AND "Contract"."status" NOT IN ('draft', 'changes_requested'))`;
  if (claimed === 0) {
    const missing = await prisma.dealField.count({ where: { dealId, status: "missing" } });
    return { hasMissing: missing > 0 };
  }

  const existing = await prisma.dealField.findMany({ where: { dealId } });
  const existingByKey = new Map(existing.map((f) => [f.fieldKey, f]));
  const locked = (key: string) => {
    const current = existingByKey.get(key);
    return current?.status === "confirmed" || current?.status === "user_edited";
  };

  for (const row of fieldRows) {
    if (locked(row.fieldKey)) continue;
    // Nothing heard for a term that already has a value (the client the rep
    // named when they started recording, or what an earlier pass found):
    // keep it rather than blank it.
    if (!row.value && existingByKey.get(row.fieldKey)?.value) continue;

    // A real change — not "missing found a value" for the first time, that's
    // not a negotiation moving, just extraction catching up.
    const previousValue = existingByKey.get(row.fieldKey)?.value;
    if (previousValue && row.value && previousValue !== row.value) {
      await prisma.dealFieldChange.create({
        data: {
          dealId,
          fieldKey: row.fieldKey,
          oldValue: previousValue,
          newValue: row.value,
          changedBy: "extraction",
          callId,
          sourceQuote: row.sourceQuote,
        },
      });
    }

    await prisma.dealField.upsert({
      where: { dealId_fieldKey: { dealId, fieldKey: row.fieldKey } },
      create: {
        dealId,
        groupLabel: row.groupLabel,
        label: row.label,
        fieldKey: row.fieldKey,
        value: row.value,
        status: row.status,
        confidence: row.confidence,
        sourceQuote: row.sourceQuote,
        orderIndex: row.orderIndex,
      },
      update: {
        value: row.value,
        status: row.status,
        confidence: row.confidence,
        sourceQuote: row.sourceQuote,
      },
    });
  }

  const finalFields = await prisma.dealField.findMany({ where: { dealId } });
  const hasMissing = finalFields.some((f) => f.status === "missing");

  await prisma.deal.update({
    where: { id: dealId },
    data: {
      service: locked("service") ? deal.service : service || deal.service,
      feeDisplay: locked("fee") ? deal.feeDisplay : fee || deal.feeDisplay,
      status: contractStatus === "changes_requested" ? "changes_requested" : hasMissing ? "missing_info" : "ready",
      summary: extracted.summary ?? deal.summary,
      lastExtractedAt: new Date(),
      // Baseline for next pass's cache split — becomes the "stable" block
      // extractDealFromTranscript will look for verbatim next time.
      lastExtractedTranscript: transcript,
    },
  });

  // An email heard on the call only fills an empty one: the contract goes to
  // this address, and "cc our legal at ..." or a misheard address must never
  // replace the one the rep entered.
  const extractedEmail = extracted.email?.trim().toLowerCase();
  const email = !deal.client.email && extractedEmail && EMAIL_PATTERN.test(extractedEmail) ? extractedEmail : null;
  if (extracted.company || email) {
    await prisma.client.update({
      where: { id: deal.clientId },
      data: {
        ...(extracted.company ? { company: extracted.company } : {}),
        ...(email ? { email } : {}),
      },
    });
  }

  return { hasMissing };
}

// Deal.service/feeDisplay and Client.name are denormalized copies of the
// "service"/"fee"/"clientName" DealFields, kept in sync above whenever an
// extraction pass runs — but every other write path that edits a DealField
// by hand (the Deal Terms edit form, filling in a missing field, a voice
// correction) was updating DealField.value alone, silently leaving those
// copies stale. That's not just cosmetic: deal lists/boards, dashboard and
// analytics totals, the Client profile page, the HubSpot/Salesforce sync,
// and — most importantly — resolveReviewChain's minDealValue matching
// all read deal.feeDisplay directly rather than joining through
// DealField, so an edited fee could keep matching the chain picked for
// its original (lower) value. Call this after any such hand-edit so those
// copies never drift from the field that's actually shown as current.
export async function syncCoreDealFields(
  dealId: string,
  clientId: string,
  changed: { fieldKey: string; value: string }[]
): Promise<void> {
  const service = changed.find((c) => c.fieldKey === "service")?.value;
  const fee = changed.find((c) => c.fieldKey === "fee")?.value;
  const clientName = changed.find((c) => c.fieldKey === "clientName")?.value;

  if (service || fee) {
    await prisma.deal.update({
      where: { id: dealId },
      data: { ...(service ? { service } : {}), ...(fee ? { feeDisplay: fee } : {}) },
    });
  }
  if (clientName) {
    await prisma.client.update({ where: { id: clientId }, data: { name: clientName } });
  }
  const clientEmail = changed.find((c) => c.fieldKey === "clientEmail")?.value?.trim().toLowerCase();
  if (clientEmail && EMAIL_PATTERN.test(clientEmail)) {
    await prisma.client.update({ where: { id: clientId }, data: { email: clientEmail } });
  }
}
