import { extractPlaceholderKeys } from "@/lib/contract";

// Starter contract templates for a newly created workspace, so a new
// signup has something usable immediately instead of an empty Templates page.
export function buildDefaultTemplates(agencyName: string) {
  const genericClauses = JSON.stringify([
    { title: "Parties", body: `This Agreement is entered into between ${agencyName} ("Agency") and {clientName} ("Client").` },
    { title: "Scope of Services", body: "Agency will provide {service} for Client as described in this Agreement and any attached statement of work." },
    { title: "Fees & Payment", body: "Client will pay Agency {fee}. Invoices are due within fifteen (15) days of receipt unless otherwise agreed in writing." },
    { title: "Term", body: "This Agreement begins on {startDate} and continues until completed or terminated under the next section." },
    { title: "Termination", body: "Either party may terminate this agreement for convenience with 30 days' written notice, or immediately for uncured material breach." },
    { title: "Confidentiality", body: "Both parties agree to keep the terms of this agreement and any shared business information confidential." },
    { title: "Limitation of Liability", body: "Neither party's liability under this Agreement will exceed the total fees paid in the three months preceding a claim." },
    { title: "Governing Law", body: `This agreement is governed by the laws of the jurisdiction in which ${agencyName} is registered.` },
  ]);

  return [
    { name: "Consulting Agreement", description: "Advisory or strategy engagements, hourly or retainer.", requiredFieldCount: 6, clauses: genericClauses, kind: "contract" as const },
    { name: "Freelance Agreement", description: "Simple one-off or short-term freelance work.", requiredFieldCount: 5, clauses: genericClauses, kind: "contract" as const },
    { name: "Service Agreement", description: "General-purpose agreement for ongoing client work.", requiredFieldCount: 6, clauses: genericClauses, kind: "contract" as const },
  ];
}

// A workspace's first proposal template: what the client reads before the
// agreement. It uses only the standard field keys, so a contract made from
// a proposal on it carries the same terms over. No signature section: a
// proposal isn't signed in SealMe.
export function buildSampleProposalTemplate(agencyName: string) {
  // Braces in a workspace name would read as a field.
  const agency = agencyName.replace(/[{}]/g, "").trim() || "We";
  const clauses = JSON.stringify([
    { title: "Overview", body: `${agency} prepared this proposal for {clientName}. It sets out the work we discussed, what you get, the investment and the timeline.` },
    { title: "Scope", body: "We will provide {service}." },
    { title: "Deliverables", body: "You will receive {deliverables}." },
    { title: "Investment", body: "The investment is {fee}. Payment terms: {paymentTerms}." },
    { title: "Timeline", body: "Work starts on {startDate} and runs for {duration}." },
    { title: "Next steps", body: `Once you're happy with this proposal, ${agency} will send you the agreement to sign. If you'd like to change anything first, just let us know.` },
  ]);

  return {
    name: "Proposal",
    description: "Scope, deliverables, price and timeline, for the client to read before the agreement.",
    clauses,
    requiredFieldCount: extractPlaceholderKeys(clauses).length,
    kind: "proposal" as const,
  };
}
