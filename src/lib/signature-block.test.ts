import { describe, expect, it } from "vitest";
import { findSignatureBlocks, markSignatureBlocks } from "@/lib/signature-block";
import { buildClauses, listFields, type Clause, type ReviewClause } from "@/lib/template-fields";

// What's left of the contract once the signature block is taken out.
function withoutBlock(clauses: Clause[]): Clause[] {
  const review: ReviewClause[] = clauses.map((c) => ({ title: c.title, segments: [{ kind: "text", text: c.body }] }));
  return buildClauses(markSignatureBlocks(review, findSignatureBlocks(clauses)), new Set(), { dropSignature: true });
}

const TERMS = { title: "Fees", body: "Client shall pay Agency a monthly fee of $5,000, invoiced on the first business day of each month and due net 15." };

describe("findSignatureBlocks", () => {
  it("takes the IN WITNESS sentence and the signature lines at the end of the last clause", () => {
    const clauses = [
      TERMS,
      {
        title: "General",
        body: "This Agreement may be executed in counterparts.\n\nIN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date.\n\nBETA MEDIA LLC\nBy: ______________________\nName: John Roe\nTitle: Chief Executive Officer\n\nACME INC.\nBy: ______________________\nName: ______________________\nTitle: ______________________\nDate: ______________________",
      },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "General", body: "This Agreement may be executed in counterparts." }]);
  });

  it("finds the same block when the clause was run onto one line", () => {
    const clauses = [
      TERMS,
      {
        title: "General",
        body: "This Agreement may be executed in counterparts. IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date. BETA MEDIA LLC By: ______________ Name: John Roe Title: Chief Executive Officer ACME INC. By: ______________ Name: ______________ Title: ______________ Date: ______________",
      },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "General", body: "This Agreement may be executed in counterparts." }]);
  });

  it("takes clauses headed by the party names, and the IN WITNESS sentence before them", () => {
    const clauses = [
      TERMS,
      { title: "MISCELLANEOUS", body: "This Agreement is the entire agreement of the parties.\n\nIN WITNESS WHEREOF, the parties have signed this Agreement as of the date first written above." },
      { title: "BETA MEDIA LLC", body: "By: ____________________\nName: John Roe\nTitle: CEO" },
      { title: "ACME INC.", body: "By: ____________________\nName: ____________________\nTitle: ____________________" },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "MISCELLANEOUS", body: "This Agreement is the entire agreement of the parties." }]);
  });

  it("drops a clause called Signatures, title and all", () => {
    const clauses = [TERMS, { title: "Signatures", body: "CLIENT\nSignature: ____________________\nName: ____________________\nDate: ____________________\n\nAGENCY\nSignature: ____________________\nName: John Roe\nDate: ____________________" }];
    expect(withoutBlock(clauses)).toEqual([TERMS]);
  });

  it("stops before an exhibit that follows the signatures", () => {
    const clauses = [
      {
        title: "General",
        body: "This Agreement may be executed in counterparts. IN WITNESS WHEREOF, the parties have executed this Agreement. BETA MEDIA LLC By: ______________ Name: John Roe Title: CEO ACME INC. By: ______________ Name: ______________ Title: ______________ EXHIBIT A STATEMENT OF WORK This SOW describes the paid social services Agency will provide to Client during the Term.",
      },
    ];
    expect(withoutBlock(clauses)).toEqual([
      { title: "General", body: "This Agreement may be executed in counterparts. EXHIBIT A STATEMENT OF WORK This SOW describes the paid social services Agency will provide to Client during the Term." },
    ]);
  });

  it("keeps the block's last short lines when the clause ends there, and an executed copy's typed signature", () => {
    const clauses = [TERMS, { title: "Acceptance", body: "The parties have executed this Agreement as of the dates below.\n\nACME INC.\n/s/ Jane Doe\nJane Doe\nChief Financial Officer\nDate: October 21, 2026" }];
    expect(withoutBlock(clauses)).toEqual([TERMS]);
  });

  it("takes an Agreed and accepted block with signature and date blanks", () => {
    const clauses = [TERMS, { title: "Next Steps", body: "We look forward to working with you.\n\nAgreed and accepted:\nClient Signature: ____________________ Date: ____________\nAgency Signature: ____________________ Date: ____________" }];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "Next Steps", body: "We look forward to working with you." }]);
  });

  it("takes a bare signature line with the name and title under it", () => {
    const clauses = [TERMS, { title: "Term", body: "This Agreement starts on the Effective Date and runs for twelve (12) months.\n\nACME INC.\n\n______________________________\nName: Jane Doe\nTitle: CFO" }];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "Term", body: "This Agreement starts on the Effective Date and runs for twelve (12) months." }]);
  });

  it("takes the name and title lines above a signature line that comes last", () => {
    const clauses = [TERMS, { title: "Term", body: "This Agreement runs for twelve (12) months.\n\nCLIENT\nName: ____________________\nTitle: ____________________\nSignature: ____________________\nDate: ____________________" }];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "Term", body: "This Agreement runs for twelve (12) months." }]);
  });

  it("takes a signature page note and a two-column block", () => {
    const clauses = [
      TERMS,
      {
        title: "Entire Agreement",
        body: "This Agreement is the entire agreement between the parties.\n\n[Signature page follows]\n\nBETA MEDIA LLC ACME INC.\nBy: ____________ By: ____________\nName: John Roe Name: ____________\nTitle: CEO Title: ____________",
      },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "Entire Agreement", body: "This Agreement is the entire agreement between the parties." }]);
  });

  it("takes a DocuSign signature", () => {
    const clauses = [TERMS, { title: "Counterparts", body: "Signatures may be electronic.\n\nACME INC.\nDocuSigned by:\nJane Doe\n4F3A2B1C9D8E\nJane Doe, CFO\nDate: 10/21/2026" }];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "Counterparts", body: "Signatures may be electronic." }]);
  });

  it("takes a Signatures clause that only says who signs, and leaves one about how signing works", () => {
    const named = [TERMS, { title: "Signatures", body: "For Agency: Acme Growth Partners LLC, by Jill Roe, Managing Director.\nFor Client: Beta Media Inc., by Mark Hall, Chief Financial Officer." }];
    expect(withoutBlock(named)).toEqual([TERMS]);
    const terms = [TERMS, { title: "Signatures", body: "Each party agrees that electronic signatures are binding and that signed copies may be exchanged by email." }];
    expect(findSignatureBlocks(terms)).toEqual([]);
  });

  it("leaves a proposal's Prepared by line alone", () => {
    const clauses = [{ title: "Proposal", body: "Paid Social Proposal\nPrepared by: Beta Media\nPrepared for: Acme Inc.\nDate: November 1, 2026" }, TERMS];
    expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("leaves an order form's client details alone", () => {
    const clauses = [{ title: "Order Form", body: "Customer Information\nCompany: ____________________\nName: ____________________\nTitle: ____________________\nEmail: ____________________\nBilling Address: ____________________" }, TERMS];
    expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("leaves a notices clause alone", () => {
    const clauses = [TERMS, { title: "Notices", body: "Notices to Client go to Acme Inc., Attn: Jane Doe, Title: CFO, Email: jane@acme.com. Notices to Agency go to Beta Media LLC, Attn: John Roe, Email: john@betamedia.example. Notices may be delivered by: (a) hand; (b) courier; or (c) email." }];
    expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("leaves a clause about electronic signatures alone", () => {
    const clauses = [TERMS, { title: "Electronic Signatures", body: "Signature: Each party agrees that electronic signatures are as binding as handwritten ones. Signed copies may be delivered by email." }];
    expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("leaves an IN WITNESS sentence with nothing to sign on", () => {
    const clauses = [TERMS, { title: "General", body: "IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date." }];
    expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("leaves a heading after the block with the paragraph it heads", () => {
    const clauses = [
      { title: "Agreement", body: "IN WITNESS WHEREOF, the parties have signed below.\nACME INC.\nBy: ____________\nName: ____________\nTitle: ____________\nPayment Schedule\nThe fee is invoiced monthly in advance and paid by bank transfer within fifteen days of the invoice date." },
    ];
    expect(withoutBlock(clauses)).toEqual([{ title: "Agreement", body: "Payment Schedule\nThe fee is invoiced monthly in advance and paid by bank transfer within fifteen days of the invoice date." }]);
  });

  it("takes an e-signature audit trail after the block through to the end", () => {
    const clauses = [
      TERMS,
      { title: "General", body: "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nACME INC.\nBy: /s/ Jane Doe\nName: Jane Doe\nDate: 10/15/2026\n\nAudit trail\nDocument ID: 3f2a9c1e0b7d4e6f\nStatus: Signed\nViewed by Jane Doe (jane@acme.com) IP: 104.28.9.17" },
      { title: "Signer Events", body: "Signed by Jane Doe (jane@acme.com) IP: 104.28.9.17\nThe document has been completed." },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS]);
  });

  it("leaves notice addresses right above the block", () => {
    const clauses = [
      TERMS,
      { title: "Notices", body: "Notices go to:\nAgency: Beta Media LLC, 100 Main Street, Austin, TX 78701\nClient: Acme Inc., 500 Oak Avenue, Austin, TX 78701\n\nBETA MEDIA LLC\nBy: ____________\nName: John Roe" },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "Notices", body: "Notices go to:\nAgency: Beta Media LLC, 100 Main Street, Austin, TX 78701\nClient: Acme Inc., 500 Oak Avenue, Austin, TX 78701" }]);
  });

  it("leaves a contacts list and a billing email after the block", () => {
    const contacts = "Client Project Lead\nName: Jane Doe\nTitle: VP Marketing\nEmail: jane@acme.com";
    const clauses = [TERMS, { title: "General", body: `IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nACME INC.\nBy: ____________\nName: ____________\nDate: ____________\n\n${contacts}` }];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "General", body: contacts }]);
    const billing = [TERMS, { title: "General", body: "ACME INC.\nBy: ____________\nTitle: ____________\nDate: ____________\nEmail: ap@acme.com\nPO Number: 4500012345" }];
    expect(withoutBlock(billing)).toEqual([TERMS, { title: "General", body: "Email: ap@acme.com\nPO Number: 4500012345" }]);
  });

  it("leaves a proposal's Approved By header with the whole proposal under it", () => {
    const clauses = [
      { title: "Introduction", body: "CONTENT MARKETING PROPOSAL\nPrepared By: Beta Media LLC\nApproved By: John Roe\nDate: November 1, 2026" },
      { title: "Scope", body: "Beta Media will write eight articles per month for Acme's blog." },
      TERMS,
    ];
    expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("takes page footers and PDF page markers inside the block, and the label after a running header", () => {
    const clauses = [
      TERMS,
      {
        title: "General",
        body: "IN WITNESS WHEREOF, the parties have executed this Agreement. BETA MEDIA LLC By: __________ -- 3 of 4 -- Master Services Agreement Name: John Roe ACME INC. By: __________ Name: __________ Page 4 of 4 Master Services Agreement",
      },
      { title: "Services", body: "Agency will provide the Services in each SOW. Page 1 of 4 Master Services Agreement" },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS, clauses[2]]);
  });
});

describe("findSignatureBlocks: certificates, speed and forms", () => {
  // An order form signed at the top, then terms that talk about audit trails.
  const ORDER = { title: "Subscription", body: "Workspace Pro, 50 seats, $18,000 per year, invoiced annually in advance." };
  const ACCEPTED = "ACCEPTED AND AGREED:\n\nBLUE BETA FOODS, INC.\nSignature: ______________________\nName: ______________________\nTitle: ______________________\nDate: ______________________";
  const AFTER = [
    { title: "Service", body: "Provider hosts the e-signature service and keeps it available 99.9% of each month." },
    { title: "Fees", body: "Overage seats are billed at $30 per seat per month." },
    { title: "Governing Law", body: "Maine law governs this Order Form." },
  ];
  const auditTerm = (body: string) => [ORDER, { title: "Order Term", body: `Twelve months from the Order Effective Date.\n\n${ACCEPTED}\n\nTERMS AND CONDITIONS` }, AFTER[0], { title: "Audit Trail", body }, AFTER[1], AFTER[2]];

  it("keeps an Audit Trail term, and the fees and governing law after an acceptance block at the top", () => {
    for (const body of [
      "The Service records an audit trail for each envelope, showing when it was sent, viewed and signed, the signer's IP address: as logged, and a timestamp for each event. Customer may export the audit trail for 7 years.",
      // Even with an IP address and a Document ID in it, a term is sentences, not a certificate's lines.
      "The Service records an audit trail for each envelope, showing when it was sent, viewed and signed, the signer IP address: 10.0.0.1 style entries, the Document ID and a timestamp for each event. Customer may export the audit trail for 7 years.",
    ]) {
      const clauses = auditTerm(body);
      expect(withoutBlock(clauses)).toEqual([ORDER, { title: "Order Term", body: "Twelve months from the Order Effective Date.\n\nTERMS AND CONDITIONS" }, ...clauses.slice(2)]);
    }
  });

  it("keeps the terms after an acceptance block at the top when the clause runs onto one line", () => {
    const clauses = [
      ORDER,
      { title: "Order Term", body: `Twelve months from the Order Effective Date. ${ACCEPTED.replace(/\s+/g, " ")} TERMS AND CONDITIONS` },
      AFTER[0],
      { title: "Audit Trail", body: "The Service records an audit trail for each envelope, showing when it was sent, viewed and signed, the signer's IP address: as logged, and a timestamp for each event. Customer may export the audit trail for 7 years." },
      ...AFTER.slice(1),
    ];
    expect(withoutBlock(clauses)).toEqual([ORDER, { title: "Order Term", body: "Twelve months from the Order Effective Date. TERMS AND CONDITIONS" }, ...clauses.slice(2)]);
  });

  it("takes an audit trail with no block found before it, but only through the clause it starts in", () => {
    const report = "Final Audit Report 2026-03-04\nCreated: 2026-03-03\nStatus: Signed\nTransaction ID: CBJCHBCAABAAx7Rk2pQe9\nDocument e-signed by Jane Doe (jane@acme.com)\n2026-03-04 - 2:52:18 PM GMT\nAgreement completed.";
    const clauses = [TERMS, { title: "General", body: `This Agreement is governed by the laws of the State of Illinois.\n\n${report}` }, { title: "Event History", body: "Email viewed by Jane Doe\n2026-03-04 - 2:47:31 PM GMT" }];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "General", body: "This Agreement is governed by the laws of the State of Illinois." }, clauses[2]]);
  });

  it("stops a certificate after a block at a clause that holds terms", () => {
    const clauses = [
      TERMS,
      { title: "General", body: "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nACME INC.\nBy: /s/ Jane Doe\nName: Jane Doe\n\nCertificate Of Completion\nEnvelope Id: 7A3F9C2E1B4D4E8A Status: Completed\nSigner Events Signature Timestamp\nJane Doe Sent: 10/14/2026 | 11:03:02 AM" },
      { title: "Envelope Summary Events", body: "Envelope Sent Hashed/Encrypted 10/14/2026 | 11:03:02 AM" },
      { title: "Support", body: "Provider will answer support requests within one business day." },
    ];
    expect(withoutBlock(clauses)).toEqual([TERMS, clauses[3]]);
  });

  it("leaves the signature lines of a form in an exhibit, signed later when it's used", () => {
    const block = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nBETA SOFTWARE LABS, INC.\nBy: ____________\nName: ____________\nTitle: ____________";
    const form = "Project: ____________\nDeliverable: ____________\n\nClient confirms that the Deliverable identified above meets the acceptance criteria and is accepted.\n\nAccepted by: ____________\nTitle: ____________\nDate of Acceptance: ____________";
    const lines = [TERMS, { title: "Entire Agreement", body: `This Agreement is the entire agreement of the parties.\n\n${block}\n\nEXHIBIT C\nFORM OF ACCEPTANCE CERTIFICATE\n\n${form}` }];
    expect(withoutBlock(lines)).toEqual([TERMS, { title: "Entire Agreement", body: `This Agreement is the entire agreement of the parties.\n\nEXHIBIT C\nFORM OF ACCEPTANCE CERTIFICATE\n\n${form}` }]);
    const titled = [TERMS, { title: "Entire Agreement", body: `This Agreement is the entire agreement of the parties.\n\n${block}` }, { title: "EXHIBIT C - FORM OF ACCEPTANCE CERTIFICATE", body: form }];
    expect(withoutBlock(titled)).toEqual([TERMS, { title: "Entire Agreement", body: "This Agreement is the entire agreement of the parties." }, titled[2]]);
    const changeOrder = [TERMS, { title: "Schedule 2", body: "Form of Change Order\nChange requested: ____________\nFee impact: ____________\nApproved by Client: ____________\nName: ____________\nDate: ____________" }];
    expect(findSignatureBlocks(changeOrder)).toEqual([]);
  });

  it("takes the empty clauses a splitter made of the block's role and acceptance lines", () => {
    const general = { title: "GENERAL", body: "This Agreement is the entire agreement between the parties.\n\nIN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date." };
    const exhibit = { title: "EXHIBIT A - SCOPE OF SERVICES", body: "Agency will manage Client's paid search accounts." };
    const roles = [
      TERMS,
      general,
      { title: "AGENCY", body: "" },
      { title: "BETA MEDIA LLC", body: "By: ____________\n\nName: John Roe\n\nTitle: Managing Director" },
      { title: "CLIENT", body: "" },
      { title: "ACME INDUSTRIAL SUPPLY, INC", body: "By: ____________\n\nName: ____________\n\nTitle: ____________" },
      exhibit,
    ];
    expect(withoutBlock(roles)).toEqual([TERMS, { title: "GENERAL", body: "This Agreement is the entire agreement between the parties." }, exhibit]);
    const workOrder = { title: "WORK ORDER #1", body: "Agency will produce booth graphics for a fixed fee of $18,000, invoiced on signing." };
    const accepted = [TERMS, workOrder, { title: "ACCEPTED AND AGREED", body: "" }, { title: "ACME INDUSTRIAL SUPPLY, INC", body: "By: ____________\n\nName: ____________\n\nTitle: ____________" }];
    expect(withoutBlock(accepted)).toEqual([TERMS, workOrder]);
  });

  it("leaves an empty heading that doesn't head the block, or heads more than a block", () => {
    const block = { title: "ACME INC.", body: "By: ____________\nName: ____________\nTitle: ____________" };
    const exhibit = [TERMS, { title: "EXHIBIT B", body: "" }, block];
    expect(withoutBlock(exhibit)).toEqual([TERMS, { title: "EXHIBIT B", body: "" }]);
    const client = { title: "CLIENT", body: "" };
    const more = [TERMS, client, { title: "ACME INC.", body: "By: ____________\nName: ____________\nTitle: ____________\nBilling Email: ap@acme.com\nPO Number: 4500012345" }];
    expect(withoutBlock(more)).toEqual([TERMS, client, { title: "ACME INC.", body: "Billing Email: ap@acme.com\nPO Number: 4500012345" }]);
  });

  it("reads a 50,000-character clause on one line quickly", () => {
    const run = (unit: string) => {
      let body = "";
      for (let i = 0; body.length < 50000; i++) body += unit.replace("#", String(i)) + " ";
      return [{ title: "General", body: body.slice(0, 50000) }];
    };
    const inputs = [
      run("Name: Jane Doe # Title: CHIEF OFFICER ACME HOLDINGS LLC By: ____ Date: 10/1/2026 Email: a#@x.com"),
      run("The Client shall pay # dollars to BETA MEDIA LLC within thirty days. Notices go to Acme Inc., Attn: Legal."),
      run("Signature ____ Date ____ Name ____ (Printed Name) ____"),
      run("By: ____"),
      run("Jane Doe # 10/1/2026 Certificate of Completion Envelope ID: 3F2A9C7D1B4E5F60718293A4 Signed by Jane Doe IP: 10.0.0.1"),
      [{ title: "General", body: "a" + " ".repeat(49998) + "b" }],
      [{ title: "General", body: "a" + "\n".repeat(49998) + "b" }],
    ];
    findSignatureBlocks(inputs[0]); // warm up
    // The fastest of three tries, so a busy machine doesn't fail it.
    for (const clauses of inputs) {
      const times = [0, 1, 2].map(() => {
        const t = performance.now();
        findSignatureBlocks(clauses);
        return performance.now() - t;
      });
      expect(Math.min(...times)).toBeLessThan(300);
    }
  });
});

describe("findSignatureBlocks: more ways blocks are written", () => {
  const general = (body: string) => [TERMS, { title: "General", body }];
  const kept = general;

  it("takes the block after other ways of saying the parties sign", () => {
    const opening = "This Agreement is the entire agreement of the parties.";
    for (const [sentence, block] of [
      ["Agreed to by the parties as of the Effective Date:", "ACME FREIGHT CO.\n/s/ John Roe\nJohn Roe, CEO"],
      ["This Agreement has been entered into on the date stated at the beginning of it.", "GAMMA MARINE SERVICES LTD\nSignature: ____________\nName: John Roe"],
      ["The parties' authorized representatives approve this Agreement as of the Effective Date.", "ZETA INC.\nSignature: ____________\nName: ____________"],
      ["Signed by the Authorized Signatories of the parties.", "ACME INC.\nBy: ____________\nName: ____________"],
    ]) {
      expect(withoutBlock(general(`${opening}\n\n${sentence}\n\n${block}`))).toEqual(kept(opening));
    }
  });

  it("takes a blank company name right above the signature, and leaves a filled one in the order's details", () => {
    expect(withoutBlock([TERMS, { title: "Acceptance", body: "Company Name: ____________\nAuthorized Signature: ____________\nPrinted Name: ____________\nDate: ____________" }])).toEqual([TERMS]);
    const details = { title: "Order Form", body: "Customer Legal Name: Acme Corp\nBilling Contact: ap@acme.com\nSubscription: 50 seats" };
    expect(withoutBlock([details, TERMS, { title: "Signatures", body: "ACME CORP\nBy: ____________\nName: ____________" }])).toEqual([details, TERMS]);
  });

  it("takes the attestation and seal lines under a corporate signature", () => {
    const body = "IN WITNESS WHEREOF, the parties have executed this Agreement under seal.\n\nACME ROOFING CORP.\nBy: ____________\nName: John Roe\nTitle: President\n\nATTEST: ____________\nCorporate Secretary\n\n[CORPORATE SEAL]\n(SEAL)";
    expect(withoutBlock(general(body))).toEqual([TERMS]);
  });

  it("takes a deed's witness lines, and position and capacity lines", () => {
    const deed = "IN WITNESS WHEREOF, the parties have executed this Deed.\n\nSigned for and on behalf of GAMMA MARINE SERVICES LTD\nSignature: ____________\nName: John Roe\nPosition: Director\nWitnessed by:\nSignature of witness: ____________\nName of witness: Tim Cole\nOccupation: Solicitor";
    expect(withoutBlock(general(deed))).toEqual([TERMS]);
    const capacity = "This Agreement is the entire agreement of the parties.\n\nIN WITNESS WHEREOF, the parties have signed this Agreement.\n\nZETA INC.\nSignature: ____________\nName: ____________\nCapacity: ____________";
    expect(withoutBlock(general(capacity))).toEqual(kept("This Agreement is the entire agreement of the parties."));
  });

  it("takes party lines that start with For or Signed for and on behalf of", () => {
    const body = "This Agreement is the entire agreement of the parties.\n\nIN WITNESS WHEREOF, the parties have signed this Agreement.\n\nFor Beta Media LLC:\nSignature: ____________\nName: John Roe\n\nSigned for and on behalf of Acme Inc.\nSignature: ____________\nName: ____________";
    expect(withoutBlock(general(body))).toEqual(kept("This Agreement is the entire agreement of the parties."));
  });

  it("cuts a block run onto one line before a role in title case with a colon", () => {
    const body = "This Agreement is the entire agreement of the parties. SIGNATURES Customer: Zeta Inc. By: ____________ Name: ____________ Provider: Beta Labs LLC By: ____________ Name: John Roe";
    expect(withoutBlock(general(body))).toEqual(kept("This Agreement is the entire agreement of the parties."));
  });

  it("reads a label with a note in brackets", () => {
    const order = { title: "Change Order", body: "The change adds two dashboards for a fee of $4,000.\n\nApproved by (signature): ____________\nName (print): ____________\nDate: ____________" };
    expect(withoutBlock([TERMS, order])).toEqual([TERMS, { title: "Change Order", body: "The change adds two dashboards for a fee of $4,000." }]);
  });

  it("takes a request to sign run onto a term and leaves the term, but keeps a request with money in it", () => {
    const steps = { title: "Next Steps", body: "To accept this proposal, sign below. Work begins within ten business days of signature.\n\nClient Signature: ____________\nDate: ____________" };
    expect(withoutBlock([TERMS, steps])).toEqual([TERMS, { title: "Next Steps", body: "Work begins within ten business days of signature." }]);
    const deposit = { title: "Next Steps", body: "Please sign below; a deposit of $5,000 is due on signing.\n\nClient Signature: ____________\nDate: ____________" };
    expect(withoutBlock([TERMS, deposit])).toEqual([TERMS, { title: "Next Steps", body: "Please sign below; a deposit of $5,000 is due on signing." }]);
  });

  it("takes e-signature stamps run onto one line, the document's name and the audit report after them", () => {
    const body = "This Agreement may be signed in counterparts. Agreed to by the parties as of the Effective Date: BETA MEDIA LLC John Roe John Roe (Mar 3, 2026 10:14 PST) John Roe, Managing Partner ACME INC. Al Grey Al Grey (Mar 4, 2026 08:52 CST) Al Grey, Executive Director Services Agreement - Beta x Acme Final Audit Report 2026-03-04 Created: 2026-03-03 Status: Signed Transaction ID: CBJCHBCAABAAx7Rk2 Document e-signed by Al Grey (al@acme.example) 2026-03-04 - 2:52:18 PM GMT Agreement completed.";
    expect(withoutBlock(general(body))).toEqual(kept("This Agreement may be signed in counterparts."));
    // A name with a date in a sentence is part of the sentence.
    const sentence = "This change was approved by John Roe (March 3, 2026) and takes effect on the next invoice.";
    expect(withoutBlock(general(`${sentence} ACME INC. By: ____________ Name: ____________`))).toEqual(kept(sentence));
  });
});

describe("findSignatureBlocks: forms, references and lines in the terms", () => {
  const BLOCK = "IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date.\n\nDELTA ANALYTICS LLC\nBy: ____________\nName: Alex Smith\nTitle: Managing Partner\n\nACME BREWING CO.\nBy: ____________\nName: ____________\nTitle: ____________";
  const LAW = { title: "Governing Law", body: "This Agreement is governed by the laws of Oregon." };
  const ended = [TERMS, { title: "Governing Law", body: `${LAW.body}\n\n${BLOCK}` }];

  it("keeps a form in an exhibit whose heading the clause ran onto one line with its first field", () => {
    const form = "EXHIBIT C FORM OF WORK ORDER Work Order No.: ______ Scope: ____________ Fees: $________ Client Signature: ____________ Date: ________ Agency Signature: ____________ Date: ________";
    const clauses = [TERMS, { title: "Governing Law", body: `${LAW.body} ${BLOCK.replace(/\s+/g, " ")} ${form}` }];
    expect(withoutBlock(clauses)).toEqual([TERMS, { title: "Governing Law", body: `${LAW.body} ${form}` }]);
  });

  it("keeps a form whose first line names the document it is a form of", () => {
    for (const [title, first] of [
      ["EXHIBIT B - FORM OF PURCHASE ORDER", "Purchase Order No.: ____________"],
      ["SCHEDULE 3 - FORM OF STATEMENT OF WORK", "Statement of Work No.: ____________"],
    ]) {
      const form = { title, body: `${first}\nItems: ____________\nBuyer Signature: ____________ Date: ________\nSeller Signature: ____________ Date: ________` };
      expect(withoutBlock([...ended, form])).toEqual([TERMS, LAW, form]);
    }
    // A field named after a document in the middle of the form doesn't end it.
    const certificate = "EXHIBIT D\nFORM OF ACCEPTANCE CERTIFICATE\nProject: ____________\nPurchase Order No.: ____________\nClient confirms that the Deliverable meets its acceptance criteria.\nClient Representative Signature: ____________\nName: ____________\nDate: ________";
    expect(withoutBlock([TERMS, { title: "Governing Law", body: `${LAW.body}\n\n${BLOCK}\n\n${certificate}` }])).toEqual([TERMS, { title: "Governing Law", body: `${LAW.body}\n\n${certificate}` }]);
  });

  it("keeps a form to fill in after the contract's block, though its heading doesn't say form", () => {
    const timesheet = { title: "EXHIBIT E - MONTHLY TIMESHEET", body: "Contractor: ____________ Month: ________\nHours billed: ____ ____ ____ ____\nContractor Signature: ____________ Date: ________\nClient Approval: ____________ Date: ________" };
    expect(withoutBlock([...ended, timesheet])).toEqual([TERMS, LAW, timesheet]);
    const checklist = "EXHIBIT F - INSTALLATION CHECKLIST\nEquipment mounted and tested: [ ] Yes [ ] No\nStaff trained: [ ] Yes [ ] No\nChecked by: ____________ Date: ________\nClient Representative: ____________ Date: ________";
    expect(withoutBlock([TERMS, { title: "Governing Law", body: `${LAW.body}\n\n${BLOCK}\n\n${checklist}` }])).toEqual([TERMS, { title: "Governing Law", body: `${LAW.body}\n\n${checklist}` }]);
  });

  it("reads a reference to an exhibit inside a sentence as part of the sentence", () => {
    const acceptance = (tail: string) => ({ title: "Acceptance", body: `Client records acceptance on the delivery note as follows: Accepted by: ____________ Date: ________ A Deliverable not rejected within ten days is accepted${tail}` });
    const middle = [{ title: "Warranty", body: "Agency warrants each Deliverable for ninety (90) days and re-performs nonconforming work at no charge." }, { title: "Liability", body: "Neither party's liability exceeds the fees paid in the prior twelve (12) months." }];
    for (const tail of [" under Exhibit B.", " as set out in Schedule 2.", "."]) {
      const clauses = [TERMS, acceptance(tail), ...middle, ...ended.slice(1)];
      expect(withoutBlock(clauses)).toEqual([TERMS, acceptance(tail), ...middle, LAW]);
    }
    // Nor does one that names a form or a certificate keep the real block.
    for (const reference of ["Exhibit C (Acceptance Certificate).", "Schedule 4 (Form of Change Order)."]) {
      const milestones = { title: "Milestones", body: `Client confirms each milestone by signing a certificate substantially in the form of ${reference} Payment is due within thirty (30) days after.` };
      expect(withoutBlock([TERMS, milestones, ...ended.slice(1)])).toEqual([TERMS, milestones, LAW]);
    }
    // Nor a "Form of Payment" field in the order's details.
    const order = { title: "Order Form", body: "Customer: Acme Brewing Co.\nAnnual Fee: $24,000\nForm of Payment: ACH" };
    const signatures = { title: "Signatures", body: "CUSTOMER: Acme Brewing Co.\nBy: ____________\nName: ____________\nPROVIDER: Delta Analytics LLC\nBy: ____________\nName: ____________" };
    expect(withoutBlock([order, TERMS, signatures])).toEqual([order, TERMS]);
  });

  it("keeps a line to sign in the last terms when the real block still follows", () => {
    const inspection = { title: "Inspections", body: "Agency tests each unit in the presence of Client's engineer. Witnessed by: ____________ Date: ________ Results bind Client only when countersigned by its Quality Lead." };
    expect(withoutBlock([TERMS, inspection, ...ended.slice(1)])).toEqual([TERMS, inspection, LAW]);
    const personnel = { title: "Personnel", body: "Each technician signs this statement before site access: I have read the Site Rules. Technician Signature: ____________ Printed Name: ____________ Date: ________ Agency keeps the signed statements on file." };
    expect(withoutBlock([TERMS, personnel, ...ended.slice(1)])).toEqual([TERMS, personnel, LAW]);
  });

  it("keeps a sentence about signing that also sets terms", () => {
    const sworn = "IN WITNESS WHEREOF, the parties have executed this Agreement, which shall become effective only upon Agency's receipt of the onboarding fee of $2,500.";
    expect(withoutBlock([TERMS, { title: "General", body: `${sworn}\n\nDELTA ANALYTICS LLC\nBy: ____________\nName: Alex Smith` }])).toEqual([TERMS, { title: "General", body: sworn }]);
    const incorporated = "By signing below, Customer accepts the Platform Terms at delta.example/terms and the Security Addendum, which are incorporated into this Order Form by reference.";
    const order = { title: "Order Form", body: `Plan: Growth, 40 seats\nAnnual Fee: $36,000\n\n${incorporated}\n\nCustomer Signature: ____________\nName: ____________\nDate: ________` };
    expect(withoutBlock([order])).toEqual([{ title: "Order Form", body: `Plan: Growth, 40 seats\nAnnual Fee: $36,000\n\n${incorporated}` }]);
    const deadline = "Please sign below and return this proposal by November 30, 2026; these rates are held until then.";
    expect(withoutBlock([TERMS, { title: "Acceptance", body: `${deadline}\n\nClient: ____________ Date: ________` }])).toEqual([TERMS, { title: "Acceptance", body: deadline }]);
  });

  it("keeps a sentence that points to a page, and contacts listed right under the block", () => {
    const pointer = "Late payment charges are set out on page 2.";
    expect(withoutBlock([TERMS, { title: "Signatures", body: `IN WITNESS WHEREOF, the parties have executed this Agreement.\nDELTA ANALYTICS LLC\nBy: ____________\nName: Alex Smith\nDate: ________\n${pointer}` }])).toEqual([TERMS, { title: "Signatures", body: pointer }]);
    const contact = "Name: Leo King\nTitle: Accounts Payable Lead\nEmail: ap@acmebrewing.example\nPhone: (503) 555-0142";
    expect(withoutBlock([TERMS, { title: "General", body: `${BLOCK}\nDate: ________\n${contact}` }])).toEqual([TERMS, { title: "General", body: contact }]);
  });
});

describe("findSignatureBlocks: what is and isn't an e-signature certificate", () => {
  const block = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nDELTA ANALYTICS LLC\nBy: /s/ Alex Smith\nName: Alex Smith";

  it("keeps terms and lists that name a certificate's fields without their values", () => {
    for (const clause of [
      { title: "Reporting", body: "AUDIT TRAIL REPORT\nEnvelope ID\nSigner IP address\nTimestamp of each event (UTC)\nSent monthly to Client's compliance team." },
      { title: "Audit Trail", body: "Retention: seven (7) years from completion\nFields kept: envelope ID, signer IP address, timestamps of each event\nExport: CSV or PDF on request" },
      { title: "Signature Certificate", body: "Signature Certificate requirements: Envelope ID and signer IP address: 10.0.0.1 style entries are retained by Agency for seven years." },
    ]) {
      expect(findSignatureBlocks([TERMS, clause, { title: "Notices", body: "Notices go by email." }])).toEqual([]);
    }
    // A document's own revision table, with a document number, is no trail either.
    const sow = { title: "Statement of Work", body: "Project: Data Warehouse\nDocument History\nDocument ID: SOW-2026-207\nVersion 1.0 09/02/2026 First draft (Alex Smith)\nVersion 1.1 09/16/2026 Fees revised, signed 09/16/2026 at 15:10" };
    expect(findSignatureBlocks([sow, TERMS])).toEqual([]);
  });

  it("stops a certificate at the heading of the next section", () => {
    const after = "SUPPORT\nSupport hours: 7:00 - 19:00 PT, weekdays\nUrgent response: 2 hours\n\nCONTACTS\nLevel 1: help@delta.example\nLevel 2: Alex Smith, (503) 555-0199";
    const cert = "CERTIFICATE OF COMPLETION\nEnvelope Id: 4B7E2C9A1D3F5E6A8B0C2D4E6F8A1B3C\nSigner: Eva Stone, IP Address: 198.51.100.23, Signed: 5/12/2026 3:41:07 PM";
    expect(withoutBlock([TERMS, { title: "Signatures", body: `${block}\n\n${cert}\n\n${after}` }])).toEqual([TERMS, { title: "Signatures", body: after }]);
  });

  it("takes DocuSign's consent text at the end of its certificate", () => {
    const cert = "Certificate Of Completion\nEnvelope Id: 4B7E2C9A1D3F5E6A8B0C2D4E6F8A1B3C Status: Completed\nSigner Events Signature Timestamp\nEva Stone Sent: 5/12/2026 | 3:38:02 PM\nElectronic Record and Signature Disclosure\nFrom time to time, Delta Analytics LLC may be required by law to provide you certain written notices electronically.\nYou may request paper copies at any time.";
    expect(withoutBlock([TERMS, { title: "General", body: `${block}\n\n${cert}` }])).toEqual([TERMS]);
    const titled = [TERMS, { title: "General", body: `${block}\n\n${cert.split("\nElectronic")[0]}` }, { title: "ELECTRONIC RECORD AND SIGNATURE DISCLOSURE", body: "From time to time, Delta Analytics LLC may send you notices electronically." }, { title: "Getting paper copies", body: "You may request paper copies of any record at any time." }];
    expect(withoutBlock(titled)).toEqual([TERMS]);
  });
});

describe("findSignatureBlocks: unlabeled signers, sign-off headings and other layouts", () => {
  const trail = "AUDIT TRAIL\nDocument ID: 9d2e7b41c6a85f30e1b4d7c29a6f8e05\nSent for signature to Chris Green and Sam Lee\nSigned by Chris Green IP: 203.0.113.9 08 / 14 / 2026 09:12:40 UTC\nSigned by Sam Lee IP: 198.51.100.61 08 / 14 / 2026 11:05:02 UTC";
  const whole = { title: "General", body: "This Agreement is the whole agreement of the parties." };

  it("takes the names, titles and dates right over a certificate that names the signers", () => {
    const rows = "Acme Bakery          Acme Print Shop\nChris Green                Sam Lee\nOwner                     Manager\n08 / 14 / 2026            08 / 14 / 2026";
    expect(withoutBlock([TERMS, { title: "General", body: `${whole.body}\n\n${rows}\n\n${trail}` }])).toEqual([TERMS, whole]);
    // A splitter that runs the clause onto one line leaves the party and signer names in one run.
    const runOn = `${whole.body} ${rows.replace(/\s+/g, " ")} ${trail.replace(/\n/g, " ")}`;
    expect(withoutBlock([TERMS, { title: "General", body: runOn }])).toEqual([TERMS, whole]);
  });

  it("leaves a schedule's dates over a certificate that doesn't name them", () => {
    const certificate = "Certificate of Completion\nEnvelope ID: 3F2A9C7D1B4E5F60718293A4B5C6D7E8\nStatus: Completed\nSigner Events\nJane Doe jane@acme.example Signed: 09/03/2026 10:14:22 AM IP Address: 198.51.100.7";
    const schedule = "Key Dates\nKickoff Meeting\n09/10/2026\nGo Live\n10/15/2026";
    const term = "Start Date End Date\n09/01/2026 08/31/2027";
    for (const lines of [schedule, term]) {
      const left = withoutBlock([TERMS, { title: "Schedule 1", body: `${lines}\n\n${certificate}` }]);
      expect(left).toEqual([TERMS, { title: "Schedule 1", body: lines }]);
    }
  });

  it("takes a sign-off heading between two blocks and leaves the sentence under it", () => {
    const kept = { title: "Engagement", body: "We will review the books of Sigma Foods, Inc. for 2026.\n\nThis letter correctly sets forth our understanding." };
    const letter = "We will review the books of Sigma Foods, Inc. for 2026.\n\nVery truly yours,\n\n/s/ Pat Brown\nPat Brown, CPA, Partner\nLind & Osei CPAs, LLP\n\nRESPONSE:\nThis letter correctly sets forth our understanding.\nManagement signature: ______________________\nTitle: ______________________\nDate: ______________________";
    expect(withoutBlock([TERMS, { title: "Engagement", body: letter }])).toEqual([TERMS, kept]);
    const runOn = withoutBlock([TERMS, { title: "Engagement", body: letter.replace(/\s+/g, " ") }]);
    expect(runOn).toEqual([TERMS, { ...kept, body: kept.body.replace(/\s+/g, " ") }]);
    // A heading in capitals that starts a term is no sign-off.
    const acceptance = { title: "Acceptance", body: "ACCEPTANCE: Client accepts each deliverable within 10 days of delivery unless it gives written notice of a defect." };
    expect(findSignatureBlocks([TERMS, acceptance])).toEqual([]);
  });

  it("takes a UK block with dotted lines and the witness's lines", () => {
    const body = "Signed by Max Field ..................................\nfor and on behalf of ACME TRADING LIMITED\nDirector\n\nin the presence of:\nWitness signature ..................................\nWitness name: Ann White\nWitness address: 4 Elm Lane, Bath\nWitness occupation: Solicitor";
    expect(withoutBlock([TERMS, { title: "Execution", body }])).toEqual([TERMS]);
  });

  it("takes blocks with parties named in other ways", () => {
    const sworn = "IN WITNESS WHEREOF, the parties have signed this Agreement.\n\n";
    for (const body of [
      "IN WITNESS WHEREOF, the parties have executed this Agreement under seal.\n\nBETA RIVER HOLDINGS, INC.\nBy: ____________________\nName: Paul Black\nTitle: President\n\nATTEST:\n____________________\nSecretary\n\n[CORPORATE SEAL]",
      "AGREED AND ACCEPTED as of the date first written above:\n\nCLIENT\n____________________\nAuthorized Signatory\n\nAGENCY\n____________________\nAuthorized Signatory",
      `${sworn}For Supplier: Beta Components Ltd\nSignature: ____________________\nName: Ivy Moss\nDesignation: Sales Director\nPlace: Pune\nDate: ____________________`,
      `${sworn}For Acme Nordic AS:                    For Beta Supply LLC:\n____________________                  ____________________\nName: Kim Ward                     Name: Ben Hill\nTitle: general manager                Title: chief executive`,
      `${sworn}AGENCY (as agent for Advertiser)\nSignature: ____________________\nName: ____________________`,
      `${sworn}BUYER: [BUYER LEGAL NAME]\nBy: ______________________\nName: ______________________\n\nSUPPLIER: [SUPPLIER LEGAL NAME]\nBy: ______________________\nName: ______________________`,
    ]) {
      expect(withoutBlock([TERMS, { title: "General", body }])).toEqual([TERMS]);
    }
  });

  it("takes the firm's name under a letter's signer", () => {
    const body = "Please call me with any questions.\n\nSincerely,\n\n/s/ Pat Brown\nPat Brown, CPA, Partner\nLind & Osei CPAs, LLP";
    expect(withoutBlock([TERMS, { title: "Closing", body }])).toEqual([TERMS, { title: "Closing", body: "Please call me with any questions." }]);
  });
});

describe("findSignatureBlocks: terms and details right next to a block", () => {
  const SIGNED = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nGAMMA HEALTH INC.\nBy: /s/ Mary Major\nName: Mary Major\nTitle: Chief Operating Officer\nDate: August 3, 2026";
  const BLANK = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nGAMMA HEALTH INC.\nBy: ____________\nName: ____________\nTitle: ____________";
  // The text left once the block is out, on one line, to look for what must stay.
  const left = (clauses: Clause[]) => withoutBlock(clauses).map((c) => `${c.title} ${c.body}`).join(" ").replace(/\s+/g, " ");
  // Each case as the splitter that keeps line breaks gives it, and as the one that runs a clause onto one line.
  const bothWays = (clauses: Clause[]) => [clauses, clauses.map((c) => ({ ...c, body: c.body.replace(/\s+/g, " ") }))];

  it("keeps bank details written as labels and values, with or without a block before them", () => {
    const bank = "Bank\nFirst Federal Bank\nAccount Name\nOmega Analytics LLC\nAccount Number\n58201937465012\nRouting Number\n321180379";
    expect(findSignatureBlocks([TERMS, { title: "Payment Details", body: bank }])).toEqual([]);
    // A table from a Word file, one cell to a paragraph.
    expect(findSignatureBlocks([TERMS, { title: "Payment Details", body: bank.replace(/\n/g, "\n\n") }])).toEqual([]);
    const after = withoutBlock([TERMS, { title: "General", body: SIGNED }, { title: "Payment Details", body: bank }]);
    expect(after).toEqual([TERMS, { title: "Payment Details", body: bank }]);
  });

  it("keeps a sentence about electronic signatures or counterparts right above the block", () => {
    for (const sentence of [
      "Electronically signed counterparts are originals for every purpose.",
      "Digitally signed copies carry the same weight as paper originals.",
      "Checked by Customer's controller, each statement becomes final after five (5) days.",
      "Signed on different days, this Agreement starts on the later of them.",
    ]) {
      for (const clauses of bothWays([TERMS, { title: "Execution", body: `Each party may sign through an e-signature service.\n${sentence}\n\n${BLANK}` }])) {
        expect(left(clauses)).toContain(sentence);
        expect(left(clauses)).not.toContain("GAMMA HEALTH INC.");
      }
    }
  });

  it("keeps a number or an IP address on its own line right above the block", () => {
    for (const [lead, value] of [
      ["Customer's purchase order number for this Agreement is:", "4500077120"],
      ["Wire payments to account number:", "58201937465012"],
      ["The licence key for the analytics module is:", "9C4E7A1B3D5F2E8A"],
      ["Customer reaches the portal only from its office network.", "IP Address: 203.0.113.81"],
    ]) {
      const clauses = [TERMS, { title: "Details", body: `${lead}\n${value}\n\n${BLANK}` }];
      expect(left(clauses)).toContain(value);
      expect(left(clauses)).not.toContain("GAMMA HEALTH INC.");
    }
  });

  it("keeps an audit trail term with an IP address in it, alone or in an annex after the block", () => {
    const term = { title: "Audit Trail", body: "Logged events: sign-in, sign-out, report export\nTimestamps: UTC, to the second\nOffice VPN egress IP: 198.51.100.230\nRetention: eighteen (18) months" };
    expect(findSignatureBlocks([TERMS, term, { title: "Notices", body: "Notices go by email." }])).toEqual([]);
    const annex = "ANNEX 2 - SECURITY CONTROLS\nAudit trail\nAdmin sessions recorded with timestamps\nJump host: IP 10.40.0.9 (admin access only)\nLog retention: 400 days";
    for (const clauses of bothWays([TERMS, { title: "General", body: `${SIGNED}\n\n${annex}` }])) {
      expect(left(clauses)).toContain("Jump host: IP 10.40.0.9 (admin access only) Log retention: 400 days");
      expect(left(clauses)).not.toContain("Mary Major");
    }
    // A clause after a certificate that lists an allowed IP address is terms too.
    const cert = "Certificate of Completion\nEnvelope Id: 2B4D6F8A0C1E3A5C7E9B1D3F5A7C9E2D\nStatus: Completed\nMary Major Signed: 8/3/2026 2:10:44 PM Using IP Address: 198.51.100.18";
    const access = { title: "Network Access", body: "Allowed IP: 203.0.113.70\nVPN required: Yes" };
    expect(withoutBlock([TERMS, { title: "General", body: `${SIGNED}\n\n${cert}` }, access])).toEqual([TERMS, access]);
  });

  it("keeps a table of key dates over a certificate whose dates differ, though it names the same person", () => {
    const dates = "Key Dates and Contacts\nProject Kickoff\nSeptember 8, 2026\nCustomer Sponsor\nMary Major";
    const cert = "Certificate Of Completion\nEnvelope Id: 2B4D6F8A0C1E3A5C7E9B1D3F5A7C9E2D\nStatus: Completed\nSigner Events\nMary Major Signed: 08/03/2026 2:10:44 PM Using IP Address: 198.51.100.18";
    expect(withoutBlock([TERMS, { title: "Schedule 1", body: `${dates}\n\n${cert}` }])).toEqual([TERMS, { title: "Schedule 1", body: dates }]);
  });

  it("keeps a signing sentence that commits, replaces another document, governs or sets a deadline", () => {
    for (const sentence of [
      "INTENDING TO BE LEGALLY BOUND, Customer agrees to buy the minimum volume of 200 licences per year set out in the Order.",
      "IN WITNESS WHEREOF, the parties have executed this Agreement, which supersedes the term sheet between them dated May 4, 2026.",
      "IN WITNESS WHEREOF, the parties have executed this Agreement and agree that it governs every Order placed after today.",
      "Accepted and agreed; these prices hold for forty-five (45) days from the quote date.",
      "Accepted, subject to credit approval:",
    ]) {
      const clauses = [TERMS, { title: "Acceptance", body: `${sentence}\n\nGAMMA HEALTH INC.\nBy: ____________\nName: ____________` }];
      expect(left(clauses)).toContain(sentence);
      expect(left(clauses)).not.toContain("By: ____");
    }
  });

  it("keeps the lines of a form in an exhibit after a signed block, and of a first-person form after a blank one", () => {
    const waiver = "EXHIBIT D\nCONDITIONAL LIEN WAIVER\nOn receipt of $__________ for work through __________, the undersigned waives its lien rights for that work.\nCONTRACTOR: ____________\nBy: ____________\nName: ____________\nDate: ____________";
    const statement = "EXHIBIT B\nSTAFF CONFIDENTIALITY STATEMENT\nI have read Section 7 of the Agreement and will keep Customer's data confidential.\nName: ____________\nSignature: ____________\nDate: ____________";
    for (const form of [waiver, statement]) {
      for (const clauses of bothWays([TERMS, { title: "General", body: `${SIGNED}\n\n${form}` }])) {
        expect(left(clauses)).toContain(form.split("\n").slice(-3).join(" "));
        expect(left(clauses)).not.toContain("Mary Major");
      }
    }
    // A blank template: the contract's own block goes, the statement each employee signs stays.
    const blank = left([TERMS, { title: "General", body: `${BLANK}\n\n${statement}` }]);
    expect(blank).toContain("Name: ____________ Signature: ____________ Date: ____________");
    expect(blank).not.toContain("GAMMA HEALTH INC.");
  });

  it("keeps the lines to approve a change request, and a part the terms call a form, in a blank template", () => {
    const appendix = "APPENDIX 1 - CHANGE REQUEST\nRequest No.: ____________\nWhat changes: ____________\nEffect on fees: ____________\nCustomer Approval: ____________ Date: ____________\nProvider Approval: ____________ Date: ____________";
    const sow = [{ title: "Scope", body: "Provider delivers the reporting services in the project plan." }, { title: "Changes", body: `Either party may ask for a change on the form in Appendix 1; no change binds until both approve it.\n\n${appendix}` }];
    expect(findSignatureBlocks(sow)).toEqual([]);
    // A part the terms call a form stays even with no fields to fill in,
    // while the agreement's own block before it still goes.
    const schedule = "SCHEDULE 2 - DELIVERABLE SIGN-OFF\nThe deliverable listed in the covering note meets the agreed criteria.\nApproved by Customer: ____________ Date: ____________\nApproved by Provider: ____________ Date: ____________";
    const own = "GAMMA HEALTH INC.\nBy: ____________\nName: ____________";
    for (const clauses of bothWays([TERMS, { title: "Acceptance", body: "Customer accepts each deliverable by signing a sign-off sheet in the form attached as Schedule 2." }, { title: "Signatures", body: `${own}\n\n${schedule}` }])) {
      expect(left(clauses)).toContain("Approved by Customer: ____________ Date: ____________");
      expect(left(clauses)).not.toContain("GAMMA HEALTH INC.");
    }
  });

  it("keeps a party's address under its signature when the terms send notices there", () => {
    const notices = { title: "Notices", body: "Notices go to each party at the address printed under its signature." };
    const block = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nCUSTOMER: GAMMA HEALTH INC.\nBy: ____________\nName: Mary Major\nTitle: Chief Operating Officer\nAddress: 77 Oak Road, Springfield, IL 62701\nPhone: (207) 555-0134";
    for (const clauses of bothWays([TERMS, notices, { title: "General", body: block }])) {
      expect(left(clauses)).toContain("Address: 77 Oak Road, Springfield, IL 62701 Phone: (207) 555-0134");
      expect(left(clauses)).not.toContain("Mary Major");
    }
  });

  it("keeps a billing contact listed under a block whose signer is named on the signature line", () => {
    const contact = "Name: Nora Banks\nTitle: Accounts Payable Lead\nEmail: ap@gamma.example";
    const block = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nGAMMA HEALTH INC.\nBy: /s/ Mary Major\nIts: Chief Operating Officer\nDate: August 3, 2026";
    for (const clauses of bothWays([TERMS, { title: "General", body: `${block}\n${contact}` }])) {
      expect(left(clauses)).toContain(contact.replace(/\n/g, " "));
      expect(left(clauses)).not.toContain("Its: Chief Operating Officer");
    }
    // The signer's own name printed again after the date is still the block.
    const again = withoutBlock([TERMS, { title: "General", body: "GAMMA HEALTH INC.\nBy: /s/ Mary Major\nDate: August 3, 2026\nName: Mary Major\nTitle: Chief Operating Officer" }]);
    expect(again).toEqual([TERMS]);
  });

  it("keeps fields beside a date that nobody signs, settings about signing, and a firm named under a colon", () => {
    const office = "For Office Use Only\nCost Center: ____________ Date: ____________\nApproved Budget: $____________";
    expect(left([TERMS, { title: "General", body: `${SIGNED}\n\n${office}` }])).toContain("Cost Center: ____________ Date: ____________");
    const details = { title: "Order Details", body: "Customer: Gamma Health Inc.\nElectronic Signature: Permitted\nDate: August 1, 2026" };
    for (const clauses of bothWays([TERMS, details])) expect(findSignatureBlocks(clauses)).toEqual([]);
    const copy = "Notices to Customer go to 77 Oak Road, Springfield, IL 62701, with a copy to its outside counsel:\nDOE & ROE LLP";
    expect(withoutBlock([TERMS, { title: "Notices", body: `${copy}\n\nGAMMA HEALTH INC.\nBy: ____________\nName: ____________` }])).toEqual([TERMS, { title: "Notices", body: copy }]);
    // A party's own name as the label, on a row under a role's.
    expect(withoutBlock([TERMS, { title: "Approval", body: "Client: ____________ Date: ________\nOmega Analytics: ____________ Date: ________" }])).toEqual([TERMS]);
  });

  it("takes an acceptance block on a proposal's cover and leaves the sentence over its lines", () => {
    const cover = "PROPOSAL FOR CLINIC NETWORK UPGRADE\nPrepared for: Gamma Health Inc.\nPrepared by: Omega Analytics LLC\n\nPROPOSAL ACCEPTANCE\nGamma Health accepts this proposal and the Terms of Engagement in Section 4.\nSignature: ____________\nName: ____________\nTitle: ____________\nDate: ____________";
    const body = [
      { title: "Introduction", body: "Omega will replace the network switches at all three of the clinics." },
      { title: "Investment", body: "Fixed fee of $41,000, invoiced half at kickoff and half on completion." },
      { title: "Terms of Engagement", body: "Invoices are due within thirty days." },
    ];
    const kept = "PROPOSAL FOR CLINIC NETWORK UPGRADE\nPrepared for: Gamma Health Inc.\nPrepared by: Omega Analytics LLC\n\nGamma Health accepts this proposal and the Terms of Engagement in Section 4.";
    expect(withoutBlock([{ title: "Preamble", body: cover }, ...body])).toEqual([{ title: "Preamble", body: kept }, ...body]);
    // Lines to sign in the middle of the terms, under no such heading, stay.
    const middle = { title: "Deliverables", body: "Each deliverable is accepted on the delivery note.\nSignature: ____________\nName: ____________\nDate: ____________" };
    expect(findSignatureBlocks([TERMS, middle, ...body])).toEqual([]);
  });

  it("takes a block whose parties' parts give the signer's details before the line to sign, and leaves the addresses", () => {
    const block = "On behalf of the Controller:             On behalf of the Processor:\nName: Jane Roe                        Name: John Doe\nPosition: Head of Compliance             Position: Engineering Director\nAddress: 5 Elm Street, Seattle           Address: 12 Oak Lane, Dayton OH 45402\nSignature: ____________                  Signature: ____________\nDate: ____________                       Date: ____________";
    for (const clauses of bothWays([TERMS, { title: "Signatures", body: block }, { title: "ANNEX II - SECURITY MEASURES", body: "Backups are encrypted." }])) {
      const rest = left(clauses);
      expect(rest).toContain("Address: 5 Elm Street, Seattle");
      expect(rest).toContain("Address: 12 Oak Lane, Dayton OH 45402");
      for (const gone of ["On behalf of", "Jane Roe", "Engineering Director", "Signature:"]) expect(rest).not.toContain(gone);
    }
  });
});

describe("findSignatureBlocks: precision guards", () => {
  // What's left once the block is out, on one line.
  const rest = (clauses: Clause[]) => withoutBlock(clauses).map((c) => `${c.title} ${c.body}`).join(" ").replace(/\s+/g, " ");
  // Every case as both splitters give it: line breaks kept, or the clause on one line.
  const both = (clauses: Clause[]) => [clauses, clauses.map((c) => ({ ...c, body: c.body.replace(/\s+/g, " ") }))];
  const LEAD = "Notices must be in writing.";
  const LINES = "ACME INC.\nBy: ____________\nName: ____________\nTitle: ____________\n\nBETA MEDIA LLC\nBy: ____________\nName: ____________\nTitle: ____________";
  const withSentence = (sentence: string) => [TERMS, { title: "General", body: `${LEAD}\n\n${sentence}\n\n${LINES}` }];
  const WITNESS = "IN WITNESS WHEREOF, the parties have executed this Agreement.";
  const SIGNED = `${WITNESS}\n\nACME INC.\nBy: /s/ Jane Doe\nName: Jane Doe\nTitle: CEO\nDate: 03/03/2026`;

  // Guard 1: a sentence in a block.
  it("takes a sentence that only says the parties sign, naming them, the document and the date", () => {
    for (const sentence of [
      "IN WITNESS WHEREOF, the parties have executed this Agreement as of the Effective Date.",
      "IN WITNESS WHEREOF, Acme Inc. and Beta Media LLC have caused this Agreement to be executed by their duly authorized officers as of March 3, 2026.",
    ]) {
      for (const clauses of both(withSentence(sentence))) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
    }
  });

  it("keeps a sentence that brings in another document, an amount, an address or words of its own, and takes the lines under it", () => {
    for (const sentence of [
      "IN WITNESS WHEREOF, the parties have executed this Agreement and the Data Processing Addendum.",
      "By signing below, Client accepts the setup fee of $12,000.",
      "Please sign below and return a copy to contracts@acme.example.",
      "IN WITNESS WHEREOF, the parties have executed this Agreement, and each waives any right to a jury trial.",
    ]) {
      for (const clauses of both(withSentence(sentence))) {
        expect(rest(clauses)).toContain(sentence);
        for (const gone of ["ACME INC.", "BETA MEDIA LLC", "By:"]) expect(rest(clauses)).not.toContain(gone);
      }
    }
  });

  it("splits a block around a sentence in its middle that sets a term", () => {
    const sentence = "Accepted and agreed, including the payment terms in Section 4:";
    const body = `${LEAD}\n\n${WITNESS}\n\nACME INC.\nBy: ____________\nName: ____________\n\n${sentence}\n\nBETA MEDIA LLC\nBy: ____________\nName: ____________`;
    for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD} ${sentence}`);
  });

  it("keeps a name that finishes the sentence above it", () => {
    const body = "Notices to Client go to its general counsel, with a copy to\nDOE & ROE LLP\n\nACME INC.\nBy: ____________\nName: ____________\nTitle: ____________";
    for (const clauses of both([TERMS, { title: "Notices", body }])) {
      expect(rest(clauses)).toContain("with a copy to DOE & ROE LLP");
      expect(rest(clauses)).not.toContain("By:");
    }
  });

  // Guard 2: evidence of signing.
  it("leaves a record of who prepared, reviewed or approved the document, in any letter case", () => {
    const scope = { title: "Scope", body: "Agency will run two campaigns each quarter." };
    for (const record of ["Prepared by: Jane Doe\nReviewed by: John Roe\nApproved By: Mary Major\nDate: 01/02/2026", "PREPARED BY: Jane Doe\nAPPROVED BY: Mary Major\nDate: 01/02/2026"]) {
      for (const clauses of both([TERMS, scope, { title: "Document Control", body: record }])) expect(findSignatureBlocks(clauses)).toEqual([]);
    }
    const log = { title: "Change Log", body: "Version 1.1 Fees revised.\nApproved by: Jane Doe\nDate: 01/02/2026\n\nVersion 1.2 Scope updated by both parties." };
    for (const clauses of both([TERMS, log, { title: "Term", body: "This Agreement runs for twelve months." }])) expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("takes a name typed on the signer's line under the sentence that says the parties sign", () => {
    for (const lines of ["ACME INC.\nSignature: Jane Doe\nName: Jane Doe\nTitle: CEO\nDate: 03/03/2026", "ACME INC.\nApproved By: Jane Doe\nTitle: CEO\nDate: 03/03/2026"]) {
      for (const clauses of both([TERMS, { title: "General", body: `${LEAD}\n\n${WITNESS}\n\n${lines}` }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
    }
  });

  // Guard 3: fields the terms list.
  it("keeps the fields a sentence ending in a colon lists, though they look like a block", () => {
    const body = "Supplier delivers to the Customer's dock. Each delivery ticket must carry the following:\nDriver Signature: ____________\nReceived by: ____________\nDate: ____________";
    for (const clauses of both([TERMS, { title: "Deliveries", body }])) expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("keeps lines to sign in a table's rows, split by bars or by tabs", () => {
    const bars = "Milestone 1 | Due: 11/02/2026 | Fee: $9,000 | Accepted by: ____________ Date: ________\nMilestone 2 | Due: 12/14/2026 | Fee: $14,000 | Accepted by: ____________ Date: ________";
    for (const clauses of both([TERMS, { title: "Milestones", body: bars }])) expect(findSignatureBlocks(clauses)).toEqual([]);
    // After the contract's block too: the table is the schedule's.
    for (const clauses of both([TERMS, { title: "General", body: SIGNED }, { title: "Schedule 1 - Milestones", body: bars }])) expect(rest(clauses)).toContain(bars.replace(/\s+/g, " "));
    // Tabs only where the line breaks are kept: on one line they're spaces.
    const tabs = "Milestone 1\tDue: 11/02/2026\tAccepted by: ____________\tDate: ________\nMilestone 2\tDue: 12/14/2026\tAccepted by: ____________\tDate: ________";
    expect(findSignatureBlocks([TERMS, { title: "Milestones", body: tabs }])).toEqual([]);
    // Tabs that lay out a block's two columns don't make it a table.
    const columns = `${WITNESS}\n\nACME INC.\t\t\tBETA MEDIA LLC\nBy:\t____________\t\tBy:\t____________\nIts:\tPresident\t\tIts:\tManaging Director\nDate:\t3/18/2026\t\tDate:\t3/19/2026`;
    expect(rest([TERMS, { title: "General", body: `${LEAD}\n\n${columns}` }])).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
  });

  it("keeps a line to sign with only a date inside the terms, with text after it in its clause", () => {
    const body = "The site lead records each inspection on the log.\nSignature: ____________\nDate: ____________\nInspections that fail are repeated within five days at Supplier's cost.";
    for (const clauses of both([TERMS, { title: "Inspections", body }, { title: "Term", body: "This Agreement runs for twelve months." }])) expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  // Guard 4: someone else's contact details.
  it("keeps filled contact lines under a party's blank lines, and a party's heading over contact details with nothing to sign", () => {
    const billing = `${WITNESS}\n\nACME INC.\nBy: ____________\nName: ____________\nTitle: ____________\nName: Jane Roe\nEmail: ap@acme.example\nPhone: (555) 555-0100`;
    for (const clauses of both([TERMS, { title: "General", body: billing }])) {
      expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General Name: Jane Roe Email: ap@acme.example Phone: (555) 555-0100`);
    }
    const contacts = `${WITNESS}\n\nCLIENT\nSignature: ____________\nName: ____________\nDate: ____________\n\nAGENCY\nName: John Roe\nEmail: john@beta.example\nPhone: (555) 555-0101`;
    for (const clauses of both([TERMS, { title: "General", body: contacts }])) {
      expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General AGENCY Name: John Roe Email: john@beta.example Phone: (555) 555-0101`);
    }
  });

  // Guard 5: forms signed later.
  it("keeps the lines of an exhibit whose heading says form anywhere, or that has fields to fill in before them", () => {
    const order = { title: "Exhibit B - Purchase Order Form", body: "PO Number: ____________\nQuantity: ____________\nAuthorized Buyer Signature: ____________\nDate: ____________" };
    for (const clauses of both([TERMS, { title: "General", body: SIGNED }, order])) expect(withoutBlock(clauses)).toEqual([TERMS, clauses[2]]);
    const access = { title: "EXHIBIT D - SITE ACCESS", body: "[Contractor Name] staff may enter the site from [Start Date] for the work in Exhibit A.\nSignature: ____________\nName: ____________" };
    const blank = `${WITNESS}\n\nACME INC.\nBy: ____________\nName: ____________`;
    for (const clauses of both([TERMS, { title: "General", body: blank }, access])) expect(withoutBlock(clauses)).toEqual([TERMS, clauses[2]]);
  });

  it("keeps lines to sign in the terms when the line after them only names an exhibit in a sentence", () => {
    const body = "Agency will run two campaigns each quarter.\nACME INC.\nApproval: ____________\nName: ____________\nDate: ____________\nEXHIBIT A is attached to this Agreement and lists each campaign's budget.\nAgency reports results monthly and adjusts the budget only with Client's written approval.";
    for (const clauses of both([TERMS, { title: "Services", body }, { title: "Term", body: "This Agreement runs for twelve months and renews for one more." }])) expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  // Guard 6: certificates.
  const CERT = "Certificate Of Completion\nEnvelope Id: 4B7E2C9A1D3F5E6A8B0C2D4E6F8A1B3C\nStatus: Completed\nSigner Events\nJane Doe Signed: 03/03/2026 2:10:44 PM Using IP Address: 198.51.100.23";
  it("stops a certificate after the block at the next part's heading", () => {
    const body = `${LEAD}\n\n${SIGNED}\n\n${CERT}\n\nEXHIBIT A - SERVICES\nAgency will run two campaigns each quarter.`;
    for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD} EXHIBIT A - SERVICES Agency will run two campaigns each quarter.`);
  });

  it("stops a certificate at a full sentence, also one run onto its last line", () => {
    const sentence = "The Customer keeps this record for seven years after the Term ends.";
    for (const clauses of both([TERMS, { title: "General", body: SIGNED }, { title: "Audit", body: `${CERT}\n${sentence}` }])) {
      expect(rest(clauses)).toContain(sentence);
      expect(rest(clauses)).not.toContain("Envelope Id");
    }
  });

  it("takes a certificate with no block before it only under its own heading, with a service's ID and signing events", () => {
    const scope = { title: "Scope", body: "Agency will run two campaigns each quarter." };
    const own = { title: "Certificate Of Completion", body: CERT.split("\n").slice(1).join("\n") };
    for (const clauses of both([TERMS, scope, own])) expect(withoutBlock(clauses)).toEqual([TERMS, scope]);
    const record = { title: "Records", body: "Audit Trail\nDocument ID: 4B7E2C9A1D3F5E6A8B0C2D4E6F8A1B3C\nRetention: seven years\nOwner: Customer" };
    for (const clauses of both([TERMS, scope, record])) expect(findSignatureBlocks(clauses)).toEqual([]);
  });
});

describe("markSignatureBlocks", () => {
  const clauses: Clause[] = [
    { title: "Parties", body: "This Agreement is between Beta Media LLC and Acme Inc." },
    { title: "General", body: "Counterparts are fine. IN WITNESS WHEREOF, the parties sign below. ACME INC. By: ______ Name: Jane Doe Title: CFO" },
  ];
  const review: ReviewClause[] = [
    { title: "Parties", segments: [{ kind: "text", text: "This Agreement is between Beta Media LLC and " }, { kind: "field", key: "clientName", original: "Acme Inc." }] },
    {
      title: "General",
      segments: [
        { kind: "text", text: "Counterparts are fine. IN WITNESS WHEREOF, the parties sign below. " },
        { kind: "field", key: "clientName", original: "ACME INC." },
        { kind: "text", text: " By: ______ Name: " },
        { kind: "field", key: "clientSignerName", original: "Jane Doe" },
        { kind: "text", text: " Title: " },
        { kind: "field", key: "clientSignerTitle", original: "CFO" },
      ],
    },
  ];

  it("marks the fields in the block, and a field only there isn't listed once it's left out", () => {
    const marked = markSignatureBlocks(review, findSignatureBlocks(clauses));
    expect(marked[1].segments[0]).toEqual({ kind: "text", text: "Counterparts are fine. " });
    expect(marked[1].segments.slice(1).every((s) => s.signature)).toBe(true);
    expect(listFields(marked, { dropSignature: true })).toEqual([{ key: "clientName", label: "Client", places: 1, sample: "Acme Inc." }]);
    expect(listFields(marked).map((f) => [f.key, f.places])).toEqual([["clientName", 2], ["clientSignerName", 1], ["clientSignerTitle", 1]]);
    expect(buildClauses(marked, new Set(), { dropSignature: true })[1]).toEqual({ title: "General", body: "Counterparts are fine." });
    expect(buildClauses(marked, new Set())[1].body).toBe("Counterparts are fine. IN WITNESS WHEREOF, the parties sign below. {clientName} By: ______ Name: {clientSignerName} Title: {clientSignerTitle}");
  });

  it("marks a clause with no text in a block, so it goes with its title", () => {
    const empty: ReviewClause[] = [{ title: "AGENCY", segments: [{ kind: "text", text: "" }] }, { title: "Fees", segments: [{ kind: "text", text: "Fees are due monthly." }] }];
    const marked = markSignatureBlocks(empty, [{ clause: 0, start: 0, end: 0 }]);
    expect(marked[0].segments).toEqual([{ kind: "text", text: "", signature: true }]);
    expect(marked[1]).toBe(empty[1]);
    expect(buildClauses(marked, new Set(), { dropSignature: true })).toEqual([{ title: "Fees", body: "Fees are due monthly." }]);
    expect(buildClauses(marked, new Set())).toEqual([{ title: "AGENCY", body: "" }, { title: "Fees", body: "Fees are due monthly." }]);
  });

  it("leaves clauses without a block as they were", () => {
    expect(markSignatureBlocks(review, [])).toEqual(review);
  });
});

describe("findSignatureBlocks: change logs, run-on labels, short terms and other blocks", () => {
  const rest = (clauses: Clause[]) => withoutBlock(clauses).map((c) => `${c.title} ${c.body}`).join(" ").replace(/\s+/g, " ");
  const both = (clauses: Clause[]) => [clauses, clauses.map((c) => ({ ...c, body: c.body.replace(/\s+/g, " ") }))];
  const LEAD = "Notices must be in writing.";
  const LINES = "ACME INC.\nBy: ____________\nName: ____________\nTitle: ____________\n\nBETA MEDIA LLC\nBy: ____________\nName: ____________\nTitle: ____________";

  it("keeps the fields of a change log in the terms, and takes the named block at the end", () => {
    const change = {
      title: "Change Control",
      body: "Either party may ask for a change to the Services. A change binds only once both project leads approve it in the change log, and each log entry records:\n\nChange No.: ______\nSummary of change: ____________________\nRequested by: ____________  Date: ________\nApproved by (Customer lead): ____________  Date: ________\nApproved by (Supplier lead): ____________  Date: ________",
    };
    const general = {
      title: "Entire Agreement",
      body: "This Agreement is the entire agreement between the parties.\n\nSigned by the parties' authorized representatives:\n\nAcme Inc.\nBy: ____________________\nName: Jane Doe\nTitle: CEO\n\nBeta Media LLC\nBy: ____________________\nName: John Roe\nTitle: CTO",
    };
    for (const clauses of both([TERMS, change, general])) {
      const left = rest(clauses);
      for (const kept of ["Requested by:", "Approved by (Customer lead):", "Approved by (Supplier lead):", "the entire agreement between the parties."]) expect(left).toContain(kept);
      for (const gone of ["Name: Jane Doe", "Name: John Roe", "authorized representatives"]) expect(left).not.toContain(gone);
    }
  });

  it("ends a date line at a lowercase label run on after its blank", () => {
    const body = "Work starts within ten days of acceptance.\n\nAccepted by Customer:\nSignature: ____________\nDate: ________\n\nprepared by:\nAcme Landscaping LLC\nJane Doe, Lead Designer\njane@acme.example | (555) 010-0199";
    for (const clauses of both([TERMS, { title: "Schedule", body }])) {
      const left = rest(clauses);
      expect(left).toContain("prepared by: Acme Landscaping LLC Jane Doe, Lead Designer jane@acme.example");
      expect(left).not.toContain("Signature:");
      expect(left).not.toContain("Accepted by Customer");
    }
  });

  it("keeps a signing sentence with any word of its own, however short", () => {
    for (const sentence of [
      "IN WITNESS WHEREOF, the parties have unconditionally executed this Agreement.",
      "IN WITNESS WHEREOF, the parties have executed this Agreement, which replaces the prior quote.",
      "IN WITNESS WHEREOF, the parties have executed this Agreement severally and not jointly.",
      "IN WITNESS WHEREOF, the parties have executed this Agreement with retroactive effect.",
    ]) {
      for (const clauses of both([TERMS, { title: "General", body: `${LEAD}\n\n${sentence}\n\n${LINES}` }])) {
        const left = rest(clauses);
        expect(left).toContain(sentence);
        for (const gone of ["ACME INC.", "BETA MEDIA LLC", "By:"]) expect(left).not.toContain(gone);
      }
    }
  });

  it("still takes a letter's request to sign and send a copy back", () => {
    const sentence = "If these terms are acceptable, please sign below and return a copy to Acme Inc.";
    for (const clauses of both([TERMS, { title: "General", body: `${LEAD}\n\n${sentence}\n\n${LINES}` }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
  });

  it("takes parties whose company form is written with dots, and a holding company signing for a fund", () => {
    const dotted = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nAcme Software s.r.o.\nBy: ____________\nName: Jane Doe\nTitle: Managing Director\n\nBeta Law Group, P.A.\nBy: ____________\nName: John Roe\nTitle: President";
    const fund = "IN WITNESS WHEREOF, the parties have executed this Agreement.\n\nNORTHWIND FUND LP\nBy: ACME CAPITAL GP LLC, its General Partner\nBy: ____________\nName: Jane Doe\nTitle: Managing Member";
    for (const body of [dotted, fund]) {
      for (const clauses of both([TERMS, { title: "General", body: `${LEAD}\n\n${body}` }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
    }
  });

  it("takes a party written as a placeholder in brackets", () => {
    const body = `${LEAD}\n\nIN WITNESS WHEREOF, the parties have executed this Agreement.\n\nFor [CUSTOMER NAME]\nBy: ____________\nName: ____________\n\nFor Acme Inc.\nBy: ____________\nName: ____________`;
    for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
  });

  it("takes a role written over a party's name when the terms use that role", () => {
    const scope = { title: "Scope", body: "The Contractor shall replace the roof membrane, and the Owner shall give the Contractor access to the roof." };
    const body = "CONTRACTOR: Acme Roofing LLC\nSignature: ____________\nDate: ________\n\nOWNER: Jane Doe\nSignature: ____________\nDate: ________";
    for (const clauses of both([TERMS, scope, { title: "Signatures", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} ${scope.title} ${scope.body}`);
  });

  it("reads a date written day first, and ends it where the next label starts", () => {
    const signed = `${LEAD}\n\nIN WITNESS WHEREOF, the parties have executed this Agreement.\n\nACME INC.\nBy: /s/ Jane Doe\nName: Jane Doe, Vice President of Customer Success\nDate: 3 March 2026`;
    for (const clauses of both([TERMS, { title: "General", body: signed }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
    const runOn = "Accepted by Customer: Signature: ____________ Date: ________ Bank details: pay by wire to account 0042 at Northwind Bank.";
    expect(rest([TERMS, { title: "Payment", body: runOn }])).toContain("Bank details: pay by wire to account 0042 at Northwind Bank.");
  });

  it("takes a signer's blank for a party written as signed on its behalf", () => {
    const body = `${LEAD}\n\nSigned on behalf of Acme Inc.: ____________\nName: Jane Doe\n\nSigned on behalf of Beta Media LLC: ____________\nName: John Roe`;
    for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
  });

  it("takes the document's footer beside its page number under the block", () => {
    const body = `${LEAD}\n\nIN WITNESS WHEREOF, the parties have executed this Agreement.\n\n${LINES}\n\nMaster Services Agreement    Page 9 of 9`;
    for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
  });

  it("takes a typed signature over the signer's name and a title in another language", () => {
    const body = `${LEAD}\n\nIN WITNESS WHEREOF, the parties have executed this Agreement.\n\nACME SARL\n/s/ Jane Doe\nJane Doe, Directrice Générale`;
    for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
  });

  it("takes a deed signed by a director with a witness, and a block written beside a column of brackets", () => {
    const deed = "EXECUTED as a DEED by\nACME LIMITED\nacting by a director in the presence of a witness:\nDirector: ....................\nWitness signature: ....................\nWitness name: Mary Major\nWitness address: 1 High Street, York YO1 1AA";
    expect(rest([TERMS, { title: "Execution", body: `${LEAD}\n\n${deed}` }])).toBe(`${TERMS.title} ${TERMS.body} Execution ${LEAD}`);
    const columns = "AS WITNESS the hands of the parties on the date first written above.\n\nSIGNED by Acme Hotels Limited      )\nacting by Jane Doe, Director        )  ..............................\n                                    )\n\nSIGNED by Beta Media Group          )\nLimited acting by John Roe,         )  ..............................\nDirector                            )";
    for (const clauses of both([TERMS, { title: "Execution", body: `${LEAD}\n\n${columns}` }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} Execution ${LEAD}`);
  });

  it("takes a signed acceptance box on a cover page above filled order details", () => {
    const cover = {
      title: "ORDER FORM OF-2026-0107",
      body: "Acme Software, Inc.\n\nCUSTOMER ACCEPTANCE\nSignature: /s/ Jane Doe\nName: Jane Doe\nTitle: Director of Operations\nDate: May 4, 2026\n\nCustomer: Beta Media LLC\nSubscription Term: 12 months from the Start Date\n\nThis Order Form is governed by the master agreement the parties signed on March 3, 2025.",
    };
    const left = rest([cover]);
    for (const gone of ["/s/ Jane Doe", "Name: Jane Doe", "Title: Director of Operations", "Date: May 4, 2026"]) expect(left).not.toContain(gone);
    for (const kept of ["Customer: Beta Media LLC", "Subscription Term: 12 months from the Start Date", "governed by the master agreement"]) expect(left).toContain(kept);
  });

  it("takes a line to sign beside a date line, with the signer's name and title under them", () => {
    const body = `${LEAD}\n\nIN WITNESS WHEREOF, the parties have executed this Agreement.\n\nACME INC.\n\n______________________    ____________\nJane Doe, President          Date`;
    expect(rest([TERMS, { title: "General", body }])).toBe(`${TERMS.title} ${TERMS.body} General ${LEAD}`);
  });

  it("takes an acceptance that names the party it is given for", () => {
    const body = "To proceed, sign below and send the deposit.\n\nAccepted and agreed on behalf of Northwind Clinics:\nSignature: ____________\nName: ____________\nTitle: ____________\nDate: ________";
    for (const clauses of both([TERMS, { title: "Next Steps", body }])) {
      const left = rest(clauses);
      expect(left).toContain("To proceed, sign below and send the deposit.");
      for (const gone of ["Northwind Clinics", "Signature:", "Title:"]) expect(left).not.toContain(gone);
    }
  });

  it("takes two columns headed for each party, one by its role and one by its name", () => {
    const body = "This proposal is governed by the Acme Standard Terms.\n\nFor the Customer:    For Acme:\nName: Jane Doe    Name: John Roe\nTitle: VP Procurement    Title: Chief Revenue Officer\nSignature: ____________    Signature: ____________\nDate: ________    Date: ________";
    expect(rest([TERMS, { title: "Terms", body }])).toBe(`${TERMS.title} ${TERMS.body} Terms This proposal is governed by the Acme Standard Terms.`);
  });

  it("reads EXHIBIT A as a part, so a form in it with lines to sign later stays", () => {
    const acceptance = {
      title: "Acceptance",
      body: "IN WITNESS WHEREOF, the parties have executed this Order Form as of the Effective Date.\n\nACME INC.\nBy: ____________\nName: ____________\nTitle: ____________\n\nBETA LLC\nBy: ____________\nName: John Roe\nTitle: Chief Operating Officer",
    };
    const form = "Project name: [Project name]\nAdded fee: [amount]\nApproved by (Customer): ____________ Date: ________\nApproved by (Acme): ____________ Date: ________";
    // As its own clause, titled by the splitter, and run on after the block.
    const layouts: Clause[][] = [
      [TERMS, acceptance, { title: "EXHIBIT A - CHANGE ORDER FORM", body: form }],
      [TERMS, { ...acceptance, body: `${acceptance.body}\nEXHIBIT A - CHANGE ORDER FORM\n${form}` }],
    ];
    for (const layout of layouts) {
      for (const clauses of both(layout)) {
        const left = rest(clauses);
        for (const kept of ["Project name: [Project name]", "Approved by (Customer):", "Approved by (Acme):"]) expect(left).toContain(kept);
        for (const gone of ["IN WITNESS WHEREOF", "John Roe"]) expect(left).not.toContain(gone);
      }
    }
  });

  it("still reads Exhibit A in a sentence as words, not a part", () => {
    const body = "Exhibit A sets out the fees for each phase\n\nACME INC.\nBy: ____________\nName: ____________";
    for (const clauses of both([TERMS, { title: "Fees", body }])) expect(rest(clauses)).toContain("Exhibit A sets out the fees for each phase");
  });

  it("treats a stamp-like label with a blank as a field, not a stamp", () => {
    const body = "Supplier keeps a delivery record for each shipment.\nVerified by: ____________\nShipment No.: ______";
    for (const clauses of both([TERMS, { title: "Deliveries", body }])) expect(findSignatureBlocks(clauses)).toEqual([]);
  });

  it("stays fast on long runs of dots, initials and spaces", () => {
    const inputs = [`Name: ${".".repeat(49990)}b`, `${"A.".repeat(24990)} b`, `a${" ".repeat(49990)}b`, `x ${"J.".repeat(24990)}b`];
    for (const body of inputs) {
      const clauses = [{ title: "General", body }];
      const times = [0, 1, 2].map(() => {
        const t = performance.now();
        findSignatureBlocks(clauses);
        return performance.now() - t;
      });
      expect(Math.min(...times)).toBeLessThan(300);
    }
  });
});

describe("findSignatureBlocks: forms after the contract's block, and more ways a block is written", () => {
  // What's left once the block is out, on one line.
  const rest = (clauses: Clause[]) => withoutBlock(clauses).map((c) => `${c.title} ${c.body}`).join(" ").replace(/\s+/g, " ");
  // Every case as both splitters give it: line breaks kept, or the clause on one line.
  const both = (clauses: Clause[]) => [clauses, clauses.map((c) => ({ ...c, body: c.body.replace(/\s+/g, " ") }))];
  const L = "____________";
  const expectLeft = (clauses: Clause[], kept: string[], gone: string[]) => {
    const left = rest(clauses);
    for (const k of kept) expect(left).toContain(k);
    for (const g of gone) expect(left).not.toContain(g);
  };

  it("keeps an exhibit's order form whole when a field in it starts with the form's name", () => {
    const body = `This Agreement is governed by the laws of Delaware.\n\nIN WITNESS WHEREOF, the parties have signed this Agreement.\n\nACME INC.\nBy: ${L}\nName: ${L}\nTitle: ${L}\n\nBETA LLC\nBy: ${L}\nName: ${L}\nTitle: ${L}\n\nEXHIBIT B\nORDER FORM\n\nOrder Form Number: ${L}\nOrder Form Start Date: ${L}\n\nCustomer Name: ${L}\nBilling Email: ${L}\n\nThis Order Form is part of the Agreement. By signing below, each party accepts this Order Form.\n\nACCEPTED BY CUSTOMER:\nSignature: ${L}\nPrinted Name: ${L}\nDate: ${L}`;
    for (const clauses of both([TERMS, { title: "General", body }])) {
      expectLeft(clauses, ["Order Form Start Date:", "ACCEPTED BY CUSTOMER", "Printed Name:"], ["IN WITNESS WHEREOF", "BETA LLC"]);
    }
  });

  it("keeps a cancellation notice after the contract's block, with its heading and the buyer's line", () => {
    const body = `Buyer may cancel this sale as the attached notice explains.\n\nBy signing below, Buyer confirms receiving a copy of this Agreement.\n\nBUYER SIGNATURE: ${L} Date: ${L}\n\nSELLER: [COMPANY NAME]\nAUTHORIZED SIGNATURE: ${L} Date: ${L}\n\nNOTICE OF CANCELLATION\n\nDate of Transaction: ${L}\n\nYou may cancel this sale without any penalty within three business days of the date above.\n\nTo cancel, deliver a dated copy of this notice to the seller at the address above.\n\nI HEREBY CANCEL THIS TRANSACTION.\n\nDate: ${L}\nBuyer's Signature: ${L}`;
    for (const clauses of both([TERMS, { title: "General", body }])) {
      expectLeft(clauses, ["NOTICE OF CANCELLATION", "Date of Transaction:", "I HEREBY CANCEL THIS TRANSACTION.", "Buyer's Signature:"], ["BUYER SIGNATURE:", "AUTHORIZED SIGNATURE:"]);
    }
  });

  it("keeps a row that asks for a role's name beside another detail at the end of a block", () => {
    const body = `By signing below, Buyer confirms receiving a copy of this Agreement.\n\nBUYER SIGNATURE: ${L} Date: ${L}\n\nSELLER: [COMPANY NAME]\nAUTHORIZED SIGNATURE: ${L} Date: ${L}\nSales Agent Name: ${L} License No.: ${L}`;
    for (const clauses of both([TERMS, { title: "General", body }])) {
      expectLeft(clauses, ["Sales Agent Name:", "License No.:"], ["BUYER SIGNATURE:", "AUTHORIZED SIGNATURE:"]);
    }
  });

  it("takes English blocks written as 'Signed by ... for and on behalf of' and 'Executed ... acting by'", () => {
    const signedBy = `This Agreement is governed by the law of England.\n\nThis Agreement has been entered into on the date stated above.\n\nSigned by [NAME OF DIRECTOR] for and on behalf of [ACME LIMITED] ........................ Director\n\nSigned by [NAME OF DIRECTOR] for and on behalf of [BETA LIMITED] ........................ Director`;
    for (const clauses of both([TERMS, { title: "General", body: signedBy }])) {
      expectLeft(clauses, ["governed by the law of England"], ["entered into", "[NAME OF DIRECTOR]", "Director"]);
    }
    // With its line breaks, the witness under it goes too.
    const actingBy = `This Agreement is governed by the law of England.\n\nExecuted as a deed by ACME LIMITED acting by a director ........................ Director\n\nin the presence of:\nWitness signature: ........................\nWitness name: ........................`;
    expectLeft([TERMS, { title: "General", body: actingBy }], ["governed by the law of England"], ["acting by", "Witness name"]);
  });

  it("takes a heading row of the parties: a company with a column heading beside it, stand-ins, or roles", () => {
    for (const heading of ["ACME PAYROLL, INC.     PARTNER", "[CONSULTANT LEGAL NAME]     [CLIENT LEGAL NAME]", `LICENSOR: [ACME CORP]     LICENSEE: ${L}`]) {
      const body = `IN WITNESS WHEREOF, the parties have signed this Agreement.\n\n${heading}\nBy: ${L}     By: ${L}\nName: ${L}     Name: ${L}`;
      for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body}`);
    }
  });

  it("takes a sign-off heading that names the party, and a sentence that one representative signed", () => {
    const heading = `This Agreement is the whole agreement of the parties.\n\nSIGNATURE PAGE (CUSTOMER)\n\nCustomer: ${L}\nBy: ${L}\nName: ${L}`;
    const singular = `This Agreement is the whole agreement of the parties.\n\nEach party's authorized representative has signed this Agreement as of the Effective Date.\n\nProvider: [PROVIDER NAME]\nBy: ${L}\nName: ${L}\n\nCustomer: [CUSTOMER NAME]\nBy: ${L}\nName: ${L}`;
    for (const body of [heading, singular]) {
      for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} General This Agreement is the whole agreement of the parties.`);
    }
  });

  it("takes a party's legal name line, and a role the terms name with a line of its own", () => {
    const legal = `IN WITNESS WHEREOF, the parties have signed this Agreement.\n\nLegal Name: ${L}\nBy: ${L}\nName: ${L}\nTitle: ${L}`;
    for (const clauses of both([TERMS, { title: "General", body: legal }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body}`);
    const parties = { title: "Parties", body: 'This Agreement is made between Acme Inc. ("Company") and Beta LLC ("Counterparty") on the Effective Date.' };
    const roles = `IN WITNESS WHEREOF, the parties have signed this Agreement.\n\nCOMPANY: ACME INC.\nBy: ${L}\nName: ${L}\n\nCOUNTERPARTY: ${L}\nBy: ${L}\nName: ${L}`;
    for (const clauses of both([TERMS, parties, { title: "General", body: roles }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body} ${parties.title} ${parties.body}`);
  });

  it("takes a company's name used as the label of its line beside a date", () => {
    const body = `IN WITNESS WHEREOF, the parties have signed this Agreement.\n\nAcme Co.: ${L} Date: ${L}\nBeta LLC: ${L} Date: ${L}`;
    for (const clauses of both([TERMS, { title: "General", body }])) expect(rest(clauses)).toBe(`${TERMS.title} ${TERMS.body}`);
  });

  it("takes a block laid out as a table with cell borders", () => {
    const body = `IN WITNESS WHEREOF, the parties have signed this Agreement.\n\n| ACME INC. | BETA LLC |\n| By: ${L} | By: ${L} |\n| Name: ${L} | Name: ${L} |\n| Date: ${L} | Date: ${L} |`;
    expect(rest([TERMS, { title: "General", body }])).toBe(`${TERMS.title} ${TERMS.body}`);
  });

  it("takes an attesting officer under the company's stand-in, and a numbered list of witnesses", () => {
    const attest = `IN WITNESS WHEREOF, the parties have signed this Agreement under seal.\n\nACME CORPORATION\nBy: ${L}\nName: ${L}\nTitle: ${L}\n\nATTEST:   [ACME CORPORATION]\n${L}\nSecretary\n[CORPORATE SEAL]`;
    expect(rest([TERMS, { title: "General", body: attest }])).toBe(`${TERMS.title} ${TERMS.body}`);
    const assignment = { title: "Assignment", body: "Assignor assigns to Assignee all of its rights in the patents listed in Schedule A." };
    const witnesses = `IN WITNESS WHEREOF, Assignor has signed this Assignment.\n\nASSIGNOR:\n${L}\n[ASSIGNOR NAME]\nDate: ${L}\n\nWITNESSES:\n\n1. ${L}\nName: ${L}\n\n2. ${L}\nName: ${L}\n\nACCEPTED AND AGREED:\n[ASSIGNEE NAME]\nBy: ${L}\nName: ${L}\nTitle: ${L}`;
    expect(rest([TERMS, assignment, { title: "General", body: witnesses }])).toBe(`${TERMS.title} ${TERMS.body} ${assignment.title} ${assignment.body}`);
  });
});
