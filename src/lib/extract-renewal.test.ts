import { beforeEach, describe, expect, it, vi } from "vitest";

const { contract, create } = vi.hoisted(() => ({
  contract: { findUnique: vi.fn(), update: vi.fn() },
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

function signedContract(timezone: string | null | undefined) {
  return {
    id: "c1",
    // 9:30 PM in New York on Nov 4 is already Nov 5 in UTC.
    signedAt: new Date("2026-11-05T02:30:00Z"),
    template: { clauses: JSON.stringify([{ title: "Term", body: "This agreement continues for 3 months." }]) },
    deal: { fields: [], owner: timezone === undefined ? null : { timezone } },
  };
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

  it("falls back to UTC without a usable owner zone", async () => {
    for (const timezone of [undefined, null, "Not/AZone"]) {
      create.mockClear();
      expect(await signedDateSent(timezone)).toBe("2026-11-05");
    }
  });
});
