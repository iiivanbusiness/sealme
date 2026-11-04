import { beforeEach, describe, expect, it, vi } from "vitest";

const { deal, dealField, dealFieldChange, client, extract } = vi.hoisted(() => ({
  deal: { findUnique: vi.fn(), update: vi.fn() },
  dealField: { findMany: vi.fn(), upsert: vi.fn() },
  dealFieldChange: { create: vi.fn() },
  client: { update: vi.fn() },
  extract: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { deal, dealField, dealFieldChange, client } }));
vi.mock("@/lib/extract-deal", () => ({
  extractDealFromTranscript: extract,
  buildDealFieldRows: () => ({ fieldRows: [], hasMissing: false, service: "", fee: "" }),
}));

import { applyExtractionToDeal, contractLocksTerms } from "./deal-live";

function dealWithClientEmail(email: string | null) {
  return { id: "d1", clientId: "c1", status: "processing", service: "", feeDisplay: "", summary: null, lastExtractedTranscript: null, contract: null, client: { email } };
}

describe("Client email from a call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dealField.findMany.mockResolvedValue([]);
  });

  it("never replaces the email the rep entered", async () => {
    deal.findUnique.mockResolvedValue(dealWithClientEmail("jane@acme.com"));
    extract.mockResolvedValue({ summary: null, company: null, email: "legal@acme.com" });
    await applyExtractionToDeal("d1", "cc our legal at legal@acme.com", []);
    expect(client.update).not.toHaveBeenCalled();
  });

  it("fills an empty one, cleaned up, and skips one that isn't an address", async () => {
    deal.findUnique.mockResolvedValue(dealWithClientEmail(null));
    extract.mockResolvedValue({ summary: null, company: null, email: " Jane@Acme.com " });
    await applyExtractionToDeal("d1", "transcript", []);
    expect(client.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { email: "jane@acme.com" } });

    client.update.mockClear();
    extract.mockResolvedValue({ summary: null, company: null, email: "jane at acne dot com" });
    await applyExtractionToDeal("d1", "transcript", []);
    expect(client.update).not.toHaveBeenCalled();
  });
});

describe("Locked deal terms", () => {
  it("locks them once a reviewer or the client has the contract", () => {
    for (const status of ["pending_approval", "sent", "partially_signed", "signed"]) expect(contractLocksTerms(status)).toBe(true);
    for (const status of [null, undefined, "draft", "changes_requested", "expired"]) expect(contractLocksTerms(status)).toBe(false);
  });

  it("unlocks them once the SealMe sign link has expired, before the cron marks it", () => {
    const past = new Date(Date.now() - 1000);
    expect(contractLocksTerms({ status: "sent", deliveryMethod: "sealme", expiresAt: past })).toBe(false);
    expect(contractLocksTerms({ status: "sent", deliveryMethod: "sealme", expiresAt: new Date(Date.now() + 60_000) })).toBe(true);
    // DocuSign runs its own expiry.
    expect(contractLocksTerms({ status: "sent", deliveryMethod: "docusign", expiresAt: past })).toBe(true);
  });
});
