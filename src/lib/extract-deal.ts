import Anthropic from "@anthropic-ai/sdk";
import { recordAiUsage } from "@/lib/ai-usage";

export function isExtractionConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const FIELD_META: Record<string, { label: string; groupLabel: string }> = {
  clientName: { label: "Client", groupLabel: "Client & engagement" },
  // Not a contract placeholder: a deal made from a phone call needs it to
  // send the contract, so it's asked for when the call didn't give one.
  clientEmail: { label: "Client email", groupLabel: "Client & engagement" },
  service: { label: "Service", groupLabel: "Client & engagement" },
  startDate: { label: "Start date", groupLabel: "Client & engagement" },
  duration: { label: "Duration", groupLabel: "Client & engagement" },
  deliverables: { label: "Deliverables", groupLabel: "Scope" },
  platforms: { label: "Platforms", groupLabel: "Scope" },
  fee: { label: "Fee", groupLabel: "Commercial terms" },
  paymentTerms: { label: "Payment terms", groupLabel: "Commercial terms" },
  cancellation: { label: "Cancellation terms", groupLabel: "Commercial terms" },
  billingAddress: { label: "Billing address", groupLabel: "Commercial terms" },
};

// A template's own placeholder ({billingCycle}) reads as "Billing cycle".
function humanize(fieldKey: string): string {
  const words = fieldKey.replace(/[_-]+/g, " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : fieldKey;
}

export function fieldMeta(fieldKey: string): { label: string; groupLabel: string } {
  return FIELD_META[fieldKey] ?? { label: humanize(fieldKey), groupLabel: "Deal details" };
}

export type ExtractedField = {
  fieldKey: string;
  value: string | null;
  sourceQuote: string | null;
  confidence: number;
};

export type ExtractedDeal = {
  clientName: string;
  company: string | null;
  email: string | null;
  summary: string | null;
  fields: ExtractedField[];
};

// previousTranscript, when given, should be exactly what liveTranscript was
// on the last extraction pass for this deal (Deal.lastExtractedTranscript).
// Live calls re-run this on the whole transcript-so-far roughly once a
// minute — caching only helps if the cached block's bytes are identical to
// last time, so the transcript is split into a stable block (whatever
// hasn't changed since the last pass, cached) and a plain block for
// whatever's new. Anthropic's caching is a straight prefix match on a
// block's own content — appending to a single growing block invalidates the
// whole thing, so the split has to be structural, not just a cache_control
// flag on one ever-growing string.
export async function extractDealFromTranscript(
  transcript: string,
  placeholderKeys: string[],
  previousTranscript?: string | null
): Promise<ExtractedDeal> {
  const client = new Anthropic();

  const fieldKeys = [...new Set(["service", "fee", ...placeholderKeys])];

  const hasValidPrefix = Boolean(previousTranscript) && transcript.startsWith(previousTranscript as string);
  const stablePart = hasValidPrefix ? (previousTranscript as string) : transcript;
  const newPart = hasValidPrefix ? transcript.slice((previousTranscript as string).length) : "";

  const content: Array<{ type: "text"; text: string; cache_control?: { type: "ephemeral" } }> = [
    {
      type: "text",
      text: `Extract the deal terms from this call transcript:\n\n${stablePart}`,
      cache_control: { type: "ephemeral" },
    },
  ];
  if (newPart) {
    content.push({ type: "text", text: newPart });
  }

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4096,
    system:
      "You extract structured sales-deal terms from a raw call transcript between an agency and a prospective client. " +
      "Only report a field if the transcript actually states it. Never invent numbers, dates, or names. " +
      "For every extracted field, quote the exact transcript sentence it came from. " +
      "The fields fill a contract, so: the clientName field is the party the contract is with, the client's company or organization when one is named, " +
      "otherwise the person's full name (the top-level clientName stays the person you spoke with). " +
      "The service field finishes the sentence \"Agency will provide ...\", so write it as a phrase that starts lowercase unless it begins with a name or acronym, " +
      "for example \"a twelve-week sales enablement program for 8 SDRs\".",
    messages: [
      {
        role: "user",
        content,
      },
    ],
    tools: [
      {
        name: "record_deal_terms",
        description: "Record the deal terms found in the call transcript.",
        input_schema: {
          type: "object",
          properties: {
            clientName: { type: "string", description: "The client contact's full name" },
            company: { type: "string", description: "The client's company name, if mentioned" },
            email: { type: "string", description: "The client's email address, if mentioned" },
            summary: { type: "string", description: "A neutral 2-3 sentence summary of what was discussed on the call. The context, what the client needs, and any notable concerns raised. Not a restatement of the extracted fields." },
            fields: {
              type: "array",
              description: "One entry per requested field key, in the same order given.",
              items: {
                type: "object",
                properties: {
                  fieldKey: { type: "string", enum: fieldKeys },
                  value: { type: "string", description: "The extracted value, formatted naturally (e.g. fee as '€2,500 / month'). Empty string if not mentioned." },
                  sourceQuote: { type: "string", description: "The exact transcript sentence supporting this value. Empty string if not mentioned." },
                  confidence: { type: "number", description: "0 to 1. How directly the transcript states this value." },
                },
                required: ["fieldKey", "value", "sourceQuote", "confidence"],
              },
            },
          },
          required: ["clientName", "fields"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "record_deal_terms" },
  });
  recordAiUsage(response);

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Claude didn't return structured deal terms");
  }

  const input = toolUse.input as {
    clientName: string;
    company?: string;
    email?: string;
    summary?: string;
    fields: { fieldKey: string; value: string; sourceQuote: string; confidence: number }[];
  };

  return {
    clientName: input.clientName,
    company: input.company?.trim() || null,
    email: input.email?.trim() || null,
    summary: input.summary?.trim() || null,
    fields: input.fields.map((f) => ({
      fieldKey: f.fieldKey,
      value: f.value?.trim() || null,
      sourceQuote: f.sourceQuote?.trim() || null,
      confidence: f.confidence,
    })),
  };
}

export type DealFieldRow = {
  groupLabel: string;
  label: string;
  fieldKey: string;
  value: string | null;
  status: string;
  confidence: number | null;
  sourceQuote: string | null;
  orderIndex: number;
};

export function buildDealFieldRows(
  extracted: ExtractedDeal,
  placeholderKeys: string[]
): { fieldRows: DealFieldRow[]; hasMissing: boolean; service: string; fee: string } {
  const byKey = new Map(extracted.fields.map((f) => [f.fieldKey, f]));

  const fieldRows: DealFieldRow[] = placeholderKeys.map((fieldKey, i) => {
    const meta = fieldMeta(fieldKey);
    const extractedField = byKey.get(fieldKey);
    return {
      groupLabel: meta.groupLabel,
      label: meta.label,
      fieldKey,
      value: extractedField?.value ?? null,
      status: extractedField?.value ? "extracted" : "missing",
      confidence: extractedField?.confidence ?? null,
      sourceQuote: extractedField?.sourceQuote ?? null,
      orderIndex: i,
    };
  });
  if (!fieldRows.some((f) => f.fieldKey === "clientName")) {
    fieldRows.unshift({
      groupLabel: "Client & engagement",
      label: "Client",
      fieldKey: "clientName",
      value: extracted.clientName,
      status: "extracted",
      confidence: 1,
      sourceQuote: null,
      orderIndex: -1,
    });
  }

  return {
    fieldRows,
    hasMissing: fieldRows.some((f) => f.status === "missing"),
    service: byKey.get("service")?.value ?? "",
    fee: byKey.get("fee")?.value ?? "",
  };
}
