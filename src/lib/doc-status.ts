// Where a proposal or contract is, in a word or two, for the badges on a
// lead's calls. A deal still being written or missing details comes first;
// after that it's the contract (the document that goes out) that says.
type DocDeal = {
  status: string;
  contract: { status: string; viewedAt: Date | null } | null;
};

export function docStatus(deal: DocDeal): { label: string; chip: string } {
  if (deal.status === "processing") return { label: "Being written", chip: "chip-neutral" };
  if (deal.status === "extraction_failed") return { label: "Couldn't read the call", chip: "chip-danger" };
  if (deal.status === "missing_info" && (!deal.contract || deal.contract.status === "draft")) return { label: "Needs details", chip: "chip-warn" };
  switch (deal.contract?.status ?? "draft") {
    case "pending_approval":
      return { label: "Waiting for approval", chip: "chip-warn" };
    case "changes_requested":
      return { label: "Changes requested", chip: "chip-warn" };
    case "sent":
      return deal.contract?.viewedAt ? { label: "Viewed", chip: "chip-active" } : { label: "Sent", chip: "chip-active" };
    case "partially_signed":
      return { label: "Partly signed", chip: "chip-active" };
    case "signed":
      return { label: "Signed", chip: "chip-success" };
    case "expired":
      return { label: "Expired", chip: "chip-danger" };
    case "not_signed":
      return { label: "Not signed", chip: "chip-danger" };
    default:
      return { label: "Draft", chip: "chip-neutral" };
  }
}
