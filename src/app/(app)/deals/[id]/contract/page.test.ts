import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
}));

import ContractPage from "./page";

describe("The old contract page", () => {
  it("sends links made before (emails, notifications, the API) on to the deal page", async () => {
    await expect(ContractPage({ params: Promise.resolve({ id: "d1" }) })).rejects.toThrow(/^redirect \/deals\/d1$/);
  });
});
