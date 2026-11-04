import Anthropic from "@anthropic-ai/sdk";
import { CALL_OUTCOMES, type CallOutcome } from "@/lib/call-outcomes";
import { recordAiUsage } from "@/lib/ai-usage";

// Cold calls go to Haiku: they're short and only fill a handful of CRM
// fields, so the cheapest model does the job (sales calls with contract
// terms stay on extractDealFromTranscript).
const MODEL = "claude-haiku-4-5";
// Per million tokens, for the cost shown after each call.
export const INPUT_USD_PER_MTOK = 1;
export const OUTPUT_USD_PER_MTOK = 5;

export type ColdCallResult = {
  outcome: CallOutcome;
  connected: boolean;
  summary: string;
  notes: string | null; // the write-up, one "- " line per point
  contactName: string | null;
  title: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  isDecisionMaker: boolean | null;
  interest: "cold" | "warm" | "hot" | null;
  painPoints: string | null;
  objections: string | null;
  nextStep: string | null;
  nextStepDate: string | null; // YYYY-MM-DD
  nextStepTime: string | null; // HH:mm
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  raw: Record<string, unknown>;
};

type LeadContext = {
  name: string;
  title: string | null;
  company: string | null;
  painPoints: string | null;
  objections: string | null;
  nextStep: string | null;
};

const SYSTEM =
  "You read the transcript of a sales rep's call with a prospect (usually a cold call, sometimes a first meeting) and record what a CRM needs. " +
  "Only record what the transcript actually says; never invent names, numbers or dates. " +
  "If nobody picked up, or it went to voicemail, say so and leave the prospect fields empty. " +
  "Pain points and objections: merge what's already on file with anything new from this call into one short list each, newest first, separated by semicolons. " +
  "Next step dates: resolve relative days (\"next Tuesday\", \"tomorrow\") using the calendar given below. " +
  "Outcome: meeting_booked only when a specific next meeting or demo was put on the calendar on this call, with its day agreed. " +
  "A pilot or trial, ongoing check-ins, sending a contract or proposal, or \"let's talk again\" without a set day is not a booked meeting; when unsure, pick interested. " +
  "Write everything in English, in plain sentences without em dashes.";

export async function extractColdCall(transcript: string, lead: LeadContext, today: string): Promise<ColdCallResult> {
  // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
  // overloaded call can't run past the 300 s its request gets.
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  // Small models slip on weekday arithmetic ("next Tuesday" landed on a
  // Wednesday), so the next two weeks are spelled out day by day.
  const start = new Date(`${today}T00:00:00Z`);
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    return `${d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })} ${d.toISOString().slice(0, 10)}`;
  });
  const context = [
    `Today is ${days[0]}.`,
    `The days after it: ${days.slice(1).join(", ")}. "Next <weekday>" means the first such day after today.`,
    `Prospect on file: ${lead.name}${lead.title ? `, ${lead.title}` : ""}${lead.company ? ` at ${lead.company}` : ""}`,
    `Pain points already on file: ${lead.painPoints || "none"}`,
    `Objections already on file: ${lead.objections || "none"}`,
    `Next step already on file: ${lead.nextStep || "none"}`,
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2500,
    system: SYSTEM,
    messages: [{ role: "user", content: `${context}\n\nTranscript:\n${transcript}` }],
    tools: [
      {
        name: "record_cold_call",
        description: "Record the outcome of the cold call and the prospect details it revealed.",
        input_schema: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: [...CALL_OUTCOMES],
              description:
                "meeting_booked: a specific next meeting or demo was scheduled on this call, with its day agreed. interested: they want to move forward or hear more (a pilot, a trial, a proposal or contract to send, check-ins to set up) but no meeting with a set day was booked. follow_up: they asked to be contacted later. not_interested: they declined. wrong_person: not the right contact. voicemail: went to voicemail. no_answer: nobody picked up.",
            },
            summary: { type: "string", description: "2-3 neutral sentences on what happened on the call, for the rep's teammates." },
            notes: {
              type: "string",
              description:
                "The write-up of the call a team would keep or send on to a client: 4 to 10 short lines, each starting with \"- \", covering who they are, what was discussed, what they need, numbers and dates that came up, decisions, and next steps with who does what. Empty if nobody picked up or it went to voicemail.",
            },
            contactName: { type: "string", description: "The prospect's full name if said on the call, else empty." },
            title: { type: "string", description: "Their job title if said, else empty." },
            company: { type: "string", description: "Their company if said, else empty." },
            email: { type: "string", description: "An email address they gave, else empty." },
            phone: { type: "string", description: "A phone number they gave, else empty." },
            isDecisionMaker: { type: "string", enum: ["yes", "no", "unknown"], description: "Whether they make the buying decision." },
            interest: { type: "string", enum: ["cold", "warm", "hot", "unknown"], description: "How interested they sounded." },
            painPoints: { type: "string", description: "Merged list of the problems they described, separated by semicolons. Empty if none known." },
            objections: {
              type: "string",
              description:
                "Merged list of every reason they gave for not buying, hesitating or saying no (e.g. 'Already on a 3-year contract with a competitor', 'No budget this year', 'Legal must approve templates'), separated by semicolons. Empty only if they raised none.",
            },
            nextStep: { type: "string", description: "The agreed next step in a few words, e.g. 'Demo with their VP Sales'. Empty if none." },
            nextStepDate: { type: "string", description: "Date of the next step as YYYY-MM-DD, empty if none was agreed." },
            nextStepTime: { type: "string", description: "Time of the next step as 24-hour HH:MM if one was agreed, else empty." },
          },
          // Notes are the point for a team that only wants the write-up, so the
          // model can't skip them (they come back empty for a voicemail).
          required: ["outcome", "summary", "notes", "isDecisionMaker", "interest"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_cold_call" },
  });
  recordAiUsage(response);

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") throw new Error("Claude didn't return the call details");
  const input = toolUse.input as Record<string, string | undefined>;
  // Em dashes read as machine-written in the CRM, so any that slip through
  // become commas.
  const text = (v: string | undefined) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s*\u2014\s*/g, ", ") : null);

  const outcome = (CALL_OUTCOMES as readonly string[]).includes(input.outcome ?? "") ? (input.outcome as CallOutcome) : "follow_up";
  const date = text(input.nextStepDate);
  const time = text(input.nextStepTime);
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    outcome,
    connected: outcome !== "voicemail" && outcome !== "no_answer",
    summary: text(input.summary) ?? "",
    // The model sometimes writes the line breaks out as "\n".
    notes: text(input.notes)?.replace(/\\n/g, "\n") ?? null,
    contactName: text(input.contactName),
    title: text(input.title),
    company: text(input.company),
    email: text(input.email),
    phone: text(input.phone),
    isDecisionMaker: input.isDecisionMaker === "yes" ? true : input.isDecisionMaker === "no" ? false : null,
    interest: input.interest === "cold" || input.interest === "warm" || input.interest === "hot" ? input.interest : null,
    painPoints: text(input.painPoints),
    objections: text(input.objections),
    nextStep: text(input.nextStep),
    nextStepDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    nextStepTime: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
    usage: { inputTokens, outputTokens, costUsd: (inputTokens * INPUT_USD_PER_MTOK + outputTokens * OUTPUT_USD_PER_MTOK) / 1_000_000 },
    raw: input,
  };
}
