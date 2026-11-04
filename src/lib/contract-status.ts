// Contract status rules shared by server code and client components
// (LiveDealView), so nothing here may import prisma.

type ContractTiming = { status: string; deliveryMethod?: string | null; expiresAt?: Date | string | null };

// Statuses where a reviewer or the client has the contract: its terms are
// what they approved or are signing.
const TERMS_LOCKED_STATUSES = new Set(["pending_approval", "sent", "partially_signed", "signed"]);

// A SealMe sign link stops taking signatures the moment expiresAt passes,
// while the daily cron (api/cron/remind) only marks the contract "expired"
// later, so a "sent" one past its date counts already. DocuSign runs its own
// expiry.
export function contractExpired(contract: ContractTiming | null | undefined, now = new Date()): boolean {
  if (!contract) return false;
  if (contract.status === "expired") return true;
  if (contract.status !== "sent" || contract.deliveryMethod !== "sealme" || contract.expiresAt == null) return false;
  return new Date(contract.expiresAt).getTime() <= now.getTime();
}

// Once a contract is with an approver or out for signature, nobody edits its
// terms by hand. An expired one can't be signed anymore, so the rep can change
// the terms and send it again. A bare status can't tell a lapsed "sent" link
// apart, so pass the contract where it's loaded.
export function contractLocksTerms(contract: ContractTiming | string | null | undefined, now = new Date()): boolean {
  if (!contract) return false;
  if (typeof contract === "string") return TERMS_LOCKED_STATUSES.has(contract);
  return TERMS_LOCKED_STATUSES.has(contract.status) && !contractExpired(contract, now);
}
