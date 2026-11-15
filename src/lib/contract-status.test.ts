import { describe, expect, it } from "vitest";
import { contractClosed, contractExpired, contractLocksTerms, documentLocksTerms } from "./contract-status";
import { dealStatusChip, dealStatusLabel } from "./deal-status";

const NOW = new Date("2026-11-04T12:00:00Z");
const YESTERDAY = new Date("2026-11-03T12:00:00Z");
const TOMORROW = new Date("2026-11-05T12:00:00Z");

describe("An expired sign link", () => {
  it("counts once the cron marked it, or as soon as a SealMe link passes its date", () => {
    expect(contractExpired({ status: "expired", deliveryMethod: "sealme", expiresAt: YESTERDAY }, NOW)).toBe(true);
    expect(contractExpired({ status: "sent", deliveryMethod: "sealme", expiresAt: YESTERDAY }, NOW)).toBe(true);
    // Serialized dates from the server read the same.
    expect(contractExpired({ status: "sent", deliveryMethod: "sealme", expiresAt: YESTERDAY.toISOString() }, NOW)).toBe(true);
  });

  it("doesn't count before its date, without one, on DocuSign, or once it's signed", () => {
    expect(contractExpired({ status: "sent", deliveryMethod: "sealme", expiresAt: TOMORROW }, NOW)).toBe(false);
    expect(contractExpired({ status: "sent", deliveryMethod: "sealme", expiresAt: null }, NOW)).toBe(false);
    expect(contractExpired({ status: "sent", deliveryMethod: "docusign", expiresAt: YESTERDAY }, NOW)).toBe(false);
    expect(contractExpired({ status: "signed", deliveryMethod: "sealme", expiresAt: YESTERDAY }, NOW)).toBe(false);
    expect(contractExpired(null, NOW)).toBe(false);
  });

  it("lets the rep edit the terms again", () => {
    expect(contractLocksTerms({ status: "sent", deliveryMethod: "sealme", expiresAt: YESTERDAY }, NOW)).toBe(false);
    expect(contractLocksTerms({ status: "sent", deliveryMethod: "sealme", expiresAt: TOMORROW }, NOW)).toBe(true);
    expect(contractLocksTerms({ status: "pending_approval", deliveryMethod: "sealme", expiresAt: null }, NOW)).toBe(true);
  });

  it("reads as expired on the deal, not as awaiting signature", () => {
    expect(dealStatusLabel("sent", true)).toBe("Sign link expired");
    expect(dealStatusChip("sent", true)).toBe("chip-warn");
    expect(dealStatusLabel("sent")).toBe("Sent - awaiting signature");
    // Only a sent deal is waiting on the link.
    expect(dealStatusLabel("changes_requested", true)).toBe("Changes requested");
  });
});

describe("A contract that won't be signed", () => {
  it("is one whose link ran out or that the rep marked not signed", () => {
    expect(contractClosed({ status: "not_signed", deliveryMethod: "docusign", expiresAt: null }, NOW)).toBe(true);
    expect(contractClosed({ status: "expired", deliveryMethod: "sealme", expiresAt: null }, NOW)).toBe(true);
    expect(contractClosed({ status: "sent", deliveryMethod: "sealme", expiresAt: YESTERDAY }, NOW)).toBe(true);
    for (const status of ["draft", "pending_approval", "sent", "partially_signed", "changes_requested", "signed"]) {
      expect(contractClosed({ status, deliveryMethod: "sealme", expiresAt: TOMORROW }, NOW)).toBe(false);
    }
    expect(contractClosed(null, NOW)).toBe(false);
  });

  it("leaves its terms open to rework before it's sent again", () => {
    expect(contractLocksTerms({ status: "not_signed", deliveryMethod: "sealme", expiresAt: null }, NOW)).toBe(false);
    expect(contractLocksTerms("not_signed")).toBe(false);
  });
});

describe("Editing terms after sending", () => {
  it("stays open for a proposal, which is never signed", () => {
    expect(documentLocksTerms({ status: "sent", deliveryMethod: "sealme", expiresAt: null }, "proposal", NOW)).toBe(false);
    expect(documentLocksTerms("sent", "proposal")).toBe(false);
  });

  it("locks a contract that's out for signature, as before", () => {
    expect(documentLocksTerms({ status: "sent", deliveryMethod: "sealme", expiresAt: TOMORROW }, "contract", NOW)).toBe(true);
    expect(documentLocksTerms("signed", undefined)).toBe(true);
    expect(documentLocksTerms({ status: "sent", deliveryMethod: "sealme", expiresAt: YESTERDAY }, null, NOW)).toBe(false);
  });
});
