import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { recordAiUsage } from "@/lib/ai-usage";
import type { Lead, Prisma } from "@/generated/prisma/client";

// Who a call turned out to be with, as the call heard it.
export type LeadProbe = {
  name: string | null;
  company: string | null;
  email: string | null; // lowercased
  phone: string | null; // E.164
};

type Candidate = Pick<Lead, "id" | "name" | "company" | "email" | "phone" | "lastContactedAt" | "updatedAt">;

// "Brightwater Coffee Roasters, Inc." and "brightwater coffee roasters" are
// the same company; so are "Acme" and "Acme Freight".
function companyKey(company: string): string {
  return company
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(inc|llc|ltd|limited|co|corp|corporation|company|gmbh|plc|sa|ag|doo|group)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sameCompany(a: string, b: string): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} `) || y.startsWith(`${x} `);
}

function nameWords(name: string): string[] {
  return name.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
}

// "Megan Ellis" is "megan ellis", and at the same company "Megan" on a
// later call is still her.
function sameName(a: string, b: string, sameFirm: boolean): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (!x.length || !y.length) return false;
  if (x.join(" ") === y.join(" ")) return true;
  return sameFirm && (x.length === 1 || y.length === 1) && x[0] === y[0];
}

// The lead on file a call belongs to, or null for a new one. Email or phone
// settle it; otherwise the name has to match, at the same company when the
// call named one. With several matches, the one worked most recently wins.
export function pickLeadMatch<T extends Candidate>(candidates: T[], probe: LeadProbe): T | null {
  const byRecent = [...candidates].sort(
    (a, b) => (b.lastContactedAt?.getTime() ?? 0) - (a.lastContactedAt?.getTime() ?? 0) || b.updatedAt.getTime() - a.updatedAt.getTime(),
  );
  if (probe.email) {
    const hit = byRecent.find((c) => c.email?.toLowerCase() === probe.email);
    if (hit) return hit;
  }
  if (probe.phone) {
    const hit = byRecent.find((c) => c.phone === probe.phone);
    if (hit) return hit;
  }
  if (!probe.name) return null;
  return (
    byRecent.find((c) => {
      if (probe.company && c.company) {
        const firm = sameCompany(probe.company, c.company);
        return firm && sameName(probe.name!, c.name, true);
      }
      // No company to go on: only a full name that matches exactly.
      return nameWords(probe.name!).length >= 2 && sameName(probe.name!, c.name, false);
    }) ?? null
  );
}

// Leads sharing the call's first name, for the model to look at when the
// details alone don't settle it ("Megan" on a follow-up that never says
// the company).
function looseCandidates<T extends Candidate>(candidates: T[], probe: LeadProbe): T[] {
  const first = probe.name ? nameWords(probe.name)[0] : null;
  if (!first) return [];
  return candidates.filter((c) => nameWords(c.name)[0] === first).slice(0, 5);
}

// A follow-up call often only says a first name. Haiku compares what was
// said with what's on file for each lead with that name (company, the last
// call) and says which one it was, if any.
async function confirmLeadMatch<T extends Candidate & { title: string | null; summary: string | null }>(call: string, options: T[]): Promise<T | null> {
  const list = options
    .map((o, i) => `${i + 1}. ${o.name}${o.title ? `, ${o.title}` : ""}${o.company ? ` at ${o.company}` : ""}. Last call: ${o.summary ?? "none on file"}`)
    .join("\n");
  // 120 s and one retry, not the SDK's 10 minutes and two: one slow or
  // overloaded call can't run past the 300 s its request gets.
  const response = await new Anthropic({ timeout: 120_000, maxRetries: 1 }).messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    system:
      "A sales team logged a call. Decide whether it was with one of the prospects already on file, by comparing who was on the call and what was discussed with what is on file. " +
      "Only pick one when the call clearly continues that prospect's conversation (same person, same company or the same deal). When unsure, pick none.",
    messages: [{ role: "user", content: `The call:\n${call.slice(0, 4000)}\n\nProspects on file:\n${list}` }],
    tools: [
      {
        name: "pick_prospect",
        description: "Say which prospect on file the call was with.",
        input_schema: {
          type: "object",
          properties: { prospect: { type: "integer", description: "The number of the prospect on file, or 0 for none of them." } },
          required: ["prospect"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "pick_prospect" },
  });
  recordAiUsage(response);
  const tool = response.content.find((b) => b.type === "tool_use");
  const n = tool && tool.type === "tool_use" ? Number((tool.input as { prospect?: unknown }).prospect) : 0;
  return Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : null;
}

// Looks the probe up among the leads this rep can see (all of them for a
// call logged without a rep), leaving out the call's own placeholder lead.
// `call` is what the call was about (its summary and notes), for when only
// a first name matches.
export async function findLeadForCall(args: {
  workspaceId: string;
  userId: string | null;
  excludeId: string;
  placeholderName: string;
  probe: LeadProbe;
  call: string;
}): Promise<Lead | null> {
  const { workspaceId, userId, excludeId, placeholderName, probe, call } = args;
  const first = probe.name ? nameWords(probe.name)[0] : null;
  const or: Prisma.LeadWhereInput[] = [];
  if (probe.email) or.push({ email: { equals: probe.email, mode: "insensitive" } });
  if (probe.phone) or.push({ phone: probe.phone });
  if (probe.name) or.push({ name: { equals: probe.name.trim(), mode: "insensitive" } });
  if (first) or.push({ name: { startsWith: first, mode: "insensitive" } });
  if (!or.length) return null;

  let visible: Prisma.LeadWhereInput = {};
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: { select: { canViewAllDeals: true } } } });
    if (!user?.role?.canViewAllDeals) visible = { OR: [{ ownerId: userId }, { tasks: { some: { assigneeId: userId } } }] };
  }
  const candidates = await prisma.lead.findMany({
    where: { workspaceId, id: { not: excludeId }, name: { not: placeholderName }, AND: [visible, { OR: or }] },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });
  const sure = pickLeadMatch(candidates, probe);
  if (sure) return sure;
  const loose = looseCandidates(candidates, probe);
  // A failed check only means a new lead, never a failed call.
  return loose.length && call.trim() ? confirmLeadMatch(call, loose).catch(() => null) : null;
}

// Two "a; b" lists as one, newest first, without repeats.
export function mergeList(newer: string | null, older: string | null): string | null {
  const items = [newer, older].flatMap((s) => (s ? s.split(";") : [])).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const out = items.filter((s) => {
    const key = s.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return out.length ? out.join("; ").slice(0, 2000) : null;
}
