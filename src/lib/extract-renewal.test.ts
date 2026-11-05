import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, create } = vi.hoisted(() => ({
  contract: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  create: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ prisma: { contract } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { extractRenewalTerms } from "./extract-renewal";

const SIGNED_TEXT = { templateName: "Retainer", agencyName: "Agency", clientName: "Brightline", clauses: [{ title: "Term", body: "This agreement continues for 3 months." }] };

function signedContract(timezone: string | null | undefined, snapshot: unknown = SIGNED_TEXT) {
  return {
    id: "c1",
    status: "signed",
    deliveryMethod: "sealme",
    expiresAt: null,
    snapshot,
    // 9:30 PM in New York on Nov 4 is already Nov 5 in UTC.
    signedAt: new Date("2026-11-05T02:30:00Z"),
    // Edited after signing: none of this may reach the renewal read.
    template: { name: "Retainer", clauses: JSON.stringify([{ title: "Term", body: "This agreement continues for {term}." }]) },
    deal: { fields: [{ fieldKey: "term", value: "12 months" }], client: { name: "Priya", company: "Brightline" }, workspace: { name: "Agency" }, owner: timezone === undefined ? null : { timezone } },
  };
}

function contractTextSent(): string {
  return create.mock.calls[0][0].messages[0].content.split("Contract text:\n\n")[1];
}

async function signedDateSent(timezone: string | null | undefined): Promise<string | undefined> {
  contract.findUnique.mockResolvedValue(signedContract(timezone));
  await extractRenewalTerms("c1");
  return create.mock.calls[0][0].messages[0].content.match(/^Signed date: (\S+)/)?.[1];
}

describe("renewal terms", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({ content: [] });
  });

  it("counts from the day it was signed on the deal owner's clock", async () => {
    expect(await signedDateSent("America/New_York")).toBe("2026-11-04");
  });

  it("reads the text that was signed, not the terms as they are now", async () => {
    await signedDateSent("UTC");
    expect(contractTextSent()).toBe("Term\nThis agreement continues for 3 months.");
    expect(contract.updateMany).not.toHaveBeenCalled();
  });

  it("freezes a contract signed before snapshots existed", async () => {
    contract.findUnique.mockResolvedValue(signedContract("UTC", null));
    contract.updateMany.mockResolvedValue({ count: 1 });
    await extractRenewalTerms("c1");
    expect(contractTextSent()).toBe("Term\nThis agreement continues for 12 months.");
    expect(contract.updateMany).toHaveBeenCalledTimes(1);
  });

  it("falls back to UTC without a usable owner zone", async () => {
    for (const timezone of [undefined, null, "Not/AZone"]) {
      create.mockClear();
      expect(await signedDateSent(timezone)).toBe("2026-11-05");
    }
  });
});
