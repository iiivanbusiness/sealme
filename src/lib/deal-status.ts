// The canonical Deal.status set + human labels/chip tones — was previously
// defined locally inside src/app/(app)/deals/page.tsx (a page.tsx file
// can't export extra named consts, Next.js's own route typechecking
// rejects it), and duplicated with a stale/incomplete 6-of-8 copy inside
// dashboard/page.tsx. One source of truth now, both pages import this.
export const BOARD_COLUMNS = ["processing", "missing_info", "extraction_failed", "ready", "pending_approval", "changes_requested", "sent", "signed"] as const;

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

// A sent deal whose SealMe sign link ran out (contractExpired in
// contract-status.ts) isn't waiting on the client anymore: the rep has to
// send it again, so it says that instead of "awaiting signature".
export function dealStatusLabel(status: string, contractExpired = false): string {
  if (status === "sent" && contractExpired) return "Sign link expired";
  return STATUS_LABEL[status] ?? status;
}

export function dealStatusChip(status: string, contractExpired = false): string {
  if (status === "sent" && contractExpired) return "chip-warn";
  return STATUS_CHIP[status] ?? "chip-neutral";
}
