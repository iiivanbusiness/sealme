import { describe, expect, it } from "vitest";
import { fieldMeta, fieldQuestion } from "./field-meta";

describe("Suggested questions", () => {
  it("has one for each standard term", () => {
    expect(fieldQuestion("startDate", "Start date")).toBe("When would you like to start?");
    expect(fieldQuestion("fee", "Fee")).toBe("What budget did you have in mind?");
    for (const key of ["clientName", "clientEmail", "service", "duration", "deliverables", "platforms", "paymentTerms", "cancellation", "billingAddress"]) {
      expect(fieldQuestion(key, fieldMeta(key).label)).toMatch(/^[A-Z].+\?$/);
      expect(fieldQuestion(key, fieldMeta(key).label)).not.toContain("should we put for");
    }
  });

  it("builds one from the label for a template's own term, keeping short forms in capitals", () => {
    expect(fieldQuestion("billingCycle", "Billing cycle")).toBe("What should we put for billing cycle?");
    expect(fieldQuestion("sdrCount", "SDR count")).toBe("What should we put for SDR count?");
    expect(fieldQuestion("seats", "  ")).toBe("What should we put for seats?");
  });

  it("never finds a question on Object's own keys", () => {
    expect(fieldQuestion("constructor", "Constructor")).toBe("What should we put for constructor?");
  });
});
