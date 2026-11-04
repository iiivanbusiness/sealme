import { describe, expect, it } from "vitest";
import { filenameFromDisposition } from "./download-filename";
import { attachmentDisposition } from "./contract-pdf";

describe("download file name", () => {
  it("reads back the real name the server sent", () => {
    for (const name of ["Audit-Trail-Marko-Petrović.pdf", "O'Brien (draft).pdf", "Retainer–2026.pdf"]) {
      expect(filenameFromDisposition(attachmentDisposition(name), "x.pdf")).toBe(name);
    }
  });

  it("falls back to the plain name, then the default", () => {
    expect(filenameFromDisposition('attachment; filename="Audit-Trail-Acme.pdf"', "x.pdf")).toBe("Audit-Trail-Acme.pdf");
    expect(filenameFromDisposition("attachment; filename=\"plain.pdf\"; filename*=UTF-8''%E0%A4%A", "x.pdf")).toBe("plain.pdf");
    expect(filenameFromDisposition("", "audit-trail.pdf")).toBe("audit-trail.pdf");
  });
});
