import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/dashboard/SendReminderButton", () => ({ default: () => null }));

import NeedsYou from "./NeedsYou";
import type { NeedsYouData } from "@/lib/dashboard-data";

describe("Needs you", () => {
  it("opens an approval on the contract screen itself", () => {
    const data = {
      approvals: [{ dealId: "d1", name: "Harbor Media", service: "SEO" }],
      reminders: { rows: [], more: 0 },
      toSend: { rows: [], more: 0 },
      unnamed: null,
      callsToCheck: 0,
    } as unknown as NeedsYouData;
    const html = renderToStaticMarkup(h(NeedsYou, { data, phoneNotice: false, reminders: null }));
    expect(html).toContain("Approve the contract for Harbor Media");
    expect(html.match(/href="\/deals\/d1"/g)).toHaveLength(2);
    expect(html).not.toContain("/deals/d1/contract");
  });
});
