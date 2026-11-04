import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { recordAiUsage } from "@/lib/ai-usage";

const VALID_TYPES = new Set(["discussion_point", "objection", "competitor_mention", "next_step"]);

// The richer counterpart to Deal.summary's 2-3 sentence recap (which this
// leaves untouched) — pulls out the shape of the conversation, not just the
// deal terms: what came up, what pushed back, who got mentioned as an
// alternative, what happens next. Runs once, right when a call finishes,
// same as extractActionItems — but takes a transcript directly rather than
// a callId, because the Recall.ai bot-call flow (src/app/api/recall/webhook/
// route.ts) never creates a Call row at all, so a callId-only signature
// would silently never fire for that flow (the same gap ActionItem has
// today). callId is passed through when the caller has one, purely to link
// the row for display — never required. Best-effort: callers wrap this in
// try/catch.
export async function extractCallHighlights(dealId: string, transcript: string, callId?: string): Promise<void> {
  if (!transcript.trim()) return;

  // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
  // overloaded call can't run past the 300 s its request gets.
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system:
      "You read a raw call transcript between an agency (\"we\"/\"I\"/\"us\") and a client, and pull out the shape " +
      "of the conversation. NOT the deal terms themselves (price, service, contract length are captured elsewhere). " +
      "Report only things actually said on the call, quoting the exact sentence for each. Never invent or infer. " +
      "Four kinds of item: discussion_point (something notable that came up. A requirement, a constraint, context " +
      "that matters), objection (pushback, hesitation, or a concern the client raised), competitor_mention (another " +
      "vendor or tool the client brought up, by name), next_step (something agreed to happen after this call that " +
      "isn't already a commitment with an owner/deadline. Those belong to action items, not here). Skip a category " +
      "entirely if nothing on the call fits it. Don't force an item into existence.",
    messages: [
      {
        role: "user",
        content: `Call transcript:\n\n${transcript}`,
      },
    ],
    tools: [
      {
        name: "record_call_highlights",
        description: "Record the discussion-shaped highlights found in this call transcript.",
        input_schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    enum: ["discussion_point", "objection", "competitor_mention", "next_step"],
                  },
                  body: { type: "string", description: "The point itself, written as a short standalone sentence." },
                  sourceQuote: { type: "string", description: "The exact transcript sentence this came from." },
                },
                required: ["type", "body", "sourceQuote"],
              },
            },
          },
          required: ["items"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_call_highlights" },
  });
  recordAiUsage(response);

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return;

  const input = toolUse.input as { items: { type: string; body: string; sourceQuote: string }[] };

  const rows = input.items
    .map((item) => {
      const body = item.body?.trim();
      if (!body || !VALID_TYPES.has(item.type)) return null;
      return {
        dealId,
        callId: callId ?? null,
        type: item.type,
        body,
        sourceQuote: item.sourceQuote?.trim() || null,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length > 0) {
    await prisma.callHighlight.createMany({ data: rows });
  }
}
