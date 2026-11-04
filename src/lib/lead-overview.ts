import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { recordAiUsage } from "@/lib/ai-usage";
import { reportError } from "@/lib/error-report";

// Same model as the call notes: it only condenses notes that already exist.
const MODEL = "claude-haiku-4-5";
// Enough history for where things stand; older calls are in the notes below it.
const CALLS_READ = 10;

const SYSTEM =
  "You keep the running record of a sales team's conversations with one prospect. " +
  "From the notes of each call, oldest first, write where things stand now: 3 to 6 short lines, each starting with \"- \". " +
  "Cover how the relationship has moved across the calls, what has been agreed, what is still open or unanswered, and the next step with who does what. " +
  "When a later call changed something from an earlier one, keep the latest. Only use what the notes say; never invent names, numbers or dates. " +
  "Write in English, in plain sentences without em dashes. Return only the lines.";

type OverviewCall = { startedAt: Date; summary: string | null; notes: string | null };

export function overviewPrompt(name: string, company: string | null, calls: OverviewCall[]): string {
  const blocks = calls.map((c, i) => {
    const day = c.startedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    return [`Call ${i + 1}, ${day}`, c.summary ? `Summary: ${c.summary}` : null, c.notes ? `Notes:\n${c.notes}` : null].filter(Boolean).join("\n");
  });
  return `Prospect: ${name}${company ? ` at ${company}` : ""}\n\n${blocks.join("\n\n")}`;
}

// The model's lines, cleaned up: "- " bullets only, no em dashes.
export function overviewLines(text: string): string | null {
  const lines = text
    .replace(/\\n/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-•*]\s+/.test(l))
    .map((l) => `- ${l.replace(/^[-•*]\s+/, "").replace(/\s*—\s*/g, ", ")}`)
    .slice(0, 8);
  return lines.length ? lines.join("\n") : null;
}

// Once a lead has two or more written-up calls, "where things stand"
// across all of them is rewritten from their notes. It's kept with the
// newest call (as extracted.overview), so the lead page reads it from there
// and a moved or merged call just means writing it again.
export async function refreshLeadOverview(leadId: string): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, company: true } });
    if (!lead) return;
    const calls = await prisma.phoneCall.findMany({
      where: { leadId, status: "processed", OR: [{ notes: { not: null } }, { summary: { not: null } }] },
      select: { id: true, startedAt: true, summary: true, notes: true, extracted: true },
      orderBy: { startedAt: "desc" },
      take: CALLS_READ,
    });
    if (calls.length < 2) return;

    // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
    // overloaded call can't run past the 300 s its request gets.
    const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: "user", content: overviewPrompt(lead.name, lead.company, [...calls].reverse()) }],
    });
    recordAiUsage(response);
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    const overview = overviewLines(text);
    if (!overview) return;

    const newest = calls[0];
    const extracted = newest.extracted && typeof newest.extracted === "object" && !Array.isArray(newest.extracted) ? newest.extracted : {};
    await prisma.phoneCall.update({
      where: { id: newest.id },
      data: { extracted: { ...extracted, overview, overviewCalls: calls.length } },
    });
  } catch (err) {
    // The call itself is saved either way; only the overview is missing.
    await reportError(err, "Lead overview", { leadId });
  }
}

// The overview the lead page shows: the newest call's, when it has one.
export function overviewFromCall(extracted: unknown): string | null {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted)) return null;
  const value = (extracted as Record<string, unknown>).overview;
  return typeof value === "string" && value.trim() ? value : null;
}
