import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";

export type ProposedCorrection =
  | {
      intent: "update_field";
      fieldKey: string;
      fieldLabel: string;
      currentValue: string | null;
      proposedValue: string;
      confirmationText: string;
    }
  | {
      intent: "send_for_review";
      recipientUserId: string;
      recipientName: string;
      confirmationText: string;
    }
  | { intent: "unclear"; confirmationText: string };

// Turns one push-to-talk clip's transcript into a single proposed action —
// either a field change or sending the deal to a named teammate for
// review — and never applies it. The rep hears confirmationText read back
// and has to explicitly confirm (applyVoiceFieldCorrection or
// sendForReviewTo in deals/[id]/review-actions.ts, both only called from a
// tap on "Yes, apply") before anything is written or sent; a misheard word
// this way surfaces as a wrong-sounding confirmation instead of a silently
// wrong contract or an email to the wrong person.
export async function interpretVoiceCorrection(
  dealId: string,
  transcript: string,
  currentUserId?: string
): Promise<ProposedCorrection | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { fields: true, workspace: { include: { users: true } } },
  });
  if (!deal) return null;

  // Every field is fair game via voice — not just already-filled ones. The
  // recap explicitly asks about missing fields by name, so the rep's reply
  // has to be able to fill those in, not just correct existing values.
  const editableFields = deal.fields;
  const teammates = deal.workspace.users.filter((u) => u.id !== currentUserId);
  if (editableFields.length === 0 && teammates.length === 0) return null;

  const fieldList =
    editableFields.map((f) => `${f.fieldKey} (${f.label}): currently ${f.status === "missing" ? "MISSING. Not captured yet" : `"${f.value}"`}`).join("\n") ||
    "(none)";
  const teammateList = teammates.map((u) => `${u.id}: ${u.name}`).join("\n") || "(none)";

  const tools: Anthropic.Tool[] = [
    {
      name: "unclear",
      description: "Use this when what the rep said can't be confidently matched to a field change or a teammate to send to.",
      input_schema: {
        type: "object",
        properties: {
          confirmationText: {
            type: "string",
            description: "A short spoken line (in English) saying you didn't catch a clear instruction, asking them to try again.",
          },
        },
        required: ["confirmationText"],
      },
    },
  ];
  if (editableFields.length > 0) {
    tools.push({
      name: "propose_field_change",
      description: "Propose a single field's value. Either correcting an already-filled field or filling one currently marked MISSING.",
      input_schema: {
        type: "object",
        properties: {
          fieldKey: { type: "string", enum: editableFields.map((f) => f.fieldKey) },
          proposedValue: { type: "string", description: "The new value, formatted naturally the way it should appear in the contract." },
          confirmationText: {
            type: "string",
            description: "A short spoken question (in English) reading back the proposed value. Say \"setting\" for a field that was missing, \"changing\" for one that already had a value.",
          },
        },
        required: ["fieldKey", "proposedValue", "confirmationText"],
      },
    });
  }
  if (teammates.length > 0) {
    tools.push({
      name: "send_for_review",
      description: "The rep asked to send this deal to a named teammate for review. Propose who, matched from the listed teammates only.",
      input_schema: {
        type: "object",
        properties: {
          recipientUserId: { type: "string", enum: teammates.map((u) => u.id) },
          confirmationText: { type: "string", description: "A short spoken question (in English) confirming who it'll be sent to, e.g. \"Send this to Marko for review. Confirm?\"" },
        },
        required: ["recipientUserId", "confirmationText"],
      },
    });
  }

  // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
  // overloaded call can't run past the 300 s its request gets.
  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });
  const response = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 300,
    system:
      "The rep just spoke a voice command about a contract, right after hearing a spoken recap of what a call " +
      "produced. It's one of two things: (1) a correction to a field's value. Match loosely (they might say " +
      "\"price\" for a field labeled \"Fee\", or speak a different language than the fields are recorded in), " +
      "or (2) a request to send the deal to a specific named teammate for review. Match the name loosely " +
      "(nicknames, mispronunciations) against the listed teammates only, never invent a person who isn't " +
      "listed. If it's neither, or the match isn't confident, use `unclear` instead of guessing. Always write " +
      "confirmationText in English regardless of what language the rep spoke.",
    messages: [
      {
        role: "user",
        content: `Current contract fields:\n${fieldList}\n\nTeammates who can be sent this for review:\n${teammateList}\n\nWhat the rep just said: "${transcript}"`,
      },
    ],
    tools,
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") return null;

  if (toolUse.name === "unclear") {
    const input = toolUse.input as { confirmationText: string };
    return { intent: "unclear", confirmationText: input.confirmationText };
  }

  if (toolUse.name === "send_for_review") {
    const input = toolUse.input as { recipientUserId: string; confirmationText: string };
    const teammate = teammates.find((u) => u.id === input.recipientUserId);
    if (!teammate) return null;
    return { intent: "send_for_review", recipientUserId: teammate.id, recipientName: teammate.name, confirmationText: input.confirmationText };
  }

  const input = toolUse.input as { fieldKey: string; proposedValue: string; confirmationText: string };
  const field = editableFields.find((f) => f.fieldKey === input.fieldKey);
  if (!field) return null;

  return {
    intent: "update_field",
    fieldKey: field.fieldKey,
    fieldLabel: field.label,
    currentValue: field.value,
    proposedValue: input.proposedValue,
    confirmationText: input.confirmationText,
  };
}
