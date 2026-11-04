import Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage } from "@/lib/ai-usage";

export type CallKind = "cold" | "sales";

// Whether a call was prospecting (a cold call: qualify, book a meeting) or
// a sales call that settled terms a contract can be drafted from. Reps no
// longer pick this before calling; the call says. When it isn't clear,
// cold: that only writes notes, while sales drafts a deal and a contract.
export async function classifyCallKind(transcript: string): Promise<{ kind: CallKind; inputTokens: number; outputTokens: number }> {
  // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
  // overloaded call can't run past the 300 s its request gets.
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const message = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 5,
    system:
      "You sort sales phone calls. Reply with one word. " +
      "\"sales\" when the two sides agreed on what will be bought and its price or main terms, so a contract can be written now. " +
      "\"cold\" for everything else: first contact, qualifying, booking a meeting or demo, follow-ups, voicemail, no agreement.",
    messages: [{ role: "user", content: transcript.slice(0, 30_000) }],
  });
  recordAiUsage(message);
  const text = message.content.find((c) => c.type === "text")?.text.trim().toLowerCase() ?? "";
  return { kind: text.startsWith("sales") ? "sales" : "cold", inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
}
