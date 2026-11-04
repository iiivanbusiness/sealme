import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { appNavigationText, faqKnowledgeText } from "@/lib/faq-content";

// Freeform AI support chat — deliberately separate from the FAQ chat's
// canned answers. Auth-gated to keep this off the open internet, and
// per-workspace limited because every message is a real Anthropic cost
// billed to SealMe's own account, not the workspace's (see
// aiChatMessagesLimit on Workspace). The model itself never sees anything
// account-specific — only product knowledge (faqKnowledgeText) and the
// caller's own chat history, nothing about their deals, clients, or
// contracts. Manual session/workspace lookup here instead of
// requireWorkspace(), which redirects on failure — fine in a page, not in a
// JSON API route (same pattern as companion/state/route.ts).
const MAX_HISTORY_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 2000;

type ChatMessage = { role: "user" | "assistant"; content: string };

function isValidHistory(value: unknown): value is ChatMessage[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_HISTORY_MESSAGES &&
    value.every(
      (m) =>
        m &&
        typeof m === "object" &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim().length > 0 &&
        m.content.length <= MAX_MESSAGE_LENGTH
    )
  );
}

export async function POST(req: Request) {
  const session = await auth();
  const workspaceId = session?.user?.workspaceId;
  if (!workspaceId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const messages = body?.messages;
  if (!isValidHistory(messages)) {
    return NextResponse.json({ error: "Invalid message history" }, { status: 400 });
  }
  if (messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "Last message must be from the user" }, { status: 400 });
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { aiChatMessagesUsedThisMonth: true, aiChatMessagesLimit: true, prospectingEnabled: true },
  });
  if (!workspace) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (workspace.aiChatMessagesUsedThisMonth >= workspace.aiChatMessagesLimit) {
    return NextResponse.json(
      { error: "This workspace has used this month's AI chat messages. They reset on the 1st. For help now, email ivan@sealme.net." },
      { status: 429 }
    );
  }

  const client = new Anthropic({ timeout: 120_000, maxRetries: 1 });

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 500,
      system:
        "You are SealMe's support assistant, answering questions in a chat widget inside the app. " +
        "SealMe helps sales teams record calls, draft contracts from them with AI, route them for approval, " +
        "get them signed, and sync closed deals to Salesforce or HubSpot." +
        (workspace.prospectingEnabled ? " This workspace also uses Leads: lead lists, tasks for reps, and phone calls through SealMe that write themselves up." : "") +
        "\n\n" +
        "You do not have access to this user's account, deals, contracts, or any other personal data. Never " +
        "claim to look anything up, and never ask for account details. Answer only from the product facts below. " +
        "If a question needs account-specific info, or the facts below don't cover it, say you don't have that " +
        "detail and suggest contacting support instead of guessing.\n\n" +
        "Keep answers short, two to four sentences, plain language, no markdown headers. " +
        "Never use em dashes or other long dashes, write plain sentences with commas or periods instead. " +
        "For navigation questions (where something is, how to get to a setting), give the exact page and section " +
        "from the navigation facts below, don't hedge with 'usually' or 'typically' when you already know the answer.\n\n" +
        "Navigation facts:\n" +
        appNavigationText(workspace.prospectingEnabled) +
        "\n\nProduct facts:\n" +
        faqKnowledgeText(workspace.prospectingEnabled),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const text = response.content.find((block) => block.type === "text")?.text ?? "";

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { aiChatMessagesUsedThisMonth: { increment: 1 } },
    });

    return NextResponse.json({ reply: text });
  } catch (err) {
    console.error("Support chat request failed", err);
    return NextResponse.json({ error: "Something went wrong answering that" }, { status: 502 });
  }
}
