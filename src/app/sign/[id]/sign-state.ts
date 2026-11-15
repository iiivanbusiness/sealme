import { contractExpired } from "@/lib/contract-status";

export type SignPageState = "open" | "signed" | "closed" | "docusign" | "expired" | "updating";

// kind is the deal's: a proposal is only read, never signed or commented on.
type SignableContract = { status: string; deliveryMethod: string; expiresAt: Date | null; kind?: string | null };

// What the client's sign page can offer right now. Only a contract that's
// out for signature through SealMe's own page, and not past its expiry,
// takes a signature. Anything else (a draft, internal approval, a change
// the client or a counter-signer asked for) is being worked on and comes
// back as a new send. One the rep marked not signed is closed, on either
// delivery: no new version is on its way, so the client is told to get in
// touch instead.
export function signPageState(contract: SignableContract, now = new Date()): SignPageState {
  if (contract.status === "signed" || contract.status === "partially_signed") return "signed";
  if (contract.status === "not_signed") return "closed";
  if (contract.deliveryMethod === "docusign") return "docusign";
  if (contractExpired(contract, now)) return "expired";
  return contract.status === "sent" ? "open" : "updating";
}

// What a counter-signer's page can offer. They sign while the contract is
// out for signature on SealMe's own pages, before the client has (sent) or
// after (partially_signed); the same states as the client's page explain
// everything else.
export function countersignPageState(contract: SignableContract, now = new Date()): SignPageState {
  if (contract.status === "signed") return "signed";
  if (contract.status === "not_signed") return "closed";
  if (contract.deliveryMethod === "docusign") return "docusign";
  if (contract.status === "partially_signed") return "open";
  return signPageState(contract, now);
}

// A client who just commented on one clause (changes_requested) can still
// comment on the others before the new version comes back. A proposal takes
// no comments: the client talks to the rep about it, and the rep sends a new
// version.
export function canCommentOnClauses(contract: SignableContract, now = new Date()): boolean {
  if (contract.kind === "proposal") return false;
  const state = signPageState(contract, now);
  return state === "open" || (state === "updating" && contract.status === "changes_requested");
}

// Shown on the page and returned by the actions, so both say the same thing.
export function signPageMessage(state: SignPageState, workspaceName: string): string | null {
  switch (state) {
    case "signed":
      return "This agreement is already signed.";
    case "closed":
      return `This agreement is no longer open for signing. Contact ${workspaceName}.`;
    case "docusign":
      return "This agreement is signed through DocuSign. Use the link in your DocuSign email.";
    case "expired":
      return `This sign link has expired. Ask ${workspaceName} to resend it.`;
    case "updating":
      return `This agreement is being updated. ${workspaceName} will send you the new version to sign.`;
    default:
      return null;
  }
}
