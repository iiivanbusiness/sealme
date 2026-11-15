import { beforeEach, describe, expect, it, vi } from "vitest";

const { deal, dealField, dealFieldChange, client, extract, executeRaw, rows } = vi.hoisted(() => ({
  deal: { findUnique: vi.fn(), update: vi.fn() },
  dealField: { findMany: vi.fn(), upsert: vi.fn(), count: vi.fn() },
  dealFieldChange: { create: vi.fn() },
  client: { update: vi.fn() },
  extract: vi.fn(),
  // The compare-and-set on the deal: 1 when this pass may write.
  executeRaw: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 1),
  rows: { current: [] as object[] },
}));
vi.mock("@/lib/db", () => ({ prisma: { deal, dealField, dealFieldChange, client, $executeRaw: executeRaw } }));
vi.mock("@/lib/extract-deal", () => ({
  extractDealFromTranscript: extract,
  buildDealFieldRows: () => ({ fieldRows: rows.current, hasMissing: false, service: "", fee: "" }),
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

describe("Overlapping readings of the same call", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.current = [{ fieldKey: "fee", label: "Fee", groupLabel: "Terms", value: "$4,000", status: "extracted", confidence: 0.9, sourceQuote: "four thousand", orderIndex: 0 }];
    dealField.findMany.mockResolvedValue([{ fieldKey: "fee", value: "$5,000", status: "extracted" }]);
    deal.findUnique.mockResolvedValue({ ...dealWithClientEmail("dana@northwind.test"), lastExtractedTranscript: "Client: Four thousand." });
    extract.mockResolvedValue({ summary: "Older summary", company: null, email: null });
  });

  it("leaves the deal alone when a newer reading of a longer transcript got there first", async () => {
    executeRaw.mockResolvedValueOnce(0);
    dealField.count.mockResolvedValue(2);

    expect(await applyExtractionToDeal("d1", "Client: Four thousand.", ["fee"])).toEqual({ hasMissing: true });

    // Checked and claimed in one statement, after the slow model call.
    const [sql, stored, , readAtStart, compared] = executeRaw.mock.calls[0] as [string[], string, string, string | null, string];
    expect(sql.join("?")).toContain('"lastExtractedTranscript" IS NOT DISTINCT FROM ?');
    expect(sql.join("?")).toContain('starts_with(?, COALESCE("lastExtractedTranscript", \'\'))');
    expect(sql.join("?")).not.toContain("length(");
    expect(stored).toBe("Client: Four thousand.");
    expect(readAtStart).toBe("Client: Four thousand.");
    expect(compared).toBe("Client: Four thousand.");
    expect(extract.mock.invocationCallOrder[0]).toBeLessThan(executeRaw.mock.invocationCallOrder[0]);
    expect(dealField.upsert).not.toHaveBeenCalled();
    expect(dealFieldChange.create).not.toHaveBeenCalled();
    expect(deal.update).not.toHaveBeenCalled();
    expect(client.update).not.toHaveBeenCalled();
  });

  it("writes when it read as much as, or more than, the last reading (a retry, a later chunk)", async () => {
    await applyExtractionToDeal("d1", "Client: Four thousand.", ["fee"]);

    expect(dealFieldChange.create).toHaveBeenCalledWith({ data: expect.objectContaining({ fieldKey: "fee", oldValue: "$5,000", newValue: "$4,000" }) });
    expect(dealField.upsert).toHaveBeenCalledTimes(1);
    expect(deal.update.mock.calls[0][0].data).toMatchObject({ summary: "Older summary", lastExtractedTranscript: "Client: Four thousand." });
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
