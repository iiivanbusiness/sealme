import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// next/font only works inside Next's compiler; the paper just needs its
// CSS variable class.
vi.mock("./doc-font", () => ({ docFont: { variable: "doc-font" } }));

import ContractPaper from "./ContractPaper";
import TermsCard from "./TermsCard";
import TranscriptCard from "./TranscriptCard";
import CallPill from "./CallPill";
import NextCard from "./NextCard";
import ActionBar, { BarButton } from "./ActionBar";
import MoreSection from "./MoreSection";
import PreviewModal from "./PreviewModal";
import CopyLinkButton from "./CopyLinkButton";
import RenewalCard from "./RenewalCard";
import { DownloadIcon } from "./icons";
import type { ContractTerm } from "./types";

// Server-rendered once per state, so a broken branch shows up here
// without a browser.

const clauses = [
  { title: "", body: "This Agreement is between the parties below.", label: "" },
  { title: "Fees", body: "Client will pay {monthlyFee}, invoiced monthly. Again: {monthlyFee}.", label: "1" },
  { title: "Start date", body: "Services begin on {startDate}.", label: "2" },
  { title: "Approval", body: "Approved by {approval}.", label: "3" },
];
const terms: ContractTerm[] = [
  { key: "monthlyFee", label: "Monthly fee", fieldId: "f1", value: "$3,500 per month", state: "filled", onPaper: true, sourceQuote: "$3,500 a month works for us." },
  { key: "startDate", label: "Start date", fieldId: "f2", value: null, state: "empty", onPaper: true, sourceQuote: null },
  { key: "approval", label: "Approval", fieldId: "f3", value: "the CFO", state: "edited", onPaper: true, sourceQuote: null },
  { key: "clientEmail", label: "Client email", fieldId: "f4", value: null, state: "empty", onPaper: false, sourceQuote: null },
];
const base = { kind: "contract", agencyName: "Northpeak", partyName: "Harbor Media", templateName: "Service Agreement", clauses, terms, metaText: "Draft" };

describe("ContractPaper", () => {
  it("draws filled, edited, empty and asked terms, numbered clauses and the signature block", () => {
    const html = renderToStaticMarkup(h(ContractPaper, { ...base, editable: true, onStartEdit: () => {}, askedKeys: new Set(["startDate"]), heardKey: "monthlyFee", heardQuote: "$3,500 a month works for us.", metaLive: true, metaText: "Draft, filling in during the call" }));
    expect(html).toContain("Northpeak and Harbor Media");
    expect(html).toContain("Fees.");
    expect(html).toContain("1.");
    // Both places the fee appears show it.
    expect(html.match(/>\$3,500 per month<\/span>/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Edit Start date (asked, empty)"');
    expect(html).toContain('aria-label="Edit Approval: the CFO"');
    expect(html).toContain("Authorized signature");
    // No room measured beside the paper and not a phone: the note floats
    // over the text by the term, so nothing under it moves.
    expect(html).toContain("Just heard");
    expect(html).toContain("“$3,500 a month works for us.”");
    expect(html).toContain('data-over=""');
  });

  it("draws blanks and no buttons in preview", () => {
    const html = renderToStaticMarkup(h(ContractPaper, { ...base, editable: true, onStartEdit: () => {}, mode: "preview" }));
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("Draft");
    expect(html).toContain("$3,500 per month");
    expect(html).not.toContain(">Start date</span>");
  });

  it("draws a proposal without signatures and a sent snapshot as plain text", () => {
    const proposal = renderToStaticMarkup(h(ContractPaper, { ...base, kind: "proposal", editable: true }));
    expect(proposal).toContain("Prepared for Harbor Media by Northpeak");
    expect(proposal).not.toContain("Authorized signature");
    const sent = renderToStaticMarkup(h(ContractPaper, { ...base, editable: false, plainClauses: [{ title: "Fees", body: "Client will pay $9 a month." }], signature: { signerName: "Mark Ellison", signedAt: "Nov 16, 2026", image: null } }));
    expect(sent).toContain("Client will pay $9 a month.");
    expect(sent).not.toContain('role="button"');
    expect(sent).toContain("Signed by Mark Ellison on Nov 16, 2026");
  });
});

describe("ContractPaper with the client's comments", () => {
  const comments = [
    { id: "c1", clauseTitle: "Fees", comment: "Can we do $3,000?", fromName: "Dana Ruiz" },
    { id: "c2", clauseTitle: "", comment: "Use our legal name.", fromName: "Dana Ruiz" },
    { id: "c3", clauseTitle: "Payment schedule", comment: "Net 45 please.", fromName: "The client" },
  ];
  it("shows each one under the clause it's about, and one whose clause is gone after the clauses", () => {
    const html = renderToStaticMarkup(h(ContractPaper, { ...base, editable: true, onStartEdit: () => {}, comments }));
    expect(html).toContain("Client comment</div>");
    expect(html).toContain("<b>Dana Ruiz:</b> Can we do $3,000?");
    // Under Fees: after its text, before the next clause.
    expect(html.indexOf("Can we do $3,000?")).toBeGreaterThan(html.indexOf("invoiced monthly"));
    expect(html.indexOf("Can we do $3,000?")).toBeLessThan(html.indexOf("Services begin on"));
    // The untitled first clause has no terms: it's the template's own wording.
    expect(html.indexOf("Use our legal name.")).toBeLessThan(html.indexOf("Fees."));
    expect(html.match(/This clause is fixed template wording/g)).toHaveLength(1);
    expect(html).toContain("Client comment on Payment schedule");
    expect(html).toContain("Net 45 please.");
  });
  it("never puts them in the preview, and says nothing about fixing a document that can't be edited", () => {
    expect(renderToStaticMarkup(h(ContractPaper, { ...base, editable: true, mode: "preview", comments }))).not.toContain("Client comment");
    const locked = renderToStaticMarkup(h(ContractPaper, { ...base, editable: false, comments }));
    expect(locked).toContain("Can we do $3,000?");
    expect(locked).not.toContain("fixed template wording");
  });
});

describe("TermsCard", () => {
  it("counts terms and marks missing and asked ones", () => {
    const html = renderToStaticMarkup(h(TermsCard, { title: "Contract terms", terms, askedKeys: new Set(["startDate"]), onPick: () => {}, editable: true }));
    expect(html).toContain('id="missing"');
    expect(html).toContain("2 of 4");
    expect(html).toContain("Asked");
    expect(html).toContain("Missing");
  });
  it("types a term that isn't on the paper in its row", () => {
    const html = renderToStaticMarkup(h(TermsCard, { title: "Contract terms", terms, askedKeys: new Set<string>(), onPick: () => {}, editable: true, editingKey: "clientEmail", onCommit: () => {} }));
    expect(html).toContain('aria-label="Edit Client email"');
    expect(html).toContain('type="email"');
  });
  it("says All in when every term is in", () => {
    const html = renderToStaticMarkup(h(TermsCard, { title: "Proposal terms", terms: [terms[0]], askedKeys: new Set<string>(), onPick: () => {}, editable: true }));
    expect(html).toContain("All 1 in");
  });
});

describe("TranscriptCard", () => {
  const lines = [
    { speaker: "you" as const, name: null, text: "Does $3,500 a month work?" },
    { speaker: "client" as const, name: null, text: "$3,500 a month works for us." },
  ];
  it("names the speakers and marks quotes", () => {
    const html = renderToStaticMarkup(h(TranscriptCard, { lines, live: true, clientFirstName: "Dana", highlights: [{ line: 1, start: 0, end: 16, tone: "yellow" }] }));
    expect(html).toContain("Live transcript");
    expect(html).toContain("<b>Dana</b>");
    expect(html).toContain("<b>You</b>");
    expect(html).toContain('data-tone="yellow">$3,500 a month w</span>');
  });
  it("is hidden with no transcript once the call is over", () => {
    expect(renderToStaticMarkup(h(TranscriptCard, { lines: [], live: false, clientFirstName: null, highlights: [] }))).toBe("");
  });
});

describe("CallPill, NextCard, ActionBar, MoreSection", () => {
  it("renders the live and ended pill", () => {
    const live = renderToStaticMarkup(h(CallPill, { state: "live", startedAt: "2026-11-16T10:00:00.000Z", name: "Dana Ruiz", sub: "Marketing lead", onEnd: () => {} }));
    expect(live).toContain("LIVE");
    expect(live).toContain("DR");
    expect(live).toContain("End call");
    const browser = renderToStaticMarkup(h(CallPill, { state: "live", startedAt: null, name: "Dana Ruiz", hint: "Recording in the desktop app" }));
    expect(browser).toContain("Recording in the desktop app");
    expect(browser).not.toContain("End call");
    const ended = renderToStaticMarkup(h(CallPill, { state: "ended", startedAt: null, name: "Dana Ruiz", onEnd: () => {} }));
    expect(ended).toContain("ENDED");
    expect(ended).toContain("Finishing up");
    expect(ended).not.toContain("End call");
  });
  it("calls a lead nobody has named yet New lead, with no made-up initials", () => {
    const html = renderToStaticMarkup(h(CallPill, { state: "live", startedAt: null, name: null, documentLabel: "proposal", onEnd: () => {} }));
    expect(html).toContain("New lead");
    expect(html).not.toContain("NL");
    expect(html).toContain("<svg");
  });
  it("renders the generic cards and the bar", () => {
    expect(renderToStaticMarkup(h(NextCard, { eyebrow: "Ask next", title: "Start date", quote: "When would you like us to start?" }))).toContain("“When would you like us to start?”");
    const bar = renderToStaticMarkup(h(ActionBar, null, h(BarButton, { variant: "primary", badge: "2 terms missing", children: "Send for signature" }), h(BarButton, { href: "/api/contracts/c1/pdf", children: "Download PDF" })));
    expect(bar).toContain("2 terms missing");
    expect(bar).toContain('href="/api/contracts/c1/pdf"');
    // The phone's help button moves up out of its way (globals.css).
    expect(bar).toContain('data-action-bar=""');
    expect(renderToStaticMarkup(h(MoreSection, { hint: "Notes", children: "Inside" }))).toContain("Inside");
  });
  it("keeps the main button's icon apart from its label, so a narrow bar can leave it out", () => {
    const html = renderToStaticMarkup(h(BarButton, { variant: "primary", icon: h(DownloadIcon), badge: "All 3 terms in", children: "Download PDF" }));
    expect(html).toMatch(/<span[^>]*><svg[^>]*>.*<\/svg><\/span><span[^>]*>Download PDF<\/span>/);
    expect(html).toContain("All 3 terms in");
  });
});

describe("PreviewModal, CopyLinkButton, RenewalCard", () => {
  it("puts the screen's own actions in the preview header, with no link to another page", () => {
    const html = renderToStaticMarkup(h(PreviewModal, { open: true, onClose: () => {}, subtitle: "This is what Harbor Media will see.", actions: h("button", null, "Download PDF"), children: "Paper" }));
    expect(html).toContain("Download PDF");
    expect(html).toContain("Close");
    expect(html).not.toContain("href=");
    expect(html).not.toContain('role="alert"');
  });
  it("shows an action's error inside the preview, where a page toast can't be seen", () => {
    const html = renderToStaticMarkup(h(PreviewModal, { open: true, onClose: () => {}, actions: h("button", null, "Download PDF"), notice: "Couldn't download the PDF. Try again.", children: "Paper" }));
    expect(html).toMatch(/role="alert"[^>]*>Couldn&#x27;t download the PDF\. Try again\.</);
  });
  it("offers to copy the sign link", () => {
    expect(renderToStaticMarkup(h(CopyLinkButton, { link: () => "https://app.test/sign/k1" }))).toContain("Copy sign link");
  });
  it("says when the term ends and offers to start the renewal", () => {
    const html = renderToStaticMarkup(h(RenewalCard, { date: "2027-01-15T00:00:00.000Z", autoRenews: false, note: "Renews yearly unless 30 days' notice is given", startAction: async () => {} }));
    expect(html).toContain("Renewal");
    expect(html).toContain("Term ends");
    expect(html).toContain("Renews yearly unless 30 days&#x27; notice is given");
    expect(html).toContain("Start renewal");
    // Days left go by the viewer's clock: nothing on the server.
    expect(html).not.toContain("d left");
    expect(renderToStaticMarkup(h(RenewalCard, { date: "2027-01-15T00:00:00.000Z", autoRenews: true, note: null }))).toContain("Auto-renews");
  });
});
