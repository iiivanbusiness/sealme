import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";

export function isFishAudioConfigured(): boolean {
  return Boolean(process.env.FISH_AUDIO_API_KEY);
}

// A short, natural-sounding spoken recap of what a call produced — read
// aloud right when the rep stops a locally-recorded call, so they hear a
// human-style confirmation instead of having to read the deal page. Reuses
// the same summary/fields the live extraction already produced; this is
// just a second, small pass that turns them into something meant to be
// heard rather than read. Deliberately terse (a hard word cap, not just an
// instruction) — the call summary itself is NOT meant to be read aloud,
// only used as context, since testing showed the model would otherwise
// just recite it end to end instead of producing a short spoken update.
// If anything is still missing, names it and asks what to put there — the
// rep can answer that directly via the push-to-talk button, which now
// accepts corrections for missing fields too (see interpretVoiceCorrection).
// Returns null when there's nothing worth reading back yet (call ended
// before anything was captured) — the caller treats that as "skip it".
export async function generateCallRecapScript(dealId: string): Promise<string | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { fields: true },
  });
  if (!deal) return null;

  const filled = deal.fields.filter((f) => f.value && f.status !== "missing");
  const missing = deal.fields.filter((f) => f.status === "missing");
  if (filled.length === 0 && missing.length === 0 && !deal.summary) return null;

  const filledLines = filled.map((f) => f.label).join(", ") || "(none)";
  const missingLines = missing.map((f) => f.label).join(", ") || "(none)";

  // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
  // overloaded call can't run past the 300 s its request gets.
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 120,
    system:
      "You just finished listening in on a sales call and filled in what you could of a contract. Write a " +
      "SHORT spoken update for the rep. At most 2 sentences, under 35 words total, no exceptions. Do NOT " +
      "restate or summarize the call summary below. It's context only, never read it back. Just briefly name " +
      "what got filled in (e.g. \"Filled in the contract for Northgate Fitness. Fee, dates, and deliverables are set.\"). " +
      "If anything is listed as missing, name it specifically and ask what to put there (e.g. \"I didn't catch " +
      "payment terms. What should I put?\"). If nothing is missing, invite them to fix anything that's off. " +
      "Always respond in English regardless of what language the call was in. Output only the spoken text " +
      "itself. No headers, no bullet points, no quotation marks.",
    messages: [
      {
        role: "user",
        content: `Call summary (context only, do not read aloud): ${deal.summary ?? "(none)"}\n\nFilled in: ${filledLines}\n\nStill missing: ${missingLines}`,
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text.trim() : null;
}

// Fish Audio's TTS endpoint — see docs.fish.audio. FISH_AUDIO_MODEL defaults
// to their free, unlimited-under-fair-use S2.1 Pro model; FISH_AUDIO_VOICE_ID
// is optional (a specific voice's reference_id from the Fish Audio voice
// library — omit it to get their default voice).
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const apiKey = process.env.FISH_AUDIO_API_KEY;
  if (!apiKey) throw new Error("FISH_AUDIO_API_KEY isn't set");

  const res = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      model: process.env.FISH_AUDIO_MODEL || "s2.1-pro-free",
    },
    body: JSON.stringify({
      text,
      format: "mp3",
      ...(process.env.FISH_AUDIO_VOICE_ID ? { reference_id: process.env.FISH_AUDIO_VOICE_ID } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Fish Audio TTS failed: ${res.status} ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}
