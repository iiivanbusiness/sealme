import { describe, expect, it } from "vitest";
import { isOverdue } from "./ActionItemsCard";

// Due dates are stored as midnight UTC of the due day.
const due = new Date("2026-11-14");

describe("isOverdue", () => {
  it("is not late on the due day itself, wherever the viewer is", () => {
    // 19:30 in New York on Nov 14 is already Nov 15 in UTC.
    expect(isOverdue(due, "2026-11-14")).toBe(false);
  });

  it("is late from the next day on", () => {
    expect(isOverdue(due, "2026-11-15")).toBe(true);
    expect(isOverdue(due, "2027-01-02")).toBe(true);
  });

  it("is not late before the due day", () => {
    expect(isOverdue(due, "2026-11-13")).toBe(false);
  });
});
