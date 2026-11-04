import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { recordAiUsage } from "@/lib/ai-usage";

// Runs once, right when a call finishes — pulls out commitments made on the
// call that AREN'T deal terms: "I'll send the proposal by Friday", "you
// need to sign off on the brief". Reads only this one call's own transcript
// (not the deal's running liveTranscript), so it's safe to call exactly
// once per call with no risk of the same commitment reappearing on a later
// pass. Best-effort: callers wrap this in try/catch.
export async function extractActionItems(callId: string): Promise<void> {
  const call = await prisma.call.findUnique({ where: { id: callId } });
  if (!call || !call.transcript.trim()) return;

  // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
  // overloaded call can't run past the 300 s its request gets.
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const referenceDate = (call.endedAt ?? call.startedAt).toISOString().slice(0, 10);

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system:
      "You read a raw call transcript between an agency (\"we\"/\"I\"/\"us\") and a client, and pull out concrete " +
      "commitments made during the call that are NOT the deal terms themselves (price, service, contract length). " +
      "things like \"I'll send the proposal by Friday\" or \"you need to approve the brief\". Only report an item " +
      "if someone actually committed to it on the call. Never invent one. Quote the exact transcript sentence for each. " +
      `Today's reference date for resolving relative deadlines ("by Friday", "next week") is ${referenceDate}, the day of this call.`,
    messages: [
      {
        role: "user",
        content: `Call transcript:\n\n${call.transcript}`,
      },
    ],
    tools: [
      {
        name: "record_action_items",
        description: "Record the action items / commitments found in this call transcript.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  description: { type: "string", description: "The commitment, written as a short task, e.g. 'Send the revised proposal'." },
                  ownerType: { type: "string", enum: ["team", "client"], description: "'team' if we/I committed to it, 'client' if the client needs to do it." },
                  dueDate: { type: "string", description: "ISO date (YYYY-MM-DD) if a deadline was mentioned or clearly implied. Empty string if none was mentioned." },
                  sourceQuote: { type: "string", description: "The exact transcript sentence this came from." },
                },
                required: ["description", "ownerType", "dueDate", "sourceQuote"],
              },
            },
          },
          required: ["items"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_action_items" },
  });
  recordAiUsage(response);

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return;

  const input = toolUse.input as {
    items: { description: string; ownerType: string; dueDate: string; sourceQuote: string }[];
  };

  const rows = input.items
    .map((item) => {
      const description = item.description?.trim();
      if (!description) return null;
      const dueDate = item.dueDate?.trim() ? new Date(item.dueDate.trim()) : null;
      return {
        dealId: call.dealId,
        callId: call.id,
        description,
        ownerType: item.ownerType === "client" ? "client" : "team",
        dueDate: dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null,
        sourceQuote: item.sourceQuote?.trim() || null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length > 0) {
    await prisma.actionItem.createMany({ data: rows });
  }
}
