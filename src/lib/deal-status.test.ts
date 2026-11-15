import { describe, expect, it } from "vitest";
import { STATUS_LABEL, canMarkNotSigned, dealStatusChip, dealStatusLabel } from "./deal-status";

describe("A proposal's status", () => {
  it("reads plainly from the rep's side", () => {
    expect(dealStatusLabel("missing_info", false, "proposal")).toBe("Missing info");
    expect(dealStatusLabel("ready", false, "proposal")).toBe("Ready to send");
    expect(dealStatusLabel("sent", false, "proposal")).toBe("Sent");
  });

  it("never mentions a signature or an expired sign link", () => {
    expect(dealStatusLabel("sent", true, "proposal")).toBe("Sent");
    expect(dealStatusChip("sent", true, "proposal")).toBe("chip-neutral");
    // A proposal can't be signed, so it never reaches "signed" itself.
    for (const status of Object.keys(STATUS_LABEL).filter((s) => s !== "signed")) {
      expect(dealStatusLabel(status, true, "proposal")).not.toMatch(/sign/i);
    }
  });

  it("keeps the contract wording for the states they share", () => {
    expect(dealStatusLabel("processing", false, "proposal")).toBe(STATUS_LABEL.processing);
    expect(dealStatusLabel("extraction_failed", false, "proposal")).toBe(STATUS_LABEL.extraction_failed);
    expect(dealStatusChip("ready", false, "proposal")).toBe(dealStatusChip("ready"));
  });
});

describe("A contract's status", () => {
  it("reads as before without a kind, or with any kind but proposal", () => {
    expect(dealStatusLabel("sent")).toBe("Sent - awaiting signature");
    expect(dealStatusLabel("ready")).toBe("Ready for review");
    expect(dealStatusLabel("sent", true)).toBe("Sign link expired");
    expect(dealStatusChip("sent", true)).toBe("chip-warn");
    expect(dealStatusLabel("sent", false, "contract")).toBe("Sent - awaiting signature");
    expect(dealStatusLabel("sent", true, "contract")).toBe("Sign link expired");
    expect(dealStatusLabel("sent", true, null)).toBe("Sign link expired");
    expect(dealStatusChip("sent", true, "contract")).toBe("chip-warn");
  });

  it("reads Not signed once the rep marked it, even though the deal stays sent", () => {
    expect(dealStatusLabel("sent", false, "contract", "not_signed")).toBe("Not signed");
    expect(dealStatusChip("sent", false, "contract", "not_signed")).toBe("chip-danger");
    // An expired link marked as not signed reads as the rep left it.
    expect(dealStatusLabel("sent", true, null, "not_signed")).toBe("Not signed");
    expect(dealStatusChip("sent", true, undefined, "not_signed")).toBe("chip-danger");
    expect(dealStatusLabel("changes_requested", false, "contract", "not_signed")).toBe("Not signed");
  });

  it("reads as before when the contract is still out or its status isn't passed", () => {
    expect(dealStatusLabel("sent", false, "contract", "sent")).toBe("Sent - awaiting signature");
    expect(dealStatusChip("sent", false, "contract", "sent")).toBe("chip-neutral");
    expect(dealStatusLabel("sent", true, "contract", "expired")).toBe("Sign link expired");
    expect(dealStatusChip("sent", true, "contract", "expired")).toBe("chip-warn");
    expect(dealStatusLabel("sent", false, "contract", null)).toBe("Sent - awaiting signature");
    expect(dealStatusLabel("signed", false, "contract", "signed")).toBe("Signed");
  });
});

describe("A proposal's status with its document's status", () => {
  it("never reads Not signed, since a proposal is never signed", () => {
    expect(dealStatusLabel("sent", false, "proposal", "not_signed")).toBe("Sent");
    expect(dealStatusChip("sent", false, "proposal", "not_signed")).toBe("chip-neutral");
  });
});

describe("Mark as not signed", () => {
  const SENT_AT = new Date("2026-11-04T12:00:00Z");

  it("is offered on a contract that went out and isn't signed", () => {
    expect(canMarkNotSigned({ status: "sent" }, "contract")).toBe(true);
    expect(canMarkNotSigned({ status: "partially_signed" }, "contract")).toBe(true);
    expect(canMarkNotSigned({ status: "expired" }, null)).toBe(true);
    expect(canMarkNotSigned({ status: "changes_requested", sentAt: SENT_AT }, "contract")).toBe(true);
    expect(canMarkNotSigned({ status: "changes_requested", sentAt: SENT_AT.toISOString() }, undefined)).toBe(true);
  });

  it("isn't offered before it went out, once it's signed or marked, or on a proposal", () => {
    expect(canMarkNotSigned({ status: "draft" }, "contract")).toBe(false);
    expect(canMarkNotSigned({ status: "pending_approval" }, "contract")).toBe(false);
    // Changes a reviewer asked for before it ever reached the client.
    expect(canMarkNotSigned({ status: "changes_requested", sentAt: null }, "contract")).toBe(false);
    expect(canMarkNotSigned({ status: "changes_requested" }, "contract")).toBe(false);
    expect(canMarkNotSigned({ status: "signed" }, "contract")).toBe(false);
    expect(canMarkNotSigned({ status: "not_signed" }, "contract")).toBe(false);
    expect(canMarkNotSigned({ status: "sent" }, "proposal")).toBe(false);
    expect(canMarkNotSigned(null, "contract")).toBe(false);
  });
});
