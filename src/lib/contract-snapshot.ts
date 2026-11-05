import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { contractParty, fillClauses, type Clause } from "@/lib/contract";
import { contractExpired } from "@/lib/contract-status";

// The contract exactly as it went out: stored on Contract.snapshot at every
// send, so a later edit to the deal's terms or to the template can't change
// what the client saw or signed.
export type ContractSnapshot = { templateName: string; agencyName: string; clientName: string; clauses: Clause[] };

type DealTerms = {
  fields: { fieldKey: string; value: string | null }[];
  client: { name: string; company?: string | null };
  workspace: { name: string };
};

export type ContractTextSource = {
  id: string;
  status: string;
  deliveryMethod: string;
  expiresAt: Date | null;
  snapshot: unknown;
  template: { name: string; clauses: string } | null;
  deal: DealTerms;
};

// Statuses where the contract has reached the client. Its text is whatever
// it went out with, even once the link lapsed.
const SENT_STATUSES = new Set(["sent", "partially_signed", "signed", "expired"]);

export function buildContractSnapshot(template: { name: string; clauses: string }, deal: DealTerms): ContractSnapshot {
  return {
    templateName: template.name,
    agencyName: deal.workspace.name,
    clientName: contractParty(deal.fields, deal.client),
    clauses: fillClauses(template.clauses, deal.fields),
  };
}

// Reads the stored column back. Anything that isn't a whole snapshot counts
// as none, so a page falls back to the live text instead of showing half a
// contract.
export function parseContractSnapshot(value: unknown): ContractSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { templateName, agencyName, clientName, clauses } = value as Record<string, unknown>;
  if (typeof templateName !== "string" || typeof agencyName !== "string" || typeof clientName !== "string" || !Array.isArray(clauses)) return null;
  const valid = clauses.every((c) => !!c && typeof c === "object" && typeof c.title === "string" && typeof c.body === "string");
  if (!valid) return null;
  return { templateName, agencyName, clientName, clauses: (clauses as Clause[]).map((c) => ({ title: c.title, body: c.body })) };
}

// The team's contract page (and its PDF) previews what the next send would
// carry while the contract is still being worked on: a draft, in review,
// changes asked for, or a sign link that lapsed. Once it's out with the
// client, it shows what they got.
export function showsLiveTerms(contract: { status: string; deliveryMethod: string; expiresAt: Date | null }, now = new Date()): boolean {
  return contract.status === "draft" || contract.status === "pending_approval" || contract.status === "changes_requested" || contractExpired(contract, now);
}

export function liveContractText(contract: Pick<ContractTextSource, "template" | "deal">): ContractSnapshot | null {
  return contract.template ? buildContractSnapshot(contract.template, contract.deal) : null;
}

// Which text a contract shows, and whether it still needs freezing: the
// stored snapshot when there is one; else the live text, which a contract
// that went out before snapshots existed keeps from now on. Null when there's
// neither (its template was deleted before it was ever sent).
export function pickContractText(contract: ContractTextSource): { text: ContractSnapshot; freeze: boolean } | null {
  const stored = parseContractSnapshot(contract.snapshot);
  if (stored) return { text: stored, freeze: false };
  const live = liveContractText(contract);
  if (!live) return null;
  return { text: live, freeze: contract.snapshot == null && SENT_STATUSES.has(contract.status) };
}

// The text to show or use for a contract. `asTeam` is for the workspace's own
// pages, which preview the live terms while the contract is being reworked
// (see showsLiveTerms); everyone else sees what was sent.
export async function readContractText(contract: ContractTextSource, { asTeam = false }: { asTeam?: boolean } = {}): Promise<ContractSnapshot | null> {
  if (asTeam && showsLiveTerms(contract)) {
    const live = liveContractText(contract);
    if (live) return live;
  }
  const picked = pickContractText(contract);
  if (!picked?.freeze) return picked?.text ?? null;

  // Only fills an empty column, so a send or another reader that got there
  // first keeps theirs. A failed write still shows the page; the next read
  // freezes it.
  try {
    const frozen = await prisma.contract.updateMany({
      where: { id: contract.id, snapshot: { equals: Prisma.DbNull } },
      data: { snapshot: picked.text },
    });
    if (frozen.count > 0) return picked.text;
    const current = await prisma.contract.findUnique({ where: { id: contract.id }, select: { snapshot: true } });
    return parseContractSnapshot(current?.snapshot) ?? picked.text;
  } catch (err) {
    console.error(`Failed to freeze the text of contract ${contract.id}`, err);
    return picked.text;
  }
}
