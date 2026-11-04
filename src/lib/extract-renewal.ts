import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { fillClauses } from "@/lib/contract";
import { isValidTimeZone } from "@/lib/tasks";
import { dayInZone } from "@/lib/viewer-time";

// Runs once, right after a contract is signed — reads the final filled
// clause text (the exact legal language, not a raw template placeholder)
// and asks Claude to pull out when the term ends, whether it auto-renews,
// and a one-line human summary. Best-effort: a failure here should never
// affect signing itself, so callers wrap this in try/catch.
export async function extractRenewalTerms(contractId: string): Promise<void> {
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    include: { deal: { include: { fields: true, owner: { select: { timezone: true } } } }, template: true },
  });
  if (!contract || !contract.template || !contract.signedAt) return;

  const clauses = fillClauses(contract.template.clauses, contract.deal.fields);
  const contractText = clauses.map((c) => `${c.title}\n${c.body}`).join("\n\n");
  if (!contractText.trim()) return;

  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  // The day it was signed on the deal owner's clock, not the server's:
  // signed at 9:30 PM in New York is still that day there, though it's
  // already the next one in UTC. UTC when the owner's zone isn't known.
  const ownerZone = contract.deal.owner?.timezone;
  const signedDateIso = dayInZone(contract.signedAt, ownerZone && isValidTimeZone(ownerZone) ? ownerZone : "UTC");

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    system:
      "You read a signed contract's text and figure out when its current term ends and whether it renews " +
      "automatically. Only report a date if the contract actually states or implies one (a fixed term length " +
      "counts, e.g. \"continues for 3 months\" starting from the given signed date). Never invent one. " +
      `Today's reference date for resolving relative terms is the date the contract was signed: ${signedDateIso}.`,
    messages: [
      {
        role: "user",
        content: `Signed date: ${signedDateIso}\n\nContract text:\n\n${contractText}`,
      },
    ],
    tools: [
      {
        name: "record_renewal_terms",
        description: "Record when this contract's current term ends and its renewal behavior.",
        input_schema: {
          type: "object",
          properties: {
            renewalDate: {
              type: "string",
              description: "ISO date (YYYY-MM-DD) the current term ends or next renews on. Empty string if the contract doesn't state a term.",
            },
            autoRenews: { type: "boolean", description: "True if the contract renews automatically unless notice is given." },
            renewalNote: { type: "string", description: "One short plain-English sentence summarizing the renewal terms, e.g. \"Renews monthly unless 30 days' notice given.\" Empty string if there's no term." },
          },
          required: ["renewalDate", "autoRenews", "renewalNote"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_renewal_terms" },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return;

  const input = toolUse.input as { renewalDate: string; autoRenews: boolean; renewalNote: string };
  const renewalDate = input.renewalDate?.trim() ? new Date(input.renewalDate.trim()) : null;
  if (renewalDate && Number.isNaN(renewalDate.getTime())) return;

  await prisma.contract.update({
    where: { id: contractId },
    data: {
      renewalDate,
      autoRenews: Boolean(input.autoRenews) && Boolean(renewalDate),
      renewalNote: input.renewalNote?.trim() || null,
    },
  });
}
