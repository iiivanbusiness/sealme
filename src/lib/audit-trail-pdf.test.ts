import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFParse } from "pdf-parse";
import { AuditTrailPdfDocument, formatAuditTime } from "./audit-trail-pdf";

describe("audit trail times", () => {
  it("are written in UTC and say so", () => {
    // 9:30 PM in New York on Nov 4 is already Nov 5 in UTC.
    expect(formatAuditTime(new Date("2026-11-05T02:30:00Z"))).toBe("Nov 5, 2026, 02:30 UTC");
    expect(formatAuditTime(null)).toBe("-");
  });
});

describe("audit trail PDF text", () => {
  it("keeps accented names, the arrow and the empty-state italic", async () => {
    const render = (events: Parameters<typeof AuditTrailPdfDocument>[0]["events"]) =>
      renderToBuffer(
        createElement(AuditTrailPdfDocument, {
          clientName: "Marko Petrović",
          templateName: "Retainer",
          workspaceName: "Acme",
          generatedAt: new Date("2026-11-05T02:30:00Z"),
          events,
        }) as Parameters<typeof renderToBuffer>[0],
      );

    const textOf = async (buffer: Buffer) => {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        return (await parser.getText()).text;
      } finally {
        await parser.destroy();
      }
    };

    const text = await textOf(await render([{ when: new Date("2026-11-04T15:00:00Z"), label: "Field changed: fee", detail: '"$5,000" → "$8,000" (edited manually)' }]));
    expect(text).toContain("Retainer - Acme and Marko Petrović");
    expect(text).toContain("Generated Nov 5, 2026, 02:30 UTC");
    expect(text).toContain('"$5,000" → "$8,000"');

    expect(await textOf(await render([]))).toContain("No events recorded yet.");
  }, 30_000);
});
