// Where a client opens what they were sent. A contract is signed at its sign
// page; a proposal is only read, at its own page, which records the first
// time the client opens it ("Viewed"). Both take the Contract row's id.

export function signPath(contractId: string): string {
  return `/sign/${contractId}`;
}

export function proposalPath(contractId: string): string {
  return `/proposal/${contractId}`;
}

// The link that goes to the client: the sign page for a contract, the
// proposal page for a proposal. Works on the server and in the browser
// (NEXT_PUBLIC_APP_URL is inlined at build time; the browser falls back to
// the page's own origin when it isn't set, e.g. on a preview deploy).
export function clientDocumentUrl(contractId: string, kind: string | null | undefined): string {
  const path = kind === "proposal" ? proposalPath(contractId) : signPath(contractId);
  const base = process.env.NEXT_PUBLIC_APP_URL || (typeof window !== "undefined" ? window.location.origin : "");
  return `${base}${path}`;
}
