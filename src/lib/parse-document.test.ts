import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import { extractText, splitIntoClauses, type ParsedClause } from "./parse-document";

// The words of a text, compared without case or punctuation.
function words(s: string): string[] {
  return s
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

const ADDED_TITLES = new Set(["Introduction", "Preamble", "Agreement Text"]);

// The source's words that aren't in the clauses. Everything the clauses hold
// must come from the source, in the same order; the only words allowed to go
// missing are the heading labels ("1.", "Section 2.", "ARTICLE IV").
function missingWords(source: string, clauses: ParsedClause[]): string[] {
  // A PDF's "appli-\ncable" comes back as one word.
  const unwrapped = source.replace(/(\p{L})-\n(?=\p{Ll})/gu, "$1-");
  const kept = words(clauses.map((c, i) => `${i === 0 && ADDED_TITLES.has(c.title) ? "" : c.title.replace(/ \(\d+\)$/, "")}\n${c.body}`).join("\n"));
  const missing: string[] = [];
  let k = 0;
  for (const w of words(unwrapped)) {
    if (kept[k] === w) k++;
    else missing.push(w);
  }
  expect(kept.slice(k), "text in the clauses that isn't in the source, or is out of order").toEqual([]);
  return missing;
}

function expectNothingLost(source: string, clauses: ParsedClause[]) {
  expect(missingWords(source, clauses).filter((w) => !/^(?:\d{1,3}|[ivxlcdm]{1,7}|article|section)$/.test(w))).toEqual([]);
}

const titles = (clauses: ParsedClause[]) => clauses.map((c) => c.title);

describe("splitIntoClauses: heading styles", () => {
  it('splits on "1. Services" headings and keeps the preamble', () => {
    const source = `CONSULTING AGREEMENT

This Consulting Agreement (the "Agreement") is entered into as of March 1, 2026 (the "Effective Date") by and between Northwind Holdings, Inc., a Delaware corporation ("Client"), and Brightline Partners LLC, a New York limited liability company ("Consultant").

1. Services
Consultant shall provide the strategy and analytics services described in each statement of work (the "Services").

2. Fees
Client shall pay Consultant {fee} per month, invoiced monthly in arrears and due within thirty (30) days.

3. Term
This Agreement begins on the Effective Date and continues for twelve (12) months unless terminated earlier.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Introduction", "Services", "Fees", "Term"]);
    expect(clauses[0].body).toBe(
      'CONSULTING AGREEMENT\n\nThis Consulting Agreement (the "Agreement") is entered into as of March 1, 2026 (the "Effective Date") by and between Northwind Holdings, Inc., a Delaware corporation ("Client"), and Brightline Partners LLC, a New York limited liability company ("Consultant").',
    );
    expect(clauses[2].body).toBe("Client shall pay Consultant {fee} per month, invoiced monthly in arrears and due within thirty (30) days.");
    expect(missingWords(source, clauses)).toEqual(["1", "2", "3"]);
  });

  it('splits on "Section N." headings, with the clause text on the heading line, in a PDF wrapped mid-sentence', () => {
    const source = `MASTER SERVICES AGREEMENT
This Master Services Agreement (this "Agreement") is made as of January 15, 2026 (the "Effective
Date") between Acme Robotics Corp., a Delaware corporation ("Customer"), and Vantage Digital LLC, a
Texas limited liability company ("Agency").
Section 1. Services. Agency shall perform the digital marketing services described in one or more
statements of work signed by both parties (each, an "SOW"). Each SOW forms part of this Agreement.
Section 2. Compensation. Customer shall pay the fees set out in each SOW within thirty (30) days
after receipt of a correct invoice. Amounts not paid when due accrue interest at 1.5% per month or
the highest rate permitted by law, whichever is lower.
Section 3. Term and Termination
This Agreement starts on the Effective Date and continues until either party ends it on thirty (30)
days' prior written notice to the other party, delivered as required by the notice provisions below.
Section 4. Confidentiality. Each party shall protect the other party's Confidential Information with
at least the care it uses to protect its own, and in no event with less than reasonable care.
Section 5. Governing Law. This Agreement is governed by the laws of the State of New York, without
regard to its conflict of laws rules.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Introduction", "Services", "Compensation", "Term and Termination", "Confidentiality", "Governing Law"]);
    expect(clauses[0].body).toBe(
      'MASTER SERVICES AGREEMENT\nThis Master Services Agreement (this "Agreement") is made as of January 15, 2026 (the "Effective Date") between Acme Robotics Corp., a Delaware corporation ("Customer"), and Vantage Digital LLC, a Texas limited liability company ("Agency").',
    );
    expect(clauses[1].body).toBe(
      'Agency shall perform the digital marketing services described in one or more statements of work signed by both parties (each, an "SOW"). Each SOW forms part of this Agreement.',
    );
    expect(clauses[2].body).toBe(
      "Customer shall pay the fees set out in each SOW within thirty (30) days after receipt of a correct invoice. Amounts not paid when due accrue interest at 1.5% per month or the highest rate permitted by law, whichever is lower.",
    );
    expect(clauses[3].body).toBe(
      "This Agreement starts on the Effective Date and continues until either party ends it on thirty (30) days' prior written notice to the other party, delivered as required by the notice provisions below.",
    );
    expect(missingWords(source, clauses)).toEqual(["section", "1", "section", "2", "section", "3", "section", "4", "section", "5"]);
  });

  it("splits on ARTICLE headings in roman numerals and keeps Section 1.01 subsections inside them", () => {
    const source = `SOFTWARE LICENSE AGREEMENT

This Software License Agreement is entered into as of April 1, 2026 by and between Helios Data, Inc. ("Licensor") and Granite Bay Logistics, LLC ("Licensee").

ARTICLE I
DEFINITIONS

Section 1.01 "Software" means Licensor's route optimization platform, including all updates Licensor makes generally available.

Section 1.02 "Documentation" means the user guides and technical specifications Licensor provides for the Software.

ARTICLE II
LICENSE GRANT

Section 2.01 Grant. Licensor grants Licensee a non-exclusive, non-transferable license to use the Software during the Term.

Section 2.02 Restrictions. Licensee shall not reverse engineer, decompile or sublicense the Software.

ARTICLE III - FEES

Section 3.01 License Fee. Licensee shall pay {fee} per year, in advance.

ARTICLE IV
GENERAL PROVISIONS

Section 4.01 Notices. All notices under this Agreement must be in writing.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Introduction", "DEFINITIONS", "LICENSE GRANT", "FEES", "GENERAL PROVISIONS"]);
    expect(clauses[1].body).toBe(
      'Section 1.01 "Software" means Licensor\'s route optimization platform, including all updates Licensor makes generally available.\n\nSection 1.02 "Documentation" means the user guides and technical specifications Licensor provides for the Software.',
    );
    expect(clauses[3].body).toBe("Section 3.01 License Fee. Licensee shall pay {fee} per year, in advance.");
    expect(missingWords(source, clauses)).toEqual(["article", "i", "article", "ii", "article", "iii", "article", "iv"]);
  });

  it("splits on Article headings in digits with the name on the same line", () => {
    const source = `Article 1: Engagement
Client engages Agency as its exclusive social media agency in the United States.
Article 2 - Compensation
Client shall pay Agency the retainer of {fee} on the first day of each month.
Article 3. Term
This Agreement runs for an initial term of six (6) months.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Engagement", "Compensation", "Term"]);
    expect(clauses[1].body).toBe("Client shall pay Agency the retainer of {fee} on the first day of each month.");
    expectNothingLost(source, clauses);
  });

  it('groups "1.1" subsections under their "1." parent, each on its own line', () => {
    const source = `1. Definitions
1.1 "Confidential Information" means all non-public business, technical and financial information
disclosed by one party to the other, in any form.
1.2 "Deliverables" means the work product Agency creates for Client under this Agreement.
2. Services
2.1 Scope. Agency shall provide the Services described in Exhibit A, as amended from time to time.
2.2 Changes. Either party may request a change to the scope in writing; no change binds either party
until both parties sign it.
3. Payment
3.1 Fees. Client shall pay Agency {fee} per month for the duration of this Agreement.
3.2 Expenses. Client shall reimburse pre-approved travel expenses within thirty (30) days of invoice.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Definitions", "Services", "Payment"]);
    expect(clauses[0].body).toBe(
      '1.1 "Confidential Information" means all non-public business, technical and financial information disclosed by one party to the other, in any form.\n1.2 "Deliverables" means the work product Agency creates for Client under this Agreement.',
    );
    expect(clauses[1].body).toBe(
      "2.1 Scope. Agency shall provide the Services described in Exhibit A, as amended from time to time.\n2.2 Changes. Either party may request a change to the scope in writing; no change binds either party until both parties sign it.",
    );
    expect(missingWords(source, clauses)).toEqual(["1", "2", "3"]);
  });

  it('reads "1. Services. The Agency shall ..." as a heading with its text on the same line', () => {
    const source = `1. Services. The Agency shall provide the paid media services described in the attached proposal, including campaign setup, creative testing and weekly optimization.

2. FEES AND PAYMENT. Client shall pay the Agency {fee} per month, plus approved media spend, within fifteen (15) days of each invoice.

3. Term - This Agreement begins on {startDate} and continues month to month until either party gives thirty (30) days' written notice.

4. Governing Law: This Agreement is governed by the laws of the State of Illinois.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Services", "FEES AND PAYMENT", "Term", "Governing Law"]);
    expect(clauses[0].body).toBe(
      "The Agency shall provide the paid media services described in the attached proposal, including campaign setup, creative testing and weekly optimization.",
    );
    expect(clauses[2].body).toBe("This Agreement begins on {startDate} and continues month to month until either party gives thirty (30) days' written notice.");
    expect(clauses[3].body).toBe("This Agreement is governed by the laws of the State of Illinois.");
    expectNothingLost(source, clauses);
  });

  it("splits on ALL-CAPS headings when nothing is numbered", () => {
    const source = `INDEPENDENT CONTRACTOR AGREEMENT

This Independent Contractor Agreement is made on May 5, 2026 between Summit Peak Media, Inc. ("Company") and Jordan Ellis ("Contractor").

SERVICES

Contractor will produce the video content described in the project brief attached to this Agreement.

COMPENSATION

Company will pay Contractor {fee} within fifteen (15) days of each accepted delivery.

CONFIDENTIALITY. Contractor shall keep all non-public Company information confidential during and after the engagement.

GOVERNING LAW

This Agreement is governed by the laws of the State of California.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["INDEPENDENT CONTRACTOR AGREEMENT", "SERVICES", "COMPENSATION", "CONFIDENTIALITY", "GOVERNING LAW"]);
    expect(clauses[0].body).toBe(
      'This Independent Contractor Agreement is made on May 5, 2026 between Summit Peak Media, Inc. ("Company") and Jordan Ellis ("Contractor").',
    );
    expect(clauses[3].body).toBe("Contractor shall keep all non-public Company information confidential during and after the engagement.");
    expect(missingWords(source, clauses)).toEqual([]);
  });

  it("makes exhibits after the last section clauses of their own, numbering inside them included", () => {
    const source = `1. Services
Agency shall provide the Services described in Exhibit A.
2. Fees
Client shall pay the fees set out in Exhibit A within thirty (30) days of each invoice.
3. Term
This Agreement continues until the Services in Exhibit A are complete.
IN WITNESS WHEREOF, the parties have signed this Agreement as of the Effective Date.
EXHIBIT A
STATEMENT OF WORK
1. Website redesign
2. Search engine optimization
3. Monthly reporting`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Services", "Fees", "Term", "EXHIBIT A - STATEMENT OF WORK"]);
    expect(clauses[2].body).toBe(
      "This Agreement continues until the Services in Exhibit A are complete.\nIN WITNESS WHEREOF, the parties have signed this Agreement as of the Effective Date.",
    );
    expect(clauses[3].body).toBe("1. Website redesign\n2. Search engine optimization\n3. Monthly reporting");
    expectNothingLost(source, clauses);
  });
});

describe("splitIntoClauses: never drops text", () => {
  const SECTIONS = [
    "Services",
    "Deliverables",
    "Fees and Payment",
    "Expenses",
    "Term",
    "Termination",
    "Confidentiality",
    "Intellectual Property",
    "Indemnification",
    "Limitation of Liability",
    "Insurance",
    "Independent Contractor",
    "Non-Solicitation",
    "Force Majeure",
    "Notices",
    "Governing Law",
  ];
  const SENTENCES = [
    "The Agency shall perform its obligations under this Section in a professional and workmanlike manner consistent with generally accepted industry standards.",
    "Client shall provide the Agency with timely access to the personnel, information and systems reasonably required for that purpose.",
    "Any delay caused by Client's failure to do so extends the affected deadlines by the length of the delay.",
    "Neither party may assign its rights under this Section without the prior written consent of the other party, which shall not be unreasonably withheld.",
    "The parties shall meet at least once each calendar quarter to review performance under this Section and agree on any adjustments in writing.",
    "Nothing in this Section limits any right or remedy available to either party at law or in equity.",
  ];
  const paragraph = (section: number, sentences: number) =>
    Array.from({ length: sentences }, (_, k) => SENTENCES[(section + k) % SENTENCES.length].replace("this Section", `this Section ${section + 1}`)).join(" ");

  it("keeps every word of a long contract, with no clause cut short", () => {
    const bodies = SECTIONS.map((_, i) => paragraph(i, i === 8 ? 28 : 5));
    const preamble =
      'This Marketing Services Agreement (the "Agreement") is entered into as of June 1, 2026 by and between Riverstone Outdoor Co., a Colorado corporation ("Client"), and Peakline Creative LLC, a Delaware limited liability company (the "Agency").';
    const source = [preamble, ...SECTIONS.map((name, i) => `${i + 1}. ${name}\n${bodies[i]}`)].join("\n\n");
    expect(source.length).toBeGreaterThan(10_000);
    expect(bodies[8].length).toBeGreaterThan(3000);

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Introduction", ...SECTIONS]);
    expect(clauses[0].body).toBe(preamble);
    clauses.slice(1).forEach((clause, i) => expect(clause.body).toBe(bodies[i]));
    expect(clauses[clauses.length - 1].body.endsWith(bodies[bodies.length - 1].slice(-80))).toBe(true);
    expect(missingWords(source, clauses)).toEqual(SECTIONS.map((_, i) => String(i + 1)));
  });

  it("keeps all of a long document it finds no headings in", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => paragraph(i, 3));
    const source = paragraphs.join("\n\n");
    expect(source.length).toBeGreaterThan(10_000);

    const clauses = splitIntoClauses(source);
    expect(clauses).toEqual([{ title: "Agreement Text", body: source }]);
  });

  it("keeps paragraphs and lists, joins lines the PDF wrapped, and carries a sentence across a page break", () => {
    const source = `4. Confidentiality
Each party (the "Recipient") shall hold the other party's Confidential Information in strict
confidence and shall not:
(a) disclose it to any third party other than its employees and advisors who need to know it and
are bound by duties of confidentiality at least as protective as those in this Section;
(b) use it for any purpose other than performing this Agreement; or
(c) copy it except as reasonably necessary for that purpose.
The obligations in this Section do not apply to information that is or becomes publicly available
through no fault of the Recipient, or that the Recipient develops independently.
Each party's obligations under this Section continue for three (3) years after this Agreement

ends, and for trade secrets, for as long as the information remains a trade secret under appli-
cable law, whichever period is longer.
5. Notices
All notices must be in writing and are effective when delivered by hand, by courier or by email
with confirmation of receipt, to the address of the receiving party set out above.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Confidentiality", "Notices"]);
    expect(clauses[0].body).toBe(
      [
        "Each party (the \"Recipient\") shall hold the other party's Confidential Information in strict confidence and shall not:",
        "(a) disclose it to any third party other than its employees and advisors who need to know it and are bound by duties of confidentiality at least as protective as those in this Section;",
        "(b) use it for any purpose other than performing this Agreement; or",
        "(c) copy it except as reasonably necessary for that purpose.",
        "The obligations in this Section do not apply to information that is or becomes publicly available through no fault of the Recipient, or that the Recipient develops independently.",
        "Each party's obligations under this Section continue for three (3) years after this Agreement ends, and for trade secrets, for as long as the information remains a trade secret under appli-cable law, whichever period is longer.",
      ].join("\n"),
    );
    expect(missingWords(source, clauses)).toEqual(["4", "5"]);
  });

  it("keeps the blank lines between paragraphs of a .docx", () => {
    const source = `1. Payment Terms

Client shall pay each invoice within thirty (30) days.

Late amounts accrue interest at 1% per month.

2. Taxes

Fees exclude sales and use taxes, which Client shall pay.`;

    const clauses = splitIntoClauses(source);
    expect(clauses[0]).toEqual({ title: "Payment Terms", body: "Client shall pay each invoice within thirty (30) days.\n\nLate amounts accrue interest at 1% per month.", label: "1" });
  });

  it("leaves a numbered list inside a clause alone", () => {
    const source = `1. SERVICES
Agency shall provide the following services:
1. design of a new landing page;
2. setup and management of paid search campaigns; and
3. a monthly performance report.
2. FEES
Client shall pay {fee} per month.
3. TERM
This Agreement continues for twelve (12) months.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["SERVICES", "FEES", "TERM"]);
    expect(clauses[0].body).toBe(
      "Agency shall provide the following services:\n1. design of a new landing page;\n2. setup and management of paid search campaigns; and\n3. a monthly performance report.",
    );
  });

  it("tells a list of short titles apart from the headings around it", () => {
    const source = `1. SERVICES. Agency shall provide the following deliverables:
1. Landing Page Design
2. Paid Search Management
3. Monthly Reporting
2. FEES. Client shall pay {fee} per month.
3. TERM. This Agreement continues for twelve (12) months.
4. NOTICES. Notices must be in writing.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["SERVICES", "FEES", "TERM", "NOTICES"]);
    expect(clauses[0].body).toBe("Agency shall provide the following deliverables:\n1. Landing Page Design\n2. Paid Search Management\n3. Monthly Reporting");
  });

  it("doesn't take a wrapped line starting with \"Section 7 hereof\" for a heading", () => {
    const source = `1. Payment
Client shall pay each invoice within thirty (30) days. Late payments are subject to the remedies in
Section 7 hereof and to suspension of the Services under Article 2 of the applicable statement of
work, at the Agency's option and on written notice.
2. Term
This Agreement continues for one (1) year and renews for successive one (1) year terms.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Payment", "Term"]);
    expect(clauses[0].body).toBe(
      "Client shall pay each invoice within thirty (30) days. Late payments are subject to the remedies in Section 7 hereof and to suspension of the Services under Article 2 of the applicable statement of work, at the Agency's option and on written notice.",
    );
  });

  it("keeps splitting past a section it can't read as a heading", () => {
    const source = `1. Services
Agency shall provide the Services.
2. Fees
Client shall pay {fee} per month.
3. [intentionally omitted]
4. Limitation of Liability; Exclusion of Consequential Damages; Cap on Direct Damages
Neither party is liable for indirect or consequential damages.
5. Notices
Notices must be in writing.`;

    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Services", "Fees", "Limitation of Liability; Exclusion of Consequential Damages; Cap on Direct Damages", "Notices"]);
    expect(clauses[1].body).toBe("Client shall pay {fee} per month.\n3. [intentionally omitted]");
    expectNothingLost(source, clauses);
  });

  it("names the preamble Preamble when the contract has its own Introduction section", () => {
    const source = `This Agreement is made between Acme Corp. and Beta LLC.

1. Introduction
Acme wishes to engage Beta for the services below.

2. Services
Beta shall provide bookkeeping services.`;

    expect(titles(splitIntoClauses(source))).toEqual(["Preamble", "Introduction", "Services"]);
  });

  it("numbers a repeated heading so each clause has a title of its own", () => {
    const source = `ARTICLE I
GENERAL
The parties are independent contractors.
ARTICLE II
SERVICES
Agency shall provide the Services.
ARTICLE III
GENERAL
This Agreement is the entire agreement of the parties.`;

    expect(titles(splitIntoClauses(source))).toEqual(["GENERAL", "SERVICES", "GENERAL (2)"]);
  });

  it("gives an empty document one clause to start from", () => {
    expect(splitIntoClauses("")).toEqual([{ title: "Agreement Text", body: "Paste or edit the agreement text here." }]);
    expect(splitIntoClauses(" \n\n \t\n")).toEqual([{ title: "Agreement Text", body: "Paste or edit the agreement text here." }]);
  });

  it("keeps a document with a single heading whole", () => {
    const source = "1. Services\nAgency shall provide the Services.";
    expect(splitIntoClauses(source)).toEqual([{ title: "Agreement Text", body: "1. Services\nAgency shall provide the Services." }]);
  });
});

describe("importing a PDF", () => {
  it("finds every section of a multi-page PDF, with no page markers in the text", async () => {
    const names = ["Services", "Fees", "Expenses", "Term", "Termination", "Confidentiality", "Warranties", "Indemnification", "Liability", "Insurance", "Notices", "Governing Law"];
    const body = (i: number) =>
      `The obligations in this Section ${i + 1} bind each party from the Effective Date. The Agency shall perform the Services in a professional and workmanlike manner consistent with generally accepted industry standards, and Client shall cooperate in good faith, provide timely feedback and approvals, and give the Agency access to the information reasonably required. Any notice under this Section ${i + 1} must be given in writing.`;
    const preamble =
      'This Master Services Agreement (the "Agreement") is entered into as of July 1, 2026 by and between Lakeshore Fitness Group, Inc. ("Client") and Northbeam Studio LLC (the "Agency").';
    const pdf = await renderToBuffer(
      createElement(
        Document,
        null,
        createElement(
          Page,
          { size: "LETTER", style: { padding: 56, fontSize: 11 } },
          createElement(Text, { style: { fontSize: 16, marginBottom: 12 } }, "MASTER SERVICES AGREEMENT"),
          createElement(Text, { style: { marginBottom: 12 } }, preamble),
          ...names.flatMap((name, i) => [
            createElement(Text, { key: `h${i}`, style: { marginBottom: 4 } }, `Section ${i + 1}. ${name}`),
            createElement(Text, { key: `b${i}`, style: { marginBottom: 12 } }, body(i)),
          ]),
        ),
      ),
    );
    const text = await extractText(new File([new Uint8Array(pdf)], "msa.pdf", { type: "application/pdf" }));
    expect(text).not.toMatch(/-- \d+ of \d+ --/);

    const clauses = splitIntoClauses(text);
    expect(titles(clauses)).toEqual(["Introduction", ...names]);
    expect(words(clauses[0].body)).toEqual(words(`MASTER SERVICES AGREEMENT ${preamble}`));
    clauses.slice(1).forEach((clause, i) => expect(words(clause.body)).toEqual(words(body(i))));
    expect(clauses.every((c) => !c.body.includes("\n\n"))).toBe(true);
  });
});

const labels = (clauses: ParsedClause[]) => clauses.map((c) => c.label);

describe("splitIntoClauses: clause numbers", () => {
  it("keeps the document's own numbers, with none for the opening paragraph and the exhibits", () => {
    const source = `MASTER SERVICES AGREEMENT

This Agreement is made between Acme Inc. ("Client") and Beta LLC ("Agency").

1. Services
Agency shall provide the services in each statement of work.

2. Fees
Client shall pay the fees set out in Exhibit A. Late fees are described in Section 3.

3. Late Payment
Amounts unpaid after thirty (30) days accrue interest at 1% per month.

EXHIBIT A - FEES
Monthly retainer: [amount]`;
    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Introduction", "Services", "Fees", "Late Payment", "EXHIBIT A - FEES"]);
    expect(labels(clauses)).toEqual(["", "1", "2", "3", ""]);
  });

  it('keeps "Section 1.01" and roman article numbers as written', () => {
    const sections = splitIntoClauses(`Section 1.01 Definitions
Terms have the meanings given in this Section 1.01.

Section 1.02 Interpretation
Headings are for convenience only.

Section 2.01 Fees
Fees are payable under Section 2.01 within thirty (30) days.`);
    expect(titles(sections)).toEqual(["Definitions", "Interpretation", "Fees"]);
    expect(labels(sections)).toEqual(["1.01", "1.02", "2.01"]);

    const articles = splitIntoClauses(`ARTICLE I
DEFINITIONS
Capitalized terms have the meanings below.

ARTICLE II
REPRESENTATIONS AND WARRANTIES OF
THE COMPANY
The Company represents that it is duly organized.

ARTICLE III
TERM
This Agreement lasts one year.`);
    expect(titles(articles)).toEqual(["DEFINITIONS", "REPRESENTATIONS AND WARRANTIES OF THE COMPANY", "TERM"]);
    expect(labels(articles)).toEqual(["I", "II", "III"]);
    expectNothingLost("ARTICLE I DEFINITIONS Capitalized terms have the meanings below. ARTICLE II REPRESENTATIONS AND WARRANTIES OF THE COMPANY The Company represents that it is duly organized. ARTICLE III TERM This Agreement lasts one year.", articles);
  });

  it("leaves numbers out where the document has none", () => {
    const clauses = splitIntoClauses(`This Agreement is made between Acme Inc. and Beta LLC.

SERVICES
Agency shall provide the services.

FEES
Client shall pay the fees.`);
    expect(titles(clauses)).toEqual(["Introduction", "SERVICES", "FEES"]);
    expect(labels(clauses)).toEqual(["", undefined, undefined]);
  });
});

describe("splitIntoClauses: lines that look like headings but aren't", () => {
  // Lines wrapped at about 80 characters, the way a PDF's text comes out.
  it('keeps a wrapped "Exhibit A." in its sentence', () => {
    const source = `1. Services
The Agency shall perform the services described in the Statement of Work attached as
Exhibit A.

2. Fees
The Client shall pay the fees stated in the Statement of Work within thirty days of
the date of each invoice issued by the Agency under this Agreement and its terms.`;
    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Services", "Fees"]);
    expect(clauses[0].body).toBe("The Agency shall perform the services described in the Statement of Work attached as Exhibit A.");
  });

  it("keeps a paragraph in capitals whole", () => {
    const source = `WARRANTIES
EXCEPT AS EXPRESSLY STATED IN THIS AGREEMENT, PROVIDER MAKES NO WARRANTIES OF ANY
KIND, WHETHER EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTY OF
MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.

LIMITATION OF LIABILITY
IN NO EVENT WILL EITHER PARTY BE LIABLE FOR ANY INDIRECT OR CONSEQUENTIAL DAMAGES,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
NO OTHER WARRANTIES ARE GIVEN.`;
    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["WARRANTIES", "LIMITATION OF LIABILITY"]);
    expectNothingLost(source, clauses);
    expect(clauses[0].body.endsWith("FITNESS FOR A PARTICULAR PURPOSE.")).toBe(true);
    expect(clauses[1].body.endsWith("NO OTHER WARRANTIES ARE GIVEN.")).toBe(true);
  });

  it("keeps addresses in capitals and NOTE: lines inside their clause", () => {
    const source = `This Agreement is made between

ACME CORPORATION
1200 MARKET STREET
SAN FRANCISCO, CA 94103

and

BETA HOLDINGS LIMITED
10 DOWNING ROAD
LONDON EC1A 1BB

SERVICES
Provider shall host the platform.
NOTE: Backups are kept for 30 days only.

FEES
Customer shall pay the fees monthly.
IMPORTANT: Fees exclude taxes.`;
    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Introduction", "SERVICES", "FEES"]);
    expect(clauses[0].body).toContain("BETA HOLDINGS LIMITED\n10 DOWNING ROAD");
    expect(clauses[1].body).toContain("NOTE: Backups are kept for 30 days only.");
    expect(clauses[2].body).toContain("IMPORTANT: Fees exclude taxes.");
  });

  it("keeps a list of exhibits inside its clause", () => {
    const source = `1. Services
Agency shall provide the services.

2. Entire Agreement
This Agreement includes the following exhibits:
Exhibit A - Statement of Work
Exhibit B - Pricing
Exhibit C - Data Processing Addendum

EXHIBIT A - STATEMENT OF WORK
Scope: [describe]

EXHIBIT B - PRICING
Fee: [amount]`;
    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Services", "Entire Agreement", "EXHIBIT A - STATEMENT OF WORK", "EXHIBIT B - PRICING"]);
    expect(clauses[1].body).toBe("This Agreement includes the following exhibits:\nExhibit A - Statement of Work\nExhibit B - Pricing\nExhibit C - Data Processing Addendum");
  });

  it("keeps a numbered list inside its clause, even when it's longer than the run of headings", () => {
    const source = `1. Overview
This Statement of Work covers the onboarding project.

2. Deliverables
The Agency will deliver:
1. Discovery Workshop
2. Brand Guidelines
3. Website Wireframes
4. Training Materials

3. Fees
The fee is [amount].`;
    const clauses = splitIntoClauses(source);
    expect(titles(clauses)).toEqual(["Overview", "Deliverables", "Fees"]);
    expect(labels(clauses)).toEqual(["1", "2", "3"]);
    expect(clauses[1].body).toBe("The Agency will deliver:\n1. Discovery Workshop\n2. Brand Guidelines\n3. Website Wireframes\n4. Training Materials");
  });
});

describe("importing a PDF with page headers and footers", () => {
  it("leaves out the header and page numbers that repeat on every page", async () => {
    const names = ["Services", "Fees", "Term", "Confidentiality", "Warranties", "Liability", "Notices", "Governing Law"];
    const body = () =>
      `Each party shall comply with this clause from the Effective Date. The Agency shall perform the work in a professional manner consistent with industry standards, and Client shall cooperate in good faith and provide timely feedback, approvals, information and access reasonably required for the work. Reasonable travel and lodging expenses approved in advance are reimbursed at cost. Any notice under this clause must be in writing and delivered to the addresses in the Notices clause.`;
    const pdf = await renderToBuffer(
      createElement(
        Document,
        null,
        createElement(
          Page,
          { size: "LETTER", style: { paddingTop: 72, paddingBottom: 72, paddingHorizontal: 56, fontSize: 11 } },
          createElement(Text, { fixed: true, style: { position: "absolute", top: 30, left: 56 } }, "CONFIDENTIAL"),
          createElement(Text, { fixed: true, style: { position: "absolute", bottom: 30, left: 56 }, render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) => `Page ${pageNumber} of ${totalPages}` }),
          ...names.flatMap((name, i) => [
            createElement(Text, { key: `h${i}`, style: { marginBottom: 4 } }, name.toUpperCase()),
            createElement(Text, { key: `b${i}`, style: { marginBottom: 12 } }, `${body()} ${body()}`),
          ]),
        ),
      ),
    );
    const text = await extractText(new File([new Uint8Array(pdf)], "msa.pdf", { type: "application/pdf" }));
    expect(text).not.toMatch(/^CONFIDENTIAL$/m);
    expect(text).not.toMatch(/Page \d+ of \d+/);
    const clauses = splitIntoClauses(text);
    expect(titles(clauses)).toEqual(names.map((n) => n.toUpperCase()));
    clauses.forEach((clause) => expect(words(clause.body)).toEqual(words(`${body()} ${body()}`)));
  });
});
