import { createElement as h, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The contract screen rendered once per state, on the server, with the
// parts that talk to the server or the desktop app stubbed out.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./contract/doc-font", () => ({ docFont: { variable: "doc-font" } }));
vi.mock("@/lib/live-capture-client", () => ({
  useCaptureSession: () => null,
  stopCapture: vi.fn(),
  discardCapture: vi.fn(),
  showCaptureOnPage: () => () => {},
}));
vi.mock("@/app/(app)/deals/bulk-actions", () => ({ restoreDeal: vi.fn() }));
const { stub } = vi.hoisted(() => ({ stub: (name: string) => ({ default: () => `[${name}]` }) }));
vi.mock("./NothingHeardYet", () => stub("NothingHeardYet"));
vi.mock("./MicSilentWarning", () => stub("MicSilentWarning"));
vi.mock("./ContinueCallButton", () => stub("ContinueCallButton"));
vi.mock("./ActionItemsCard", () => stub("ActionItemsCard"));
vi.mock("./CallHighlightsOverlay", () => stub("CallHighlightsOverlay"));
vi.mock("./SendToDocusignButton", () => stub("SendToDocusignButton"));
vi.mock("./VoiceCorrectionButton", () => stub("VoiceCorrectionButton"));
vi.mock("./DealNotes", () => stub("DealNotes"));
vi.mock("./ReviewPanel", () => stub("ReviewPanel"));
vi.mock("./ProposalActions", () => stub("ProposalActions"));
vi.mock("./MarkNotSignedButton", () => stub("MarkNotSignedButton"));
vi.mock("./AuditTrailButton", () => ({ default: () => "Export audit trail" }));

import LiveDealView from "./LiveDealView";

type Props = ComponentProps<typeof LiveDealView>;

const clauses = JSON.stringify([
  { title: "Fees", body: "Client will pay {fee}, invoiced monthly." },
  { title: "Term", body: "This agreement runs for twelve months." },
]);
const field = { id: "f1", fieldKey: "fee", groupLabel: "Terms", label: "Fee", value: "$5,000 per month", status: "extracted", sourceQuote: null, history: [] };
const noop = async () => ({});

function props(over: Partial<Props> = {}): Props {
  return {
    dealId: "d1",
    leadId: "l1",
    clientName: "Dana Ruiz",
    client: { name: "Dana Ruiz", company: "Harbor Media" },
    agencyName: "Northpeak",
    contractViewedAt: null,
    template: { id: "t1", version: "t1:x", name: "Service Agreement", clauses },
    plainText: null,
    signature: null,
    hasContract: true,
    initialStatus: "ready",
    initialSummary: null,
    initialFields: [field],
    initialCalls: [],
    initialActionItems: [],
    initialCallHighlights: [],
    phoneCall: null,
    getLiveDealStateAction: async () => null,
    setFieldAction: noop,
    generateAndSendAction: noop,
    makeDraftAction: noop,
    retryExtractionAction: () => {},
    toggleActionItemAction: noop,
    notes: [],
    currentUserEmail: "sam@northpeak.test",
    currentUserName: "Sam",
    addNoteAction: noop,
    deleteNoteAction: noop,
    applyVoiceFieldCorrectionAction: noop,
    sendForReviewToAction: noop,
    docusignEnabled: false,
    contractStatus: "draft",
    contractExpired: false,
    clientHasEmail: true,
    sendViaDocusignNowAction: noop,
    reviewPanel: null,
    contractId: "k1",
    today: "2026-11-16",
    ...over,
  };
}

const render = (over: Partial<Props> = {}) => renderToStaticMarkup(h(LiveDealView, props(over)));
const viewedAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();

describe("The contract screen", () => {
  it("links nowhere near the old contract page", () => {
    for (const contractStatus of ["draft", "sent", "signed", "pending_approval", "changes_requested"]) {
      const status = contractStatus === "draft" ? "ready" : contractStatus;
      expect(render({ contractStatus, initialStatus: status })).not.toMatch(/\/deals\/d1\/contract/);
    }
    expect(render({ trashed: true })).not.toMatch(/\/deals\/d1\/contract/);
  });

  it("goes back to the lead on the call the deal came from", () => {
    const html = render({
      phoneCall: { id: "pc1", status: "processed", source: "phone", startedAt: "2026-11-16T10:00:00.000Z", endedAt: "2026-11-16T10:20:00.000Z", transcript: "", personName: "Dana Ruiz", personSub: null },
    });
    expect(html).toContain('href="/leads/l1?call=pc1"');
  });

  it("says when the client viewed it only while it's waiting on them", () => {
    expect(render({ contractStatus: "sent", initialStatus: "sent", contractViewedAt: viewedAgo })).toContain("Viewed");
    expect(render({ contractStatus: "partially_signed", initialStatus: "sent", contractViewedAt: viewedAgo })).toContain("Viewed");
    for (const contractStatus of ["signed", "not_signed", "draft", "changes_requested"]) {
      expect(render({ contractStatus, initialStatus: contractStatus === "not_signed" ? "sent" : contractStatus, contractViewedAt: viewedAgo })).not.toContain("Viewed");
    }
    expect(render({ contractStatus: "sent", initialStatus: "sent", contractExpired: true, contractViewedAt: viewedAgo })).not.toContain("Viewed");
  });

  it("offers the sign link while a SealMe contract is out, and not for DocuSign", () => {
    const sent = render({ contractStatus: "sent", initialStatus: "sent", contractDeliveryMethod: "sealme" });
    expect(sent).toContain("Waiting for Dana to sign");
    expect(sent).toContain("Copy sign link");
    expect(sent).not.toContain("Open the contract");
    expect(render({ contractStatus: "sent", initialStatus: "sent", contractDeliveryMethod: "docusign" })).not.toContain("Copy sign link");
    expect(render({ contractStatus: "sent", initialStatus: "sent", contractDeliveryMethod: "sealme", contractExpired: true })).not.toContain("Copy sign link");
  });

  it("says the client hasn't opened it only where SealMe can tell", () => {
    expect(render({ contractStatus: "sent", initialStatus: "sent", contractDeliveryMethod: "sealme" })).toContain("They haven&#x27;t opened it yet.");
    expect(render({ contractStatus: "sent", initialStatus: "sent", contractDeliveryMethod: "sealme", contractViewedAt: viewedAgo })).toContain("They opened it 5d ago.");
    const docusign = render({ contractStatus: "sent", initialStatus: "sent", contractDeliveryMethod: "docusign" });
    expect(docusign).toContain("Waiting for Dana to sign");
    expect(docusign).toContain("Sent through DocuSign.");
    expect(docusign).not.toContain("opened it");
  });

  it("names who still has to sign once the client did", () => {
    const html = render({ contractStatus: "partially_signed", initialStatus: "sent", contractDeliveryMethod: "sealme", contractSignerName: "Dana Ruiz", pendingSigners: [{ name: "Sam Lee", role: "Legal" }] });
    expect(html).toContain("Signed by Dana Ruiz");
    expect(html).toContain("Waiting on Sam Lee (Legal).");
    expect(html).toContain("Copy sign link");
  });

  it("puts the client's comments on the paper and points the rep to them", () => {
    const html = render({
      contractStatus: "changes_requested",
      initialStatus: "changes_requested",
      changesRequestedBy: { by: "client", name: null },
      clauseComments: [{ id: "c1", clauseTitle: "Fees", comment: "Can we do $4,000?", fromName: "Dana Ruiz", createdAt: "2026-11-15T10:00:00.000Z" }],
    });
    expect(html).toContain("Make the requested changes");
    expect(html).toContain("Their comments are under the clauses.");
    expect(html).toContain("Show the comment");
    expect(html).toContain("<b>Dana Ruiz:</b> Can we do $4,000?");
    // Show the comment moves focus to it.
    expect(html).toContain('data-client-comment="" tabindex="-1"');
    // Sent back with changes: the main button sends it again.
    expect(html).toContain(">Send again</span>");
    // Once in the work paper only, never in the preview.
    expect(html.match(/Can we do \$4,000\?/g)).toHaveLength(1);
  });

  it("shows the renewal under the next step on a signed contract", () => {
    const html = render({
      contractStatus: "signed",
      initialStatus: "signed",
      contractSignerName: "Dana Ruiz",
      renewal: { date: "2027-11-16T00:00:00.000Z", autoRenews: true, note: null },
      startRenewalAction: async () => {},
    });
    expect(html).toContain("Signed by Dana Ruiz.");
    expect(html).toContain("Renewal");
    expect(html).toContain("Auto-renews");
    expect(html).toContain("Start renewal");
    expect(html.indexOf("Renewal")).toBeGreaterThan(html.indexOf("Signed by Dana Ruiz."));
    // The renewal is still to do, so the step doesn't say nothing is left.
    expect(html).not.toContain("Nothing left to do");
    expect(render({ contractStatus: "signed", initialStatus: "signed", contractSignerName: "Dana Ruiz" })).toContain("Signed by Dana Ruiz. Nothing left to do on this deal.");
    expect(render({ contractStatus: "sent", initialStatus: "sent", renewal: { date: "2027-11-16T00:00:00.000Z", autoRenews: true, note: null } })).not.toContain("Start renewal");
  });

  it("keeps Export audit trail under More, for workspace admins only", () => {
    expect(render({ canExportAuditTrail: true })).toContain("Export audit trail");
    expect(render({ canExportAuditTrail: false })).not.toContain("Export audit trail");
  });

  it("offers the PDF next to Restore in the trash", () => {
    const html = render({ trashed: true });
    expect(html).toContain("In the trash");
    expect(html).toContain("Download PDF");
  });

  it("waits on approval without a way off the screen", () => {
    const html = render({ contractStatus: "pending_approval", initialStatus: "pending_approval" });
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("It goes to Dana as soon as it&#x27;s approved.");
  });
});
