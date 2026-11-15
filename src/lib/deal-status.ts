// Human labels and chip tones for Deal.status, in one place (a page.tsx
// file can't export extra named consts, Next.js's own route typechecking
// rejects it).
export const STATUS_LABEL: Record<string, string> = {
  processing: "Analyzing call…",
  missing_info: "Missing info",
  extraction_failed: "Couldn't process call",
  ready: "Ready for review",
  pending_approval: "Awaiting approval",
  changes_requested: "Changes requested",
  sent: "Sent - awaiting signature",
  signed: "Signed",
};

export const STATUS_CHIP: Record<string, string> = {
  processing: "chip-neutral chip-live",
  missing_info: "chip-warn",
  extraction_failed: "chip-warn",
  ready: "chip-active",
  pending_approval: "chip-neutral",
  changes_requested: "chip-warn",
  sent: "chip-neutral",
  signed: "chip-success",
};

// A proposal is only read, never signed, and its link never runs out, so
// it reads plainly: nothing about signatures or an expired sign link.
// Anything not listed reads as it does for a contract.
const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  missing_info: "Missing info",
  ready: "Ready to send",
  sent: "Sent",
};

// A sent deal whose SealMe sign link ran out (contractExpired in
// contract-status.ts) isn't waiting on the client anymore: the rep has to
// send it again, so it says that instead of "awaiting signature".
// kind is the deal's kind; only "proposal" changes anything.
// contractStatus is the contract's own status, where the caller has it: a
// contract the rep marked as not signed keeps its deal at "sent", so only
// the contract can tell it apart from one still out for signature.
export function dealStatusLabel(status: string, contractExpired = false, kind?: string | null, contractStatus?: string | null): string {
  if (kind === "proposal") return PROPOSAL_STATUS_LABEL[status] ?? STATUS_LABEL[status] ?? status;
  if (contractStatus === "not_signed") return "Not signed";
  if (status === "sent" && contractExpired) return "Sign link expired";
  return STATUS_LABEL[status] ?? status;
}

export function dealStatusChip(status: string, contractExpired = false, kind?: string | null, contractStatus?: string | null): string {
  if (kind === "proposal") return STATUS_CHIP[status] ?? "chip-neutral";
  if (contractStatus === "not_signed") return "chip-danger";
  if (status === "sent" && contractExpired) return "chip-warn";
  return STATUS_CHIP[status] ?? "chip-neutral";
}

// When "Mark as not signed" is offered: a contract that went out and isn't
// signed. That's one still out (a SealMe link past its date is still "sent"
// until the cron catches up), partly signed, expired, or sent back with
// changes asked for after it went out. A proposal is never signed, and one
// already marked has nothing left to mark.
export function canMarkNotSigned(contract: { status: string; sentAt?: Date | string | null } | null | undefined, kind?: string | null): boolean {
  if (!contract || kind === "proposal") return false;
  if (contract.status === "sent" || contract.status === "partially_signed" || contract.status === "expired") return true;
  return contract.status === "changes_requested" && contract.sentAt != null;
}
