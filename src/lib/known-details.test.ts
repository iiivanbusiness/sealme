import { describe, expect, it } from "vitest";
import { fillKnownDetails, knownDetailFor } from "@/lib/known-details";

const row = (fieldKey: string, value: string | null = null) => ({ fieldKey, value, status: value ? "extracted" : "missing", confidence: value ? 0.9 : null, sourceQuote: value ? "on the call" : null });

describe("knownDetailFor", () => {
  it("matches a person's details by what the field is called", () => {
    expect(["clientSignerName", "clientContactName", "clientContact", "signerName", "contactName", "client_signer_name", "clientRepresentative"].map(knownDetailFor)).toEqual(Array(7).fill("name"));
    expect(["clientSignerTitle", "clientTitle", "signerTitle", "contactTitle", "clientContactRole"].map(knownDetailFor)).toEqual(Array(5).fill("title"));
    expect(["clientEmail", "clientContactEmail", "clientNoticeEmail", "signerEmail"].map(knownDetailFor)).toEqual(Array(4).fill("email"));
    expect(["clientPhone", "contactPhoneNumber"].map(knownDetailFor)).toEqual(["phone", "phone"]);
    expect(["billingAddress", "clientAddress", "clientBillingAddress"].map(knownDetailFor)).toEqual(["address", "address", "address"]);
  });

  it("never takes the company or a term for a person's detail", () => {
    expect(["clientName", "fee", "title", "name", "projectTitle", "role", "agencyContactName", "service", "startDate", "contactPeriod"].map(knownDetailFor)).toEqual(Array(10).fill(null));
  });
});

describe("fillKnownDetails", () => {
  it("fills empty fields it knows, and keeps what the call said", () => {
    const rows = [row("clientName", "Acme Inc."), row("clientSignerName"), row("clientSignerTitle", "COO"), row("clientEmail"), row("billingAddress"), row("fee")];
    const filled = fillKnownDetails(rows, { name: "Jane Doe", title: "CFO", email: "jane@acme.com", address: null });
    expect(filled.map((r) => [r.fieldKey, r.value, r.status])).toEqual([
      ["clientName", "Acme Inc.", "extracted"],
      ["clientSignerName", "Jane Doe", "confirmed"],
      ["clientSignerTitle", "COO", "extracted"],
      ["clientEmail", "jane@acme.com", "confirmed"],
      ["billingAddress", null, "missing"],
      ["fee", null, "missing"],
    ]);
    expect(filled[1]).toMatchObject({ confidence: null, sourceQuote: null });
  });

  it("leaves a field empty when the detail is blank", () => {
    expect(fillKnownDetails([row("clientSignerTitle")], { title: "  " })[0].value).toBeNull();
  });
});
