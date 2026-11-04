export type SignPageState = "open" | "signed" | "docusign" | "expired" | "updating";

type SignableContract = { status: string; deliveryMethod: string; expiresAt: Date | null };

// What the client's sign page can offer right now. Only a contract that's
// out for signature through SealMe's own page, and not past its expiry,
// takes a signature. Anything else (a draft, internal approval, a change
// the client or a counter-signer asked for) is being worked on and comes
// back as a new send.
export function signPageState(contract: SignableContract, now = new Date()): SignPageState {
  if (contract.status === "signed" || contract.status === "partially_signed") return "signed";
  if (contract.deliveryMethod === "docusign") return "docusign";
  if (contract.status === "expired" || (contract.status === "sent" && contract.expiresAt != null && contract.expiresAt <= now)) return "expired";
  return contract.status === "sent" ? "open" : "updating";
}

// What a counter-signer's page can offer. They sign while the contract is
// out for signature on SealMe's own pages, before the client has (sent) or
// after (partially_signed); the same states as the client's page explain
// everything else.
export function countersignPageState(contract: SignableContract, now = new Date()): SignPageState {
  if (contract.status === "signed") return "signed";
  if (contract.deliveryMethod === "docusign") return "docusign";
  if (contract.status === "partially_signed") return "open";
  return signPageState(contract, now);
}

// A client who just commented on one clause (changes_requested) can still
// comment on the others before the new version comes back.
export function canCommentOnClauses(contract: SignableContract, now = new Date()): boolean {
  const state = signPageState(contract, now);
  return state === "open" || (state === "updating" && contract.status === "changes_requested");
}

// Shown on the page and returned by the actions, so both say the same thing.
export function signPageMessage(state: SignPageState, workspaceName: string): string | null {
  switch (state) {
    case "signed":
      return "This agreement is already signed.";
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
