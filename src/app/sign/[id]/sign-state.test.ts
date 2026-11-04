import { describe, expect, it } from "vitest";
import { canCommentOnClauses, countersignPageState, signPageMessage, signPageState } from "./sign-state";

const now = new Date("2026-11-04T12:00:00Z");
const contract = (status: string, extra: { deliveryMethod?: string; expiresAt?: Date | null } = {}) => ({
  status,
  deliveryMethod: extra.deliveryMethod ?? "sealme",
  expiresAt: extra.expiresAt ?? null,
});

describe("sign page state", () => {
  it("takes a signature only while the contract is out on SealMe's own page", () => {
    expect(signPageState(contract("sent"), now)).toBe("open");
    for (const status of ["draft", "pending_approval", "changes_requested"]) {
      expect(signPageState(contract(status), now)).toBe("updating");
    }
  });

  it("shows the client's own part as done once they've signed", () => {
    expect(signPageState(contract("partially_signed"), now)).toBe("signed");
    expect(signPageState(contract("signed", { deliveryMethod: "docusign" }), now)).toBe("signed");
  });

  it("counts a sent contract past its expiry as expired before the cron catches up", () => {
    expect(signPageState(contract("sent", { expiresAt: new Date("2026-11-04T11:59:00Z") }), now)).toBe("expired");
    expect(signPageState(contract("sent", { expiresAt: new Date("2026-11-05T00:00:00Z") }), now)).toBe("open");
    expect(signPageState(contract("expired"), now)).toBe("expired");
  });

  it("sends DocuSign contracts back to DocuSign", () => {
    expect(signPageState(contract("sent", { deliveryMethod: "docusign" }), now)).toBe("docusign");
  });

  it("lets a client keep commenting after their first comment, but not during review", () => {
    expect(canCommentOnClauses(contract("sent"), now)).toBe(true);
    expect(canCommentOnClauses(contract("changes_requested"), now)).toBe(true);
    expect(canCommentOnClauses(contract("pending_approval"), now)).toBe(false);
    expect(canCommentOnClauses(contract("draft"), now)).toBe(false);
    expect(canCommentOnClauses(contract("sent", { deliveryMethod: "docusign" }), now)).toBe(false);
    expect(canCommentOnClauses(contract("partially_signed"), now)).toBe(false);
  });

  it("explains every state the client can't sign in", () => {
    expect(signPageMessage("open", "Acme")).toBeNull();
    expect(signPageMessage("expired", "Acme")).toContain("Ask Acme to resend it");
    expect(signPageMessage("updating", "Acme")).toContain("being updated");
    expect(signPageMessage("docusign", "Acme")).toContain("DocuSign");
  });
});

describe("counter-sign page state", () => {
  it("takes a counter-signature only while the contract is out for signature", () => {
    expect(countersignPageState(contract("sent"), now)).toBe("open");
    expect(countersignPageState(contract("partially_signed"), now)).toBe("open");
    for (const status of ["draft", "pending_approval", "changes_requested"]) {
      expect(countersignPageState(contract(status), now)).toBe("updating");
    }
  });

  it("keeps a partly signed contract open past the client's link expiry", () => {
    const expiresAt = new Date("2026-11-01T00:00:00Z");
    expect(countersignPageState(contract("partially_signed", { expiresAt }), now)).toBe("open");
    expect(countersignPageState(contract("sent", { expiresAt }), now)).toBe("expired");
    expect(countersignPageState(contract("expired"), now)).toBe("expired");
  });

  it("explains a finished or DocuSign contract instead of offering the form", () => {
    expect(countersignPageState(contract("signed"), now)).toBe("signed");
    expect(countersignPageState(contract("partially_signed", { deliveryMethod: "docusign" }), now)).toBe("docusign");
    expect(signPageMessage(countersignPageState(contract("changes_requested"), now), "Acme")).toContain("being updated");
  });
});
