import { describe, expect, it } from "vitest";
import { buildDefaultTemplates, buildSampleProposalTemplate } from "./default-templates";
import { extractPlaceholderKeys } from "./contract";
import { STANDARD_FIELD_LABELS } from "./field-meta";

const STANDARD = new Set(STANDARD_FIELD_LABELS.map((f) => f.key));

describe("the starter templates", () => {
  it("are all contracts", () => {
    expect(buildDefaultTemplates("Acme").map((t) => t.kind)).toEqual(["contract", "contract", "contract"]);
  });
});

describe("the sample proposal", () => {
  const sample = buildSampleProposalTemplate("Northwind Studio");
  const clauses = JSON.parse(sample.clauses) as { title: string; body: string }[];
  const keys = extractPlaceholderKeys(sample.clauses);

  it("is a proposal template", () => {
    expect(sample.kind).toBe("proposal");
    expect(sample.name).toBe("Proposal");
  });

  it("uses only standard fields, so a contract made from it carries them over", () => {
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !STANDARD.has(k))).toEqual([]);
    expect(keys).toEqual(expect.arrayContaining(["clientName", "service", "deliverables", "fee", "paymentTerms", "startDate", "duration"]));
  });

  it("counts each field once", () => {
    expect(sample.requiredFieldCount).toBe(new Set(keys).size);
    expect(sample.requiredFieldCount).toBe(7);
  });

  it("names the agency and has no signature section", () => {
    expect(clauses.some((c) => c.body.includes("Northwind Studio"))).toBe(true);
    expect(clauses.some((c) => /sign(ature|ed by)|accepted by/i.test(c.title))).toBe(false);
  });

  it("keeps braces in a workspace name from becoming a field", () => {
    expect(extractPlaceholderKeys(buildSampleProposalTemplate("Acme {beta}").clauses)).not.toContain("beta");
  });
});
