import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToBuffer } from "@react-pdf/renderer";
import { PDFParse } from "pdf-parse";
import { ContractPdfDocument, attachmentDisposition, formatSignedAt } from "./contract-pdf";

describe("contract PDF download name", () => {
  it("survives names a header can't carry as-is", () => {
    for (const name of ["Retainer-Marko-Petrović.pdf", "Retainer–2026-Acme.pdf", "Ł’s-contract.pdf", "Đorđe-Šćekić.pdf"]) {
      const value = attachmentDisposition(name);
      expect(() => new Headers({ "Content-Disposition": value })).not.toThrow();
      const encoded = value.match(/filename\*=UTF-8''(.+)$/)?.[1] ?? "";
      expect(decodeURIComponent(encoded)).toBe(name);
    }
  });

  it("keeps a readable ASCII fallback", () => {
    expect(attachmentDisposition("Retainer-Marko-Petrović.pdf")).toContain('filename="Retainer-Marko-Petrovic.pdf"');
    expect(attachmentDisposition('Say "hi".pdf')).toContain('filename="Say hi.pdf"');
  });

  it("percent-encodes the characters RFC 5987 doesn't allow bare", () => {
    expect(attachmentDisposition("O'Brien (draft).pdf")).toContain("filename*=UTF-8''O%27Brien%20%28draft%29.pdf");
  });
});

describe("signed date in the PDF", () => {
  it("is written in UTC and says so", () => {
    // 9:30 PM in New York on Nov 4 is already Nov 5 in UTC.
    expect(formatSignedAt(new Date("2026-11-05T02:30:00Z"))).toBe("November 5, 2026 at 02:30 UTC");
  });
});

describe("contract PDF text", () => {
  it("keeps the letters Helvetica didn't have", async () => {
    const buffer = await renderToBuffer(
      createElement(ContractPdfDocument, {
        templateName: "Ugovor o saradnji",
        agencyName: "Acme",
        clientName: "Marko Petrović",
        clauses: [{ title: "Plaćanje", body: "Đorđe Šćekić plaća 5.000 € mesečno." }],
        signedBy: "Marko Petrović",
        signedAt: new Date("2026-11-05T02:30:00Z"),
      }) as Parameters<typeof renderToBuffer>[0],
    );
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const { text } = await parser.getText();
      expect(text).toContain("Between Acme and Marko Petrović");
      expect(text).toContain("Plaćanje");
      expect(text).toContain("Đorđe Šćekić plaća 5.000 € mesečno.");
      expect(text).toContain("Signed electronically by Marko Petrović on November 5, 2026 at 02:30 UTC.");
    } finally {
      await parser.destroy();
    }
    // Only the embedded font, never react-pdf's built-in Helvetica.
    const fonts = buffer.toString("latin1").match(/\/BaseFont \/\S+/g) ?? [];
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.every((f) => f.includes("LiberationSans"))).toBe(true);
  }, 30_000);

  it("keeps the DocuSign anchors findable in the text layer", async () => {
    // DocuSign places each signature field by finding its anchor string in
    // the PDF's text, so the embedded font must still extract as plain text.
    const buffer = await renderToBuffer(
      createElement(ContractPdfDocument, {
        templateName: "Retainer",
        agencyName: "Acme",
        clientName: "Marko Petrović",
        clauses: [{ title: "Term", body: "Three months." }],
        docusignAnchors: [
          { label: "Marko Petrović (Client)", anchor: "[[sig1]]" },
          { label: "Ana Đorđević (Signer 2)", anchor: "[[sig2]]" },
        ],
      }) as Parameters<typeof renderToBuffer>[0],
    );
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const { text } = await parser.getText();
      expect(text).toContain("Marko Petrović (Client): [[sig1]]");
      expect(text).toContain("Ana Đorđević (Signer 2): [[sig2]]");
    } finally {
      await parser.destroy();
    }
  }, 30_000);
});
