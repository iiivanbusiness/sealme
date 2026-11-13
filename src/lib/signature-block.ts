import type { Clause, ReviewClause, Segment } from "@/lib/template-fields";

// Finds the signature block an uploaded contract brings with it:
//
//   IN WITNESS WHEREOF, the parties have executed this Agreement ...
//   BETA MEDIA LLC                  ACME INC.
//   By: ____________                By: ____________
//   Name: John Roe                  Name: ____________
//   Title: CEO                      Title: ____________
//
// SealMe adds its own signature section when a contract goes out, so the
// file's block would be a second one nobody can sign, still holding the
// last client's signer and dates. The review screen shows what was taken
// with a way to keep it, but most people won't read it closely, so taking
// real terms by mistake is the worst outcome: when in doubt, keep.
//
// How it works, following how a contract is laid out: the block closes the
// contract, or one of its parts, right before the next part starts.
//   1. Every clause is cut into pieces (lines, and inside a line the labels,
//      blanks and sentences), and each piece is named for what it is: a
//      signature line, a Name:/Title:/Date: line, a party name, the
//      "IN WITNESS" sentence, a page footer, where the next part starts
//      ("EXHIBIT A", "STANDARD TERMS AND CONDITIONS", an e-signature
//      certificate), or anything else.
//   2. A block is found around each signature line (or the sentence that
//      says the parties sign below), walking back only over what sits above
//      a block (the testimony sentence, page notes, party names right over
//      a signature line) and on only over what sits inside one. Any other
//      line ends it, so billing details, bank instructions, contacts, notice
//      addresses or the heading of the next part stay put.
//   3. A block is only taken when it has something to sign on (a blank, a
//      typed /s/ signature, an e-signature stamp) and more than one line of
//      it, and when it ends the contract or a part: little but a few lines
//      of details between it and the next part or the end of the file, and
//      less of that than of the contract above it. One in the middle of the
//      terms also needs the sentence that says the parties sign.
//      A block taken only because it ends its part stays when a stronger
//      one (sworn, or with more lines to sign) still follows in that part.
//   4. Precision guards then look at each block found for what a signature
//      block never holds, and hand it back to the contract. They only
//      shrink a block or drop it, never grow one:
//        - guard 1: a sentence that says more than "the parties sign
//          this" stays, and splits the block. Every word of it must be
//          about signing, the parties, the document or its date; one word
//          of its own ("irrevocably", "jointly and severally") is a term;
//        - guard 2: what's left needs evidence of signing: a signer's line with a
//          blank or a typed /s/ name, an e-signature stamp with a service's
//          trace, or a certificate after it;
//        - guard 3: fields the terms list (under "... the following:", in a table's
//          row, or inside the terms with no party or Name/Title lines) stay;
//        - guard 4: someone else's contact details under a blank block stay;
//        - guard 5: a form in an exhibit or schedule, signed later when it's used,
//          keeps its lines.
//   5. Guard 6: an e-signature certificate or audit trail goes too: after a block it
//      runs on through the clauses that are more of it, and stops at the
//      next part, at any full sentence, or at the heading of something
//      else. Without a block before it, only its own heading with a
//      service's ID and signing events counts, within its own clause, along
//      with the signers' names and dates right over it when the
//      certificate names them too.
//
// Works on clauses from either splitter: one that keeps the file's line
// breaks, and one that runs a clause onto a single line, where the labels,
// blanks and sentence ends are what break it into pieces.

// A stretch of a clause's body that belongs to a signature block. A clause
// whose whole body is in one goes away with its title.
export type SignatureRange = { clause: number; start: number; end: number };

type Kind =
  | "testimony" // "IN WITNESS WHEREOF ...", "Agreed and accepted:", "By signing below ..."
  | "closing" // "Very truly yours," in a letter agreement
  | "pageNote" // "[Signature page follows]", "Signature Page to Master Services Agreement"
  | "sign" // where a party signs: "By: ____", "Signature: /s/ Jane Doe", "DocuSigned by:"
  | "line" // a bare signature line: "______________"
  | "signer" // "By: Beta Holdings, Inc.," (a company signing for another)
  | "person" // "Name: ...", "Title: ...", "Its: ..."
  | "date" // "Date: ...", "Dated: ..."
  | "contact" // "Email: ...", "Address: ...", "Phone: ..."
  | "initials" // "Initials: ____"
  | "stamp" // e-signature traces: envelope hashes, "Signed on ...", "IP Address: ..."
  | "caption" // "Authorized Signature", "Printed Name and Title" under a line
  | "signerLine" // signer details without a label: "Jane Doe, CFO", "Jane Doe", "October 15, 2026"
  | "party" // "BETA MEDIA LLC", "Acme Inc., a Delaware corporation", "CLIENT:"
  | "roleParty" // "CUSTOMER: ACME INC.", "Advertiser: Acme Inc."
  | "maybeParty" // another short name-like line: a party name only right above a signature
  | "roleSign" // "WITNESS: ____", "ATTEST: ____", a line to sign only where a block already is
  | "seal" // "(SEAL)", "[CORPORATE SEAL]"
  | "descriptor" // "a Delaware corporation", "its Managing Member", "By its authorized officer:"
  | "notary" // a notary's acknowledgment under the signatures
  | "sigHeading" // "SIGNATURES", "Client Approval", "AUTHORIZATION" as a line of its own
  | "artifact" // page footers and headers, "DocuSign Envelope ID: ..."
  | "part" // where the next part starts: "EXHIBIT A", "SCHEDULE 1", "STATEMENT OF WORK", ...
  | "cert" // "Certificate of Completion", "Final Audit Report", "Audit trail"
  | "label" // any other "Label: value" line: billing details, key terms, bank details
  | "prose";

// How a signature line was (or can be) signed.
type Capture = "blank" | "typed" | "stamp" | "filled" | "empty";
// What a signer-details line holds.
type Detail = "name" | "nameTitle" | "title" | "date";

// row: the line it's on, counted through the clause, so two columns run onto
// one line can be told apart from lines one under the other.
type Unit = { ci: number; row: number; start: number; end: number; text: string; kind: Kind; capture?: Capture; detail?: Detail; blank?: boolean; sworn?: boolean };

// ---------------------------------------------------------------------------
// Words and patterns
// ---------------------------------------------------------------------------

const ROLE = String.raw`(?:client|customer|agency|company|provider|service provider|vendor|media vendor|contractor|consultant|supplier|licensor|licensee|buyer|seller|purchaser|advertiser|publisher|sponsor|guarantor|witness|partner|owner|lessor|lessee|landlord|tenant|employer|distributor|reseller|subscriber|lender|borrower)`;
const ROLE_LINE = new RegExp(String.raw`^(?:the\s+)?${ROLE}(?:\s+${ROLE})*\s*:?$`, "i");
const ROLE_NAMED = new RegExp(String.raw`^${ROLE}\s*:\s*(.+)$`, "i");
const ENTITY = /(?:^|[\s,])(?:L\.?L\.?C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Ltd\.?|Limited|L\.?L\.?P\.?|L\.P\.|LP|P\.?L\.?L\.?C\.?|P\.C\.|P\.?L\.?C\.?|GmbH|S\.A\.|B\.V\.|N\.A\.|Co\.|Company)(?=$|[\s,.)])/i;
// Company forms from elsewhere, read only at the end of a name in the case
// they're written in ("Acme Nordic AS"), as "AS" or "SA" inside
// a line in capitals is a word.
// A form written as initials with full stops ("s.r.o.", "a.s.", "P.A.",
// "S.p.A.") is one too, whatever the country.
const ENTITY_TAIL = /\s(?:AS|ASA|AB|AG|Oy|Oyj|SA|SAS|SARL|SRL|SpA|NV|KK|Pty\.?\s+Ltd\.?|Pvt\.?\s+Ltd\.?|Private Limited|Sp\. z o\.o\.|(?:\p{L}{1,3}\.){2,})$/u;
const INITIALS_FORM = /^(?:\p{L}{1,3}\.){2,},?$/u;
const NAME_CONNECTOR = /^(?:of|and|the|for|de|la|du|von|van|der|&|\+|[-\u2013\u2014|])$/i;

// Where a party signs. Matched against the label in front of the colon (or
// in front of a blank, in a Word form with no colons).
const SIGN_LABEL = new RegExp(
  String.raw`^(?:` +
    [
      String.raw`(?:\p{Lu}[\p{L}&'’./-]*\s+){0,3}(?:Authori[sz]ed\s+)?[Ss]ignature(?:\s+of\s+(?:the\s+)?\p{L}[\p{L}\s]{2,40}?)?`,
      String.raw`B[yY]`,
      String.raw`(?:Docu[Ss]igned|Signed)(?:\s+[Bb]y)?`,
      String.raw`(?:Accepted|Approved|Agreed|Acknowledged)(?:\s+(?:and\s+(?:Accepted|Agreed)\s+)?[Bb]y(?:\s+(?:the\s+)?\p{Lu}[\p{L}'’]+){0,3})?`,
      String.raw`(?:\p{Lu}[\p{L}&'’.-]*\s+){1,3}Approval`,
    ].join("|") +
    String.raw`)$`,
  "u",
);
// A label in capitals ("SIGNATURE", "SIGNED BY") reads like its title-case form.
function isSignLabel(label: string): boolean {
  return SIGN_LABEL.test(label) || (isAllCaps(label) && SIGN_LABEL.test(label.toLowerCase().replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase())));
}
const STAMP_SIGN = /^(?:Docu[Ss]igned|Signed)\s+[Bb]y$/;
// Values a field about signing takes that are no one's name.
const NOT_SIGNED = /\b(?:permitted|required|allowed|accepted|electronic|optional|pending|yes|no|none|not|n\/a|wet|ink)\b/i;
// The signer's details, a witness's too ("Name of witness:", "Occupation:").
const PERSON_LABEL = /^(?:(?:(?:printed|print|typed|full)\s+)?name(?:\s*(?:and|&|\/)\s*title)?(?:\s+of\s+(?:witness|signatory|signer))?|witness(?:['’]s)?\s+(?:name|occupation)|title|its|position|capacity|occupation|designation|place(?:\s+of\s+(?:signing|execution))?)$/i;
// The signer's role, which may be written in lower case, as titles in
// other languages often are ("Title: gérant"), where a name couldn't be.
const ROLE_FIELD = /^(?:title|its|position|capacity|designation)$/i;
// A party's name as a field to fill in ("Company Name: ____", "Client
// name:", and "Legal Name:" in a party's column under its role).
const ROLE_NAME = new RegExp(String.raw`^(?:${ROLE}(?:['’]s)?\s+(?:legal\s+|full\s+)?|legal\s+)name$`, "i");
// "For ACME HOSTING LTD.:", "Signed for and on behalf of ACME INC.", "For Client:".
const FOR_PARTY = /^(?:(?:signed|executed|accepted|agreed)\s+)?(?:for(?:\s+and)?\s+on\s+behalf\s+of|on\s+behalf\s+of|for)(:?)\s+(.+?)\s*(:?)$/i;
const DATE_LABEL = /^(?:date(?:\s+signed)?|dated|signed\s+date|signature\s+date|execution\s+date)$/i;
const CONTACT_LABEL = /^(?:witness(?:['’]s)?\s+)?(?:e-?mail|address|phone|telephone|tel|fax)$/i;
// Terms that send notices to the address printed with a party's signature.
const NOTICES_BELOW = /\baddress(?:es)?\b[^.;]{0,80}\b(?:below|under|beneath|beside|with|on|in|at|after|following|next to)\b[^.;]{0,30}\bsignatures?\b|\bsignature (?:page|block)\b[^.;]{0,60}\baddress/i;
// A party's address written out ("Address: 100 Main Street, Springfield,
// IL 62701"), not a witness's and not a blank to fill in.
function isPartyAddress(t: string): boolean {
  const colon = t.indexOf(":");
  return colon > 0 && /^(?:(?:notice|mailing|business|registered|principal)\s+)?address$/i.test(t.slice(0, colon).trim()) && /\d/.test(t.slice(colon + 1));
}
const INITIALS_LABEL = /^(?:\p{Lu}\p{L}*\s+)?initials$/iu;
// Who attests or witnesses the signature ("ATTEST:", "Witnessed by:").
const WITNESS_LABEL = /^(?:attest(?:ed)?|witness(?:es|ed)?)(?:\s+by)?$|^(?:signed\s+)?in the presence of$/i;
const SEAL = /^[[(]?\s*(?:(?:corporate|company|common|notarial)\s+)?seal\s*[\])]?$/i;

// The sentence that says the parties sign. "Please sign" and "To accept
// this proposal" sentences only count when they're about signing alone:
// "To accept this proposal, Client must sign the Order Form within 30 days"
// or "... and authorize Agency to begin work" are terms.
const SWORN = new RegExp(
  "^(?:" +
    [
      String.raw`in witness (?:whereof|thereof)|as witness (?:whereof|the|our|their)\b|intending to be legally bound|signed,? sealed,? and delivered\b|executed (?:by|as of)\b`,
      String.raw`(?:the parties|each party|both parties|the undersigned)(?: hereto)? (?:have|has) (?:duly )?(?:executed|signed|caused)\s+(?:this|these)\b`,
      // "The parties' authorized representatives approve this Statement of
      // Work:", "Each party's authorized representative has signed this ...".
      String.raw`(?:the parties|each party)['’]?s? (?:duly )?authori[sz]ed (?:representatives?|signator(?:y|ies)|officers?) (?:ha(?:ve|s) (?:executed|signed|approved)|approves?|accepts?|executes?|signs?)\s+(?:this|these)\b`,
      // "This Agreement has been duly executed by ...", and the English
      // "This Agreement has been entered into on the date stated at the beginning of it."
      String.raw`this [\w ]{2,40}? (?:has|have) been (?:duly )?(?:(?:executed|signed) by|entered into on the date)\b`,
      String.raw`signed (?:as of|by (?:the parties|(?:the|their|its|each party['’]s) (?:duly )?authori[sz]ed (?:representatives?|signator(?:y|ies)|officers?)))\b`,
    ].join("|") +
    ")",
  "i",
);
// "Agreed and accepted", "Agreed to by the parties as of the Effective Date:",
// "Accepted for and on behalf of Client".
const ACCEPTED = new RegExp(String.raw`^(?:(?:accepted|agreed|acknowledged|approved)(?: to)?,? (?:and|&) (?:accepted|agreed|acknowledged|approved)\b|(?:accepted|agreed|approved|acknowledged)(?: to)? (?:by|for)(?: and on behalf of)?(?: the)? (?:${ROLE}|parties)\b|(?:accepted|agreed|acknowledged)(?: (?:to|and accepted))? as of\b)`, "i");
// "ACCEPTED BY STAFFING FIRM": a heading that names who accepts, and nothing more.
const ACCEPTED_BY = /^(?:accepted|agreed|approved|acknowledged)(?: to)? (?:by|for)(?: and on behalf of)? (.{2,60}?):?$/i;
const SIGN_BELOW = /^(?:by signing (?:below|this)|by (?:their|its) signatures? below|to accept this (?:proposal|agreement|order|quote|estimate|offer|sow|statement of work)\b|please (?:sign|execute)\b|sign below\b)/i;
// A request to sign further into the sentence: "If these terms reflect our
// understanding, please sign below and return a copy to me."
const SIGN_CUE = /\b(?:sign(?:ing)?|execut(?:e|ing))\b[^.;]{0,30}\b(?:below|hereunder|where indicated)\b|\bsign,? (?:and|&) (?:date|return)\b|\bplease (?:sign|countersign|execute)\b/i;
const CLOSING = /^(?:very truly yours|yours (?:very )?truly|sincerely(?: yours)?|respectfully(?: yours| submitted)?|(?:best|kind|warm) regards|regards|cordially),?$/i;
const PAGE_NOTE = /^[[(]?\s*(?:(?:the )?signatures? pages? (?:follows?|to follow)|remainder of (?:this )?page (?:is )?(?:intentionally )?left blank|(?:the )?signatures? (?:appear |are )?on (?:the )?(?:following|next) page|signature page (?:to|for)\b|this page (?:is )?intentionally left blank)[^\])]*[\])]?\.?$/i;

// The start of the next part of the file, which a block never runs into.
// After "Exhibit", "Schedule" and the like comes a number or a letter
// ("EXHIBIT A", "Schedule 2", "Annex IV"), or "of"/"to" and a name in
// capitals ("Schedule of Fees", "Rider to Master Lease"): the pattern reads
// any one or two letters (group 1), and isPartHeading keeps only those.
const PART = /^(?:(?:exhibit|schedule|annex|appendix|attachment|addendum|rider)\s+(?:([a-z]{1,2})|\d{1,3}|[IVX]{1,5})(?![\p{L}\d])|statement of work\b|(?:standard |general )?terms (?:and|&) conditions\b|terms of service\b|(?:insertion|work|change|purchase) order\b|order form\b)/iu;
// Words that follow "Schedule" in a sentence ("Schedule a call") or in a
// heading ("SCHEDULE OF FEES"), never a part's letter. A capital "A" is
// the exception (see isPartLetter): "EXHIBIT A" is the most common part.
const NOT_PART_LETTER = /^(?:a|an|as|at|by|in|is|it|of|on|or|to|up|we)$/i;
// Whether the letter after "Exhibit", "Schedule" and the like names a part:
// a capital letter that isn't a short word, or a capital "A" not followed
// by more of a sentence ("EXHIBIT A - CHANGE ORDER FORM", "Exhibit A Fees",
// but not "Exhibit A sets out the fees").
function isPartLetter(letter: string, rest: string): boolean {
  if (letter !== letter.toUpperCase()) return false;
  if (!NOT_PART_LETTER.test(letter)) return true;
  return letter.length === 1 && !/^\s+\p{Ll}/u.test(rest);
}
// "Change Order No.: ____", "Purchase Order: 4500012345": a field that
// names a document, not the heading of one.
const PART_LABEL = /^\s*(?:No\.?|Nos\.?|Number|Num\.?|#|ID|Ref(?:erence)?\.?)?\s*(?::(?!\s*$)|_{3,})/i;
// "Order Form Effective Date: ____", "Purchase Order Number (if required):
// ____": more words of a label after the document's name, written in the
// name's case, then a colon and a blank or a short value. That's a field of
// the form, not where a part starts; read as a heading, it would hide the
// part's real heading ("EXHIBIT A - ORDER FORM") from guard 5. A heading in
// capitals run on into a label in title case ("STATEMENT OF WORK Overview:
// This SOW covers ...") still starts its part.
const PART_FIELD = /^\s+(\p{L}+(?:\s+\p{L}+){0,3})(?:\s*\([^()]{1,30}\))?\s*:\s*(.*)$/u;
function namesField(name: string, rest: string): boolean {
  const m = PART_FIELD.exec(rest);
  if (!m || isAllCaps(name) !== isAllCaps(m[1])) return false;
  const value = m[2].trim();
  return !!value && (ONLY_BLANKS.test(value) || (wordCount(value) <= 6 && !/[.!?;]$/.test(value)));
}
// A part's heading, not a field named after one or a sentence that starts
// with one ("Exhibit B sets out the fees for each Deliverable.").
function isPartHeading(t: string): boolean {
  const m = PART.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length);
  // "EXHIBIT A", or "Schedule of Fees"; not "Schedule a call".
  const letter = m[1];
  if (letter && !isPartLetter(letter, rest) && !(/^(?:of|to)$/i.test(letter) && /^\s+\p{Lu}/u.test(rest))) return false;
  if (!/^(?:exhibit|schedule|annex|appendix|attachment|addendum|rider)\b/i.test(m[0]) && (PART_LABEL.test(rest) || namesField(m[0], rest))) return false;
  // A line that reads as a sentence ("EXHIBIT A is attached and made part
  // of this Agreement.") names a part; it doesn't start one.
  return !(/^\s+\p{Ll}/u.test(rest) && /[.;]$/.test(t) && wordCount(t) >= 6);
}
// An e-signature service's certificate or audit trail, and what confirms it
// is one: a real envelope or transaction ID that only such a service writes
// (a term or a feature list names the fields, "envelope ID, signer IP
// address", without values), or an IP address beside a signing event, and
// two traces in all. Words like "viewed" or "timestamp" alone are also what
// a term about audit trails says, and an IP address alone is what a
// security term lists ("Office gateway IP: 192.0.2.10").
const CERT = /^(?:certificate of completion|signature certificate|final audit report|audit (?:trail|history|report)|document history)\b/i;
// The headings only an e-signature service gives its pages, which can stand
// without a block found before them.
const CERT_OWN = /^(?:certificate of completion|signature certificate|final audit report|audit trail)\b/i;
const IP_VALUE = /\bIP(?: address)?\s*:?\s*\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/i;
const ID_LABEL = /\b(?:envelope ?id|transaction id|document id|agreement id)\s*:?\s*([A-Za-z0-9-]{16,})/gi;
// An envelope or transaction ID with its value: 16 or more letters and
// digits, at least two of them digits ("Document ID: SOW-2026-114" is a
// document number).
function hasIdValue(text: string): boolean {
  for (const m of text.matchAll(ID_LABEL)) if ((m[1].match(/\d/g)?.length ?? 0) >= 2) return true;
  return false;
}
function hasServiceId(text: string): boolean {
  return hasIdValue(text) || IP_VALUE.test(text);
}
// The events a trail records, each with its date or time.
const EVENTS = [/\b(?:sent|viewed|signed|completed|delivered|accepted|created|e-?signed)\b\s*(?:on|by|:)?\s*\d/i, /\bstatus\s*:\s*(?:completed|signed)\b/i];
const AUDIT_TRACES = [...EVENTS, /\d{1,2}:\d{2}/, /\btimestamps?\b/i];
function isAuditTrail(text: string): boolean {
  if (!hasIdValue(text) && !(IP_VALUE.test(text) && EVENTS.some((re) => re.test(text)))) return false;
  return 1 + AUDIT_TRACES.filter((re) => re.test(text)).length >= 2;
}
// Words a certificate's lines use and the heading of another part doesn't.
const CERT_WORDS = /\b(?:envelope|signers?|signatures?|signed|signing|sent|viewed|delivered|completed?|completion|status|ip|timestamps?|events?|documents?|recipients?|created|e-?mail|security|authentication|certificate|holder|location|hashed|encrypted|originator|initials|pages?|record|tracking|disclosure|accepted|agent|editor|intermediary|carbon|witness|notary|summary|history|audit|transaction|agreement|report|verified|consent|approved|declined|voided)\b/i;
// The titles a splitter makes of a certificate's own sections.
const CERT_PART = /\b(?:signers?|recipients?|envelope|events|audit|history|certificate|summary)\b/i;
// A heading in capitals with none of those words, over lines that are no
// trail either ("SUPPORT" over "Response time: 4 hours"):
// the certificate ended and the file goes on.
// A zone ("UTC") or a heading over a number (an event's row) is no such
// heading, nor is a company's name.
const CAPS_HEAD = /^(?:\p{Lu}[\p{Lu}&'’.-]+\s+){0,5}\p{Lu}[\p{Lu}&'’.-]+(?![\p{L}\d])/u;
function endsCertificate(t: string, next = ""): boolean {
  const head = CAPS_HEAD.exec(t)?.[0];
  if (!head || head.replace(/[^\p{L}]/gu, "").length < 4 || CERT_WORDS.test(head) || ENTITY.test(wordCount(t) <= 6 ? t : head)) return false;
  const rest = t.slice(head.length).trim() || next;
  return !/^\d/.test(rest) && !CERT_WORDS.test(rest) && !hasServiceId(rest) && !EVENTS.some((re) => re.test(rest));
}
// DocuSign's consent text closes its certificate: its own heading, then
// paragraphs about paper copies and withdrawing consent.
const ERSD = /^electronic record and signature disclosure\b(?!\s*:)/i;
// A sentence of terms: someone shall, will, may or must do something ("May"
// before a day is a date), or an amount of money.
const TERMS = /\b(?:shall|will|must|may)\b(?!\s+\d)|[$€£¥]\s?\d|\b(?:USD|EUR|GBP|CAD|AUD)\s?\d|\d\s?(?:USD|EUR|GBP|dollars)\b/;

// A notary's acknowledgment: the venue lines ("STATE OF NEW YORK )", "ss.:")
// on their own, or the wording only an acknowledgment has.
const NOTARY = /^(?:(?:state|county|commonwealth|parish) of [\p{L} .]{2,30}(?:\s*\)|$)|\)?\s*ss\.?\s*:?\s*\)?$)|personally appeared|\bnotary public\b|my commission expires/iu;
// What's printed under a signature line, in parentheses or not, and once per
// column ("Signature Signature").
const CAPTION_WORDS = String.raw`\(?(?:(?:client|customer|agency|company|party|witness)\s+)?(?:authori[sz]ed\s+)?(?:signature(?:\s+of\s+[\p{L}\s]{2,40}?)?|signer|(?:printed|print|typed)\s+name(?:\s+(?:and|&)\s+title)?|name(?:\s+(?:and|&)\s+title)?|title|date|witness|signatory)\)?`;
const CAPTION = new RegExp(String.raw`^${CAPTION_WORDS}(?:\s+${CAPTION_WORDS}){0,2}$`, "iu");
const CAPTION_ROW = new RegExp(String.raw`^${CAPTION_WORDS}(?:\s+${CAPTION_WORDS}){1,2}$`, "iu");
// One caption, though its words could also be read as two ("Witness signature").
const CAPTION_ONE = new RegExp(String.raw`^${CAPTION_WORDS}$`, "iu");
const PERSON_NAME = String.raw`\p{Lu}[\p{L}'’-]+(?:\s+(?:\p{Lu}\.|\p{Lu}[\p{L}'’-]+)){1,3}`;
const DESCRIPTOR = new RegExp(
  "^(?:" +
    [
      // "a Delaware corporation", "an individual"
      String.raw`(?:a|an)\s+(?:\p{Lu}[\p{L}.-]*\s+){0,3}(?:(?:limited liability|professional|public benefit|nonprofit|non-profit|benefit|close|stock)\s+)?(?:company|corporation|partnership|limited partnership|LLC|L\.L\.C\.|association|trust|individual|sole proprietorship)\b[^.]{0,30}`,
      String.raw`its\s+(?:\p{Lu}[\p{L}-]*\s*){1,4}|individually`,
      String.raw`By (?:its|their|his|her)\b[^:_]{0,40}:?`,
      String.raw`(?:[Ss]igned\s+)?(?:[Ff]or\s+and\s+)?[Oo]n\s+[Bb]ehalf\s+of(?:\s+[^:_]{2,60})?:?`,
      // A UK block's "Signed by John Roe", over "for and on behalf of ...",
      // and a deed's "EXECUTED as a DEED by" over who executes it.
      // "Signed by [NAME OF DIRECTOR]" in a blank template.
      String.raw`(?:Signed|SIGNED|Executed|EXECUTED)(?:\s+as\s+a\s+(?:deed|DEED))?\s+(?:by|BY)(?:\s+(?:${PERSON_NAME}|\[[^\]]{2,60}\]))?`,
      // "acting by a director in the presence of a witness:", "acting by
      // Jane Doe, Director": who signs for a company.
      String.raw`(?:\p{Lu}[\p{L}.]*\s+){0,2}acting\s+by\b[^:_]{0,60}:?`,
    ].join("|") +
    ")$",
  "u",
);
// A page of its own per party may name whose it is ("SIGNATURE PAGE -
// PROVIDER", "Signatures (Customer)").
const SIG_HEADING = new RegExp(
  String.raw`^(?:(?:client|customer|agency|vendor|company|party|parties['’]?|order|proposal)\s+)?(?:signatures?|signature page|signatures of the parties|signature block|execution(?: page)?|authori[sz]ations?|acceptance|approvals?|sign-?off|counter-?signatures?|response|acknowledge?ments?)(?:\s+[-\u2013\u2014]\s+(?:the\s+)?${ROLE}|\s+\((?:the\s+)?${ROLE}\))?$`,
  "i",
);
// A clause with one of these titles that only names who signs ("For
// Client: Acme Inc., by Jane Doe, CFO") is the block, labels or not.
const SIGNATURES_TITLE = /^(?:signatures?|signature page|signatures of the parties|signature block|execution page)$/i;
const SIGNER_STATEMENT = /^(?:[Ff]or|[Oo]n behalf of)\s+[^:]{2,60}:?\s+.{0,80}\bby\s+\p{Lu}[\p{L}.'’-]+(?:\s+\p{Lu}[\p{L}.'’-]+){1,3}\b.{0,60}$/u;

const ARTIFACT = /^docu\s?sign envelope id\b|^-{1,2}\s*\d+(?:\s+of\s+\d+)?\s*-{1,2}$|(?:^|\s[-\u2013\u2014|]\s)confidential(?:\s[-\u2013\u2014|](?:\s|$)|$)/i;
// A page number in a footer ("Page 4 of 6", "MSA | Page 2"), not one a
// sentence points to ("Late fees are set out on page 2.").
function isPageMark(t: string): boolean {
  return /\bpage \d+\s+of\s+\d+\b|^\W*page \d+\W*$/i.test(t) || (/\bPage \d+\b/.test(t) && !/[.!?]$/.test(t));
}

const NAME_ONLY = new RegExp(`^${PERSON_NAME}$`, "u");
// Words in a heading that are never in a person's name ("Customer Billing Details").
// A label in a table's cell ("Account Number", "Project Kickoff") is no name either.
const NOT_NAME = /\b(?:details|information|info|billing|terms|schedule|payment|contacts?|address|summary|notes|overview|pricing|fees?|services?|scope|deliverables|agreement|order|proposal|invoice|instructions|signatures?|acceptance|approval|section|exhibit|total|plan|program|package|form|page|options?|next|steps)\b/i;
const NAME_TITLE = new RegExp(`^${PERSON_NAME},\\s*(.+)$`, "u");
const NAME_STAMP = new RegExp(`^${PERSON_NAME}\\s*\\([^)]{0,40}\\d{4}[^)]{0,40}\\)$`, "u");
const TITLE_WORD = /\b(?:officer|president|director|manager|partner|member|owner|principal|founder|chair\w*|ceo|cfo|coo|cto|cmo|cro|cio|vp|svp|evp|head|lead|counsel|secretary|treasurer|controller|consultant|executive|attorney|agent|representative|signatory|individually|trustee|administrator|coordinator|specialist|associate|advisor|strategist|producer|editor|designer)\b/i;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?`;
const ONE_DATE = String.raw`(?:${MONTH}\s+\d{1,2},?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH},?\s+\d{4}|\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}|\d{4}-\d{2}-\d{2})(?:\s*(?:\||at|,)?\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]\.?M\.?)?(?:\s*[A-Z]{2,4}\b)?)?`;
const DATE_ONLY = new RegExp(String.raw`^(?:${ONE_DATE}\s*)+$`, "i");
// A filled date line that ran on into whatever follows, in a clause run
// onto one line: "Date: 10/15/2026 Payment Instructions ...".
const DATE_HEAD = new RegExp(String.raw`^(?:Date(?:\s+Signed)?|Dated|Signed on)\s*:?\s*${ONE_DATE}`, "i");
const DATE_ANYWHERE = new RegExp(String.raw`(?<![\w/])(?:${MONTH}\s+\d{1,2},?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+${MONTH},?\s+\d{4}|\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}|\d{4}-\d{2}-\d{2})`, "gi");
const TITLE_THEN_NAME = /(\b(?:Officer|President|Director|Manager|Partner|Member|Owner|Principal|Founder|CEO|CFO|COO|CTO|CMO|CRO|VP|Counsel|Secretary|Treasurer|Controller)\s+)(?=\p{Lu}[\p{Ll}'’-]+\s+\p{Lu}[\p{Ll}'’-]+,|(?:\p{Lu}[\p{L}'’.-]*|&)(?:\s+(?:\p{Lu}[\p{L}'’.-]*|&)){0,5},?\s+(?:L\.?L\.?P|L\.?L\.?C|Inc|Corp|Ltd|LP|PLLC|P\.C)\.?(?![\p{L}]))/gu;
const TYPED_THEN_NAME = /^\/s\/\s*(\p{Lu}[\p{L}.'’-]+(?:\s+\p{Lu}[\p{L}.'’-]+){1,2})\s+(?=\1(?![\p{L}]))/u;
// Chunks apart only at spaces, so a long run of hex digits is read once.
const HASH = /^[0-9A-F]{8,}(?:\.{3}|…)?(?:\s+[0-9A-F]{8,}(?:\.{3}|…)?)*$/;
// An e-signature hash mixes letters and digits; a run of digits alone is an
// account, order or reference number ("40061234567890").
function isHash(t: string): boolean {
  return HASH.test(t) && /[A-F]/.test(t) && (t.match(/\d/g)?.length ?? 0) >= 2;
}
const ESIGN = /^(?:(?:electronically|digitally)\s+signed\b|signed\s+(?:electronically|on)\b|verified by\b)/i;
// Small words a service's trace uses between who signed, when and how.
const STAMP_JOINS = /^(?:by|on|at|via|using|with|from|and|of|to|in|the)$/i;
// "Electronically signed by Jane Doe 10/02/2026 3:41 PM": the words, then
// who signed, when, or an ID. A sentence that starts the same way
// ("Digitally signed copies have the same effect as originals.", "Signed on
// the dates below, this Agreement binds each party ...") is a term: it runs
// on in words in lower case.
function isEsignStamp(t: string): boolean {
  const m = ESIGN.exec(t);
  // A blank to fill in ("Verified by: ____") is a field, never a trace.
  if (!m || TERMS.test(t) || wordCount(t) > 30 || UNDERSCORES.test(t)) return false;
  const words = t.slice(m[0].length).split(/\s+/).filter((w) => /^\p{Ll}+[,.;:]?$/u.test(w) && !STAMP_JOINS.test(w.replace(/[,.;:]$/, "")));
  return words.length < 2;
}
const IP_LINE = /^IP(?:\s+address)?\s*:/i;
const TYPED = /^(?:\/s\/\s*\S|s\/\s*\p{Lu})/u;
const ONLY_BLANKS = /^[\s_.…:\-\u2013\u2014]*$/;
// A line to write on: underscores, or the dots a UK or Indian form uses.
const UNDERSCORES = /_{3,}|\.{5,}|…{3,}/;
const BLANKS = /_{3,}|\.{5,}|…{3,}/g;

// ---------------------------------------------------------------------------
// Cutting a line into pieces
// ---------------------------------------------------------------------------

// Labels that always start a piece of their own.
const CUT_SIGN = new RegExp(
  [
    // "Management signature:", "Witness Signature:", "Driver Signature:"
    String.raw`\b\p{Lu}\p{Ll}+\s+[Ss]ignature\s*:`,
    // "Signature:", "Client Signature:", "Authorized Buyer Signature:", "Customer Representative Signature:"
    String.raw`(?:Authori[sz]ed\s+)?(?:(?:Client|Customer|Agency|Company|Provider|Vendor|Contractor|Consultant|Supplier|Advertiser|Publisher|Party|Licensee|Licensor|Buyer|Seller|Purchaser|Employee)(?:['’]s)?\s+)?(?:Representative\s+|Authori[sz]ed\s+)?Signature(?:\s+of\s+Authori[sz]ed\s+Representative)?\s*:`,
    String.raw`\bB[yY](?=\s*:|\s+(?:its|their|his|her)\s)`,
    String.raw`(?:Docu[Ss]igned|Signed)\s+[Bb]y\s*:|\bSigned on\b|(?:Electronically|Digitally) signed\b|\bIP(?:\s+Address)?\s*:`,
    String.raw`\b(?:Accepted|Approved)(?:\s+[Bb]y)?\s*:`,
    // "ATTEST:", "Witnessed by:" beside a party's name
    String.raw`\b(?:ATTEST(?:ED)?|Attest(?:ed)?|WITNESS(?:ES|ED)?|Witness(?:es|ed)?)(?:\s+(?:BY|[Bb]y))?\s*:`,
    String.raw`\b(?:AUTHORI[SZ]ED )?SIGNATURE\s*:|(?<!DATE\s)\b(?:DOCU)?SIGNED(?: BY)?\s*:|(?<![Dd]ate\s)\bSigned\s*:`,
  ].join("|"),
  "gu",
);
// Labels that may be the end of a longer one ("Contact Name:", "Start
// Date:"), so they're only cut where something else came before them.
const CUT_FIELD = new RegExp(
  [
    String.raw`(?:(?:Printed|Print|Typed)\s+)?\bName(?:\s+and\s+Title)?\s*:`,
    String.raw`\b(?:Title|Its|Dated|Phone|Initials|Designation|Position|Capacity|Place)\s*:`,
    String.raw`\bDate(?:\s+Signed)?\s*:`,
    String.raw`\bE-?mail\s*:`,
    String.raw`\bAddress(?:\s+for\s+[Nn]otices?)?\s*:`,
    String.raw`(?:(?:PRINTED|PRINT)\s+)?\bNAME\s*:`,
    String.raw`\b(?:TITLE|ITS)\s*:`,
    String.raw`\bDATE(?:\s+SIGNED)?\s*:`,
    String.raw`\bE-?MAIL\s*:`,
  ].join("|"),
  "g",
);
const CUT_START = new RegExp(
  [
    String.raw`\b(?:IN WITNESS|In Witness|INTENDING TO BE LEGALLY BOUND|ACCEPTED AND AGREED|AGREED AND ACCEPTED|AGREED TO AND ACCEPTED|ACKNOWLEDGED AND AGREED|ACCEPTED BY)\b`,
    String.raw`\b(?:Certificate [Oo]f Completion|Signature Certificate|Final Audit Report|Audit [Tt]rail|Document History)\b`,
    String.raw`\b(?:Signature Page|SIGNATURE PAGE) (?:to|for|TO|FOR)\b`,
    String.raw`\bDocu[Ss]ign Envelope ID\b`,
  ].join("|"),
  "gu",
);
// Where the next part may start inside a line.
const CUT_PART = new RegExp(
  [
    String.raw`\b(?:EXHIBIT|Exhibit|SCHEDULE|Schedule|ANNEX|Annex|APPENDIX|Appendix|ATTACHMENT|Attachment|ADDENDUM|Addendum)\s+(?:[A-Z]{1,2}|\d{1,3}|[IVX]{1,5})(?![\p{L}\d])`,
    String.raw`\bSTATEMENT OF WORK\b|\bStatement of Work No\b`,
    String.raw`\b(?:STANDARD |GENERAL )?TERMS AND CONDITIONS\b`,
    String.raw`\b(?:INSERTION|WORK|CHANGE|PURCHASE) ORDER\b|\bORDER FORM\b`,
  ].join("|"),
  "gu",
);
// Small words that put a part's name inside a sentence ("deemed accepted
// under Exhibit B", "as set out in Schedule 2") or inside a longer heading
// ("FORM OF CHANGE ORDER").
const REFERS = /^(?:under|per|see|including|pursuant|into|within|its|this|that|such|each|any|an?|as|or|via)$/i;
// A party's role as a label: in capitals ("... Chief Executive Officer
// CLIENT: ACME INC."), in title case before a name, a blank or a blank
// template's stand-in ("SIGNATURES Customer: Beta Inc.", "Acme LLC
// Customer: [Customer Legal Name]"), or in front of "Name" ("Company Name:
// ____").
const ROLE_TITLE = ROLE.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());
const CUT_ROLE = new RegExp(String.raw`(?<![\p{L}\d])(?:${ROLE.toUpperCase()}(?=\s*:)|${ROLE_TITLE}(?=\s*:\s*[\p{Lu}_[])|(?:${ROLE_TITLE}|${ROLE.toUpperCase()})(?:['’]s)?\s+(?:Legal\s+|LEGAL\s+)?(?:Name|NAME)(?=\s*:))`, "gu");
const CLOSING_IN_LINE = /\b(?:Very truly yours|Yours (?:very )?truly|Sincerely(?: yours)?|Respectfully(?: yours| submitted)?|(?:Best|Kind|Warm) regards|Regards|Cordially),\s+(?=\p{Lu}|\/s\/)/gu;
const PAGE_NOTE_IN_LINE = /\[[^\]]{0,120}?\b(?:signature|page|blank|seal)\b[^\]]{0,120}\]/gi;
const CAPS_RUN = /(?<![\p{L}\d&'’.,-])\p{Lu}[\p{Lu}&'’.,-]+\s+\p{Lu}[\p{Lu}&'’.,-]+/gu;
// A sentence ends here and the next starts, unless the word before the
// period is an abbreviation or an initial ("Acme Inc.", "Jane Q. Doe").
const SENTENCE_END = /[.!?]["'’”)\]]*[ \t]+(?=["“'(\[]?[A-Z0-9\[_])/g;
const ABBREVIATIONS = new Set(["inc", "co", "corp", "ltd", "llc", "llp", "lp", "pllc", "plc", "no", "nos", "mr", "mrs", "ms", "dr", "st", "jr", "sr", "sec", "art", "vs", "etc", "approx", "dept", "ave", "blvd", "rd", "ste", "fl", "attn", "tel", "n.a", "u.s", "e.g", "i.e"]);

// The last word before `at`, read backwards from there so that a long line
// costs only the word's length, not the line's.
function wordBefore(line: string, at: number): string {
  let end = at;
  while (end > 0 && /\s/.test(line[end - 1])) end--;
  let start = end;
  while (start > 0 && !/\s/.test(line[start - 1])) start--;
  return line.slice(start, end);
}

// The last cut at or before a position, for positions that only grow along
// the line: one pointer through the cuts made so far, sorted once, so a long
// line with many cuts stays linear.
function lastCutBefore(cuts: ReadonlySet<number>): (at: number) => number {
  const sorted = [...cuts].sort((a, b) => a - b);
  let p = 0;
  return (at) => {
    while (p < sorted.length && sorted[p] <= at) p++;
    return p ? sorted[p - 1] : 0;
  };
}

// How far back a row of captions or a label's first words can start: past
// that, what's before a blank or a label is a sentence, not either one.
const SHORT_RUN = 240;
const MONTH_ONLY = new RegExp(`^${MONTH}$`, "i");
const MONTH_FIRST = new RegExp(`^${MONTH}\\s`, "i");
// Small words that join a name or role to what's before it.
const JOINS = /^(?:for|to|by|of|and|the|with|from|between|on|in|at)$/i;
// A name in title case with a signing date in brackets, inside a line.
const INLINE_STAMP = new RegExp(String.raw`(?<![\p{L}\d'’-])\p{Lu}\p{Ll}[\p{L}'’-]*(?:\s+(?:\p{Lu}\.|\p{Lu}\p{Ll}[\p{L}'’-]*)){1,3}\s*\((?:\p{L}{3,9}\.?\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})[^()]{0,30}\)`, "gu");

// What comes right before an e-signature trace's IP address.
const IP_LEAD = /^(?:using|from|via|by|at)$|[\d),|;]$|^(?:[AP]\.?M\.?|UTC|GMT|[A-Z]{2,4}T)$/i;
// The end of a document's name, as a running header prints it.
const DOCUMENT_NAME = /\b(?:agreement|contract|addendum|amendment|order form|statement of work)$/i;

// A label in lower case after a field's blank, which a splitter ran on:
// "submitted by:", "prepared for:".
const LOWER_LABEL = /^\s+(?=\p{Ll}[\p{L}'’-]*(?:\s+[\p{L}'’()-]+){0,3}\s*:)/u;
// A short label next: "Change No.:", "Description of change:".
const LABEL_AHEAD = /^\p{Lu}[^:!?\n]{0,40}:/u;
// "Date:", "Name:", "By:", "Signature (authorized):": a field's own label,
// which its blank follows.
function isFieldHead(head: string): boolean {
  const m = /^([^:]{1,40}):$/.exec(head);
  if (!m) return false;
  const label = m[1].replace(/\s*\([^)]*\)/g, "").trim();
  return DATE_LABEL.test(label) || PERSON_LABEL.test(label) || INITIALS_LABEL.test(label) || isSignLabel(label);
}
// Words before a colon that read as a sentence, not a label: four or more,
// two of them in lower case, the last one too ("Each Change Log entry must
// record:", "... shall include the following:"); a label's last word is a
// noun in title case ("... 9:42 AM CDT Name:").
function isSentenceHead(head: string): boolean {
  return wordCount(head) >= 4 && (head.match(/(?:^|\s)\p{Ll}/gu)?.length ?? 0) >= 2 && /(?:^|\s)\p{Ll}[\p{L}'’-]*:$/u.test(head);
}

// The venue lines of a notary's acknowledgment, around a bracket.
const NOTARY_VENUE = /\b(?:state|county|commonwealth|parish)\s+of\s+[\p{L} .]{2,30}\)|\)\s*\)?\s*ss\b|\bss\.?:?\s*\)/iu;

// Where a new piece starts inside one line.
function cutsIn(line: string, headers: ReadonlySet<string>): number[] {
  const cuts = new Set<number>();
  // Cuts made inside the loop that's running, which the sorted list from
  // before it doesn't have; each is at or before the loop's position.
  let since = 0;
  const add = (at: number) => {
    if (at > 0 && at < line.length && /\s/.test(line[at - 1])) {
      cuts.add(at);
      since = Math.max(since, at);
    }
  };
  for (const m of line.matchAll(CUT_SIGN)) {
    const prev = wordBefore(line, m.index);
    // "Prepared By:", "APPROVED BY:" and "Received by:" are one label.
    if (/^B[yY]/.test(m[0]) && /^\p{Lu}\p{L}*(?:ed|ED)$/u.test(prev)) continue;
    // A trace's IP address follows a signer's name, email, time or "Using"
    // ("Jane Doe (jane@acme.com) IP: ...", "3:41:10 PM Using IP Address:
    // ..."); after any other word it's a field's own name ("Allowed IP:",
    // "Office gateway IP:").
    if (/^IP\b/i.test(m[0]) && prev && !IP_LEAD.test(prev) && !(/^\p{Lu}\p{Ll}/u.test(prev) && /^\p{Lu}\p{Ll}/u.test(wordBefore(line, m.index - prev.length - 1)))) continue;
    // "Driver Signature:" is one label where it starts a line or follows a
    // field; after a name ("Signature: Jane Doe Signature:") the word is
    // the end of that name.
    const word = /^\p{Lu}\p{Ll}+\s+(?=[Ss]ignature)/u.exec(m[0]);
    if (word && prev && !/[:.;!?_]$/.test(prev)) add(m.index + word[0].length);
    else add(m.index);
  }
  for (const m of line.matchAll(CUT_START)) add(m.index);
  // The sentence that says the parties sign starts a piece, after a page
  // footer it ran onto too ("Confidential The parties have caused ...").
  for (const m of line.matchAll(/\b(?:The|Each|Both) part(?:y|ies)(?: hereto)? (?:have|has) (?:duly )?(?:executed|signed|caused)\b/g)) add(m.index);
  // A part's heading starts its line, or follows a sentence, a value or a
  // blank; after a small word or a word in lower case it's a reference.
  for (const m of line.matchAll(CUT_PART)) {
    const prev = wordBefore(line, m.index);
    if (prev && (JOINS.test(prev) || REFERS.test(prev) || (/^\p{Ll}/u.test(prev) && !/[.!?:;]$/.test(prev)))) continue;
    add(m.index);
  }
  // A second party's "For ..." beside the first ("For Acme Nordic AS:  For
  // Beta Supply LLC:", "For: ACME MEDICAL CENTER For: BETA CARE ...").
  for (const m of line.matchAll(/\bFor(?=:|\s+\p{Lu})/gu)) {
    const prev = wordBefore(line, m.index);
    if (prev && (/:$/.test(prev) || (isAllCaps(prev) && prev.length > 1) || ENTITY.test(` ${prev}`) || ENTITY_TAIL.test(` ${prev.replace(/[.,:]+$/, "")}`))) add(m.index);
  }
  // A second column's role in capitals after the first column's company
  // ("SELLER: Acme Supply Co.   BUYER: Beta Media LLC").
  for (const m of line.matchAll(/(?<![\p{L}\d])\p{Lu}{3,}(?:\s+\p{Lu}{3,}){0,2}(?=\s*:)/gu)) {
    if (ENTITY.test(` ${wordBefore(line, m.index).replace(/,$/, "")}`)) add(m.index);
  }
  // A UK block run onto one line: "Signed by John Roe | for and on
  // behalf of ACME TRADING LIMITED .... Director | Signed by ....". In a
  // blank template the name is a placeholder: "Signed by [NAME OF DIRECTOR]".
  for (const m of line.matchAll(/\b(?:for and on behalf of|on behalf of)\b/g)) {
    const prev = wordBefore(line, m.index);
    if ((/^\p{Lu}\p{Ll}/u.test(prev) || /^[^\s\[]*\]$/.test(prev)) && !/^(?:Signed|Executed|Accepted|Agreed|Approved)$/.test(prev)) add(m.index);
  }
  // A second column's heading beside the first ("On behalf of the
  // Controller:   On behalf of the Processor:").
  for (const m of line.matchAll(/\b(?:For and on behalf of|On behalf of)\b/g)) if (/:$/.test(wordBefore(line, m.index))) add(m.index);
  for (const m of line.matchAll(/\b(?:Signed|Executed) by\b(?!\s*:)/g)) if (/^[\p{Lu}_.…]/u.test(wordBefore(line, m.index))) add(m.index);
  // "Executed by Acme Limited acting by [NAME], a director ....": who
  // executes, then who acts for them, run onto one line.
  for (const m of line.matchAll(/\b(?:Signed|SIGNED|Executed|EXECUTED)(?:\s+as\s+a\s+(?:deed|DEED))?\s+(?:by|BY)\s+[^:;_\n]{2,80}?\s(?=acting\s+by\b)/g)) add(m.index + m[0].length);
  // "For Client:" and "on behalf of ACME INC." are one party line.
  for (const m of line.matchAll(CUT_ROLE)) if (!JOINS.test(wordBefore(line, m.index))) add(m.index);
  for (const m of line.matchAll(PAGE_NOTE_IN_LINE)) {
    add(m.index);
    const after = /^\s+/.exec(line.slice(m.index + m[0].length));
    if (after) add(m.index + m[0].length + after[0].length);
  }
  // A blank ends a piece when a new label or name follows ("____ Date ____"),
  // and starts one when it follows a party name ("ACME INC. ____").
  // A row of captions under two columns ("Signature Signature", "(Printed
  // Name)") ends before the next row's blanks; a single "Signature ____" is
  // a label and its blank.
  let lastCut = lastCutBefore(cuts);
  since = 0;
  for (const m of line.matchAll(BLANKS)) {
    const prev = wordBefore(line, m.index);
    if (/^(?:\p{Lu}[\p{Lu}&'’.,-]+|(?:Inc|Corp|Co|Ltd)\.?,?)$/u.test(prev)) add(m.index);
    const from = Math.max(lastCut(m.index), since);
    if (m.index - from <= SHORT_RUN) {
      const captions = line.slice(from, m.index).trim();
      if (CAPTION.test(captions) && (/\)$/.test(captions) || (CAPTION_ROW.test(captions) && !CAPTION_ONE.test(captions)))) add(m.index);
      // "For Beta Supply LLC: ____": the party's line, then where it signs.
      // "for and on behalf of [CLIENT NAME] ......" too, with no colon.
      const forParty = /^(?:(?:signed|executed|accepted|agreed)\s+)?(?:for|on behalf of)\b/i.test(captions) ? FOR_PARTY.exec(captions) : null;
      if (forParty && (/:$/.test(captions) || (/\bon behalf of\b/i.test(captions) && isForParty(forParty[2], false)))) add(m.index);
      // "Signed by John Roe ........", "acting by [NAME], a director
      // ........": who signs, then the line.
      if ((/^(?:Signed|Executed) by\s/.test(captions) || /^(?:\S+\s+){0,2}acting\s+by\s/.test(captions)) && DESCRIPTOR.test(captions)) add(m.index);
    }
    const tail = line.slice(m.index + m[0].length, m.index + m[0].length + 80);
    // A field's blank ("Date: ____") with a label in lower case after it
    // ("submitted by: ..."): a splitter that joins lines ran the next
    // thing onto the field, which ends at its blank whatever the case.
    const after = /^\s+(?=[\p{Lu}[\/(])/u.exec(tail) ?? (isFieldHead(line.slice(from, m.index).trim()) ? LOWER_LABEL.exec(tail) : null);
    if (after) add(m.index + m[0].length + after[0].length);
  }
  // A party name in capitals right after a label's value or a date
  // ("Title: Chief Executive Officer ACME INC."), but never in the middle
  // of a sentence ("payable to BETA MEDIA LLC").
  for (const m of line.matchAll(CAPS_RUN)) {
    const at = m.index;
    const prev = wordBefore(line, at);
    // "Beta Media LLC BETA MEDIA LLC": the first "LLC" ends the name before.
    // "Doe & Roe LLP NOTES:", "Beta Bank ASA IBAN:" too.
    const suffix = /^(?:L\.?L\.?C|INC|CORP|LTD|L\.?L\.?P|LP|CO|ASA?|AB|AG|GMBH|PLC)\.?,?\s+/.exec(m[0]);
    if (suffix && /\p{Ll}/u.test(prev) && /^\p{Lu}/u.test(prev) && !/[.!?;:]$/.test(prev)) {
      add(at + suffix[0].length);
      continue;
    }
    if (/^(?:A\.?M|P\.?M)\b/.test(m[0]) && /\d:\d{2}$/.test(prev)) {
      // A heading in capitals right after a time ("Signed: 1/2/2026
      // 9:15:00 AM GENERAL TERMS ...") starts a piece.
      const time = /^[AP]\.?M\.?\s+(?=\p{Lu}[\p{Lu}&'’.,-]+\s+\p{Lu}[\p{Lu}&'’.,-]+|\p{Lu}{4,}\s+\p{Lu})/u.exec(line.slice(at, at + 200));
      if (time) add(at + time[0].length);
      continue;
    }
    if (JOINS.test(prev)) continue;
    // A company's form after its name ("By: Acme GP LLC, its general
    // partner"): short words ending in a form like LLC, or a run that a
    // signer's role follows (", its ..."), end the name before it.
    if (/^(?:\p{Lu}{1,3}[.,]?\s+)*(?:L\.?L\.?C|INC|CORP|LTD|L\.?L\.?P|LP|PLC|CO)\.?,?\s*$/u.test(m[0]) || /^\s*its\s/.test(line.slice(at + m[0].length, at + m[0].length + 6))) continue;
    if (prev && /^[\p{Lu}\d(]/u.test(prev) && !/:$/.test(prev) && prev !== prev.toUpperCase()) add(at);
    else if (prev && (/^\d/.test(prev) || /\S@\S|\.(?:com|net|org|io|co)\b/i.test(prev))) add(at);
  }
  // A typed signature after a party name ("ACME INC. /s/ Jane Doe"), not
  // one quoted in a sentence ("for example, /s/ Jane Doe").
  for (const m of line.matchAll(/\/s\//g)) {
    const prev = wordBefore(line, m.index);
    if (prev && /^\p{Lu}/u.test(prev) && !/:$/.test(prev)) add(m.index);
    // The signer's name printed again after it ("/s/ Jane Roe Jane
    // Roe, Partner") starts a piece.
    const typed = TYPED_THEN_NAME.exec(line.slice(m.index, m.index + 120));
    if (typed) add(m.index + typed[0].length);
  }
  // An e-signature stamp, a name with the signing date in brackets, between
  // a party name and the signer's title ("ACME LLC Jane Doe (Mar 3, 2026
  // 10:14 PST) Jane Doe, CEO"); one in a sentence ("approved by Jane Doe
  // (March 3, 2026) and ...") has a small word before it and stays.
  for (const m of line.matchAll(INLINE_STAMP)) {
    const prev = wordBefore(line, m.index);
    if (prev && !/^[\p{Lu}\d]/u.test(prev) && !/:$/.test(prev)) continue;
    add(m.index);
    const after = /^\s+(?=\p{Lu})/u.exec(line.slice(m.index + m[0].length));
    if (after) add(m.index + m[0].length + after[0].length);
  }
  // The same caption twice is a row under two columns ("Authorized
  // Signature Authorized Signature"), a piece of its own between the rows.
  for (const m of line.matchAll(/\b((?:Authori[sz]ed\s+)?Signature|(?:Printed|Print|Typed)\s+Name(?:\s+(?:and|&)\s+Title)?|Name\s+(?:and|&)\s+Title)\s+\1(?![\p{L}])/gu)) {
    add(m.index);
    const after = /^\s+/.exec(line.slice(m.index + m[0].length));
    if (after) add(m.index + m[0].length + after[0].length);
  }
  // A bracket that closes nothing, between spaces, is the column of marks
  // a Scottish block is written beside ("SIGNED by Acme Limited   )   ....."):
  // a piece of its own.
  let depth = 0;
  for (const m of line.matchAll(/[()]/g)) {
    if (m[0] === "(") depth++;
    else if (depth > 0) depth--;
    // A notary's venue ("STATE OF NEW YORK ) ss.:") keeps its brackets.
    else if (/\s/.test(line[m.index - 1] ?? "") && /^(?:\s|$)/.test(line[m.index + 1] ?? "") && !NOTARY_VENUE.test(line.slice(Math.max(0, m.index - 50), m.index + 12))) {
      add(m.index);
      const after = /^\s+/.exec(line.slice(m.index + 1, m.index + 200));
      if (after) add(m.index + 1 + after[0].length);
    }
  }
  // The PDF reader's page marker ("-- 3 of 4 --") is a piece of its own.
  for (const m of line.matchAll(/--\s*\d+\s+of\s+\d+\s*--/g)) {
    add(m.index);
    const after = /^\s+/.exec(line.slice(m.index + m[0].length));
    if (after) add(m.index + m[0].length + after[0].length);
  }
  // A page number ends a running footer ("... Confidential Page 5 of 6 ACME INC.").
  for (const m of line.matchAll(/\bPage \d+ of \d+\b/g)) add(m.index);
  // The next table row too ("Page 4 of 6 | ACME LLC | BETA INC. |").
  for (const m of line.matchAll(/\bPage \d+(?: of \d+)?\s+(?=\p{Lu}|\|\s)/gu)) add(m.index + m[0].length);
  // A letter's closing ends a piece ("Very truly yours, BETA MEDIA LLC").
  for (const m of line.matchAll(CLOSING_IN_LINE)) add(m.index + m[0].length);
  // An e-signature hash ends a piece ("3E8D1A27C5F94B0... Jane Doe").
  for (const m of line.matchAll(/\b[0-9A-F]{8,}(?:\.{3}|…)?(?=\s+\p{Lu})/gu)) {
    if ((m[0].match(/\d/g)?.length ?? 0) < 2 || !/[A-F]/.test(m[0])) continue;
    const after = /^\s+/.exec(line.slice(m.index + m[0].length));
    if (after) add(m.index + m[0].length + after[0].length);
  }
  // A signer's name after a title, and a date after either, in two columns
  // run together ("Jane Doe, Chief Financial Officer John Roe, CEO 10/15/2026").
  for (const m of line.matchAll(TITLE_THEN_NAME)) add(m.index + m[1].length);
  for (const m of line.matchAll(DATE_ANYWHERE)) {
    const prev = wordBefore(line, m.index);
    if (/^\p{Lu}/u.test(prev) && !/[:,]$/.test(prev) && !MONTH_ONLY.test(prev)) add(m.index);
  }
  for (const m of line.matchAll(SENTENCE_END)) {
    const word = wordBefore(line, m.index + 1).replace(/^["“'(\[]+/, "").replace(/[.!?]["'’”)\]]*$/, "").toLowerCase();
    const capsFollow = /^\p{Lu}[\p{Lu}&'’.,-]+\s+\p{Lu}[\p{Lu}&'’.,-]+/u.test(line.slice(m.index + m[0].length));
    if (!capsFollow && (ABBREVIATIONS.has(word) || /^\p{L}$/u.test(word) || /^(?:\p{L}\.)+\p{L}$/u.test(word))) continue;
    add(m.index + m[0].length);
  }
  // A party's name run onto the testimony sentence after its colon
  // ("Agreed to by the parties as of the Effective Date: ACME FREIGHT CO.",
  // "ACCEPTED AND AGREED: [ASSIGNEE NAME]"), a sign-off heading in capitals
  // run onto what's under it ("RESPONSE: This letter correctly sets forth
  // ..."), which is a line of its own, and the attesting witness's heading
  // beside the party's stand-in ("ATTEST:     [ACME CORPORATION]").
  lastCut = lastCutBefore(cuts);
  since = 0;
  for (const m of line.matchAll(/:[ \t]+(?=\p{Lu}|\[)/gu)) {
    const from = Math.max(lastCut(m.index), since);
    if (m.index - from > SHORT_RUN) continue;
    const head = line.slice(from, m.index + 1).trim();
    const standIn = line[m.index + m[0].length] === "[";
    if (isTestimony(head) || (isAllCaps(head) && SIG_HEADING.test(head.slice(0, -1))) || (standIn && WITNESS_LABEL.test(head.slice(0, -1).trim()))) add(m.index + m[0].length);
    // A sentence that introduces fields ("Each entry must record: Change
    // No.: ____") ends at its colon, so guard 3 sees what it introduces.
    else if (isSentenceHead(head) && LABEL_AHEAD.test(line.slice(m.index + m[0].length, m.index + m[0].length + 64))) add(m.index + m[0].length);
  }
  // Last, since it looks at where the piece it's in starts: "Contact Name:"
  // or "IP Address:" at the start of a piece is one label, not a fragment
  // and a "Name:".
  lastCut = lastCutBefore(cuts);
  since = 0;
  for (const m of line.matchAll(CUT_FIELD)) {
    const from = Math.max(lastCut(m.index), since);
    const before = m.index - from <= SHORT_RUN ? line.slice(from, m.index).trim() : "";
    // A signer's title before it is a caption under the line beside it
    // ("____ By: ____ / Secretary Name: Jane Roe"). A document's name
    // there is a running page header ("Master Services Agreement Date: ____").
    // A comma before it ("Jane Roe, Director Date: ...") ends a signer's
    // name and title, never a label's first words.
    if (before && !/[:_.;,]/.test(before) && before.split(/\s+/).length <= 3 && /^\p{Lu}/u.test(before) && !headers.has(before) && !DOCUMENT_NAME.test(before) && signerDetail(before) !== "title") continue;
    // "... 12 months from the Start Date:": a date the terms name.
    if (/^Date/.test(m[0]) && /\bthe\s+\p{Lu}\p{Ll}+\s*$/u.test(line.slice(Math.max(0, m.index - 40), m.index))) continue;
    // "Agreed to by the parties as of the Effective Date:" is one sentence.
    if (before && isTestimony(`${before} ${m[0]}`)) continue;
    add(m.index);
  }
  return [...cuts].sort((a, b) => a - b);
}

// `headers`: running page headers found in a first pass ("Master Services
// Agreement" on every page), which a label right after one doesn't join.
function unitsOf(body: string, ci: number, headers: ReadonlySet<string> = new Set()): Unit[] {
  const units: Unit[] = [];
  let row = 0;
  const push = (start: number, text: string) => {
    units.push({ ci, row, start, end: start + text.length, text, kind: "prose" });
  };
  let lineStart = 0;
  for (const line of body.split("\n")) {
    row++;
    // Every cut follows a space, so a line that's one word or empty has
    // none; skipping it keeps a run of blank lines cheap.
    const bounds = [0, ...(/\S\s+\S/.test(line) ? cutsIn(line, headers) : []), line.length];
    for (let k = 0; k < bounds.length - 1; k++) {
      const raw = line.slice(bounds[k], bounds[k + 1]);
      const text = raw.trim();
      // A table's cell border alone ("|" between two cells) is no piece.
      if (!text || /^\|+$/.test(text)) continue;
      const start = lineStart + bounds[k] + raw.indexOf(text);
      // A filled date that ran on into the next thing is two pieces.
      const head = DATE_HEAD.exec(text)?.[0].trimEnd();
      if (head && head.length < text.length && /^\s+\S/.test(text.slice(head.length))) {
        push(start, head);
        const rest = text.slice(head.length).trimStart();
        push(start + text.length - rest.length, rest);
      } else {
        push(start, text);
      }
    }
    lineStart += line.length + 1;
  }
  return units;
}

// ---------------------------------------------------------------------------
// Naming the pieces
// ---------------------------------------------------------------------------

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function isAllCaps(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}

// Every word starts with a capital or a digit, as in a name, a title or a
// date ("Jane Q. Doe", "VP of Marketing", "John Roe (Oct 14, 2026 1:05 PM)"),
// never a sentence.
function isNameish(s: string, maxWords: number): boolean {
  const words = s.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > maxWords) return false;
  // "[CUSTOMER LEGAL NAME]" in a blank template stands for a name.
  // A company's form may close it in lower case ("Acme Retail Group plc").
  return words.every((w, k) => /^["“'‘(\[]?[\p{Lu}\d&/]/u.test(w) || NAME_CONNECTOR.test(w) || /^individually[,.]?$/i.test(w) || INITIALS_FORM.test(w) || (k === words.length - 1 && k > 0 && ENTITY.test(` ${w}`)));
}

// "BETA MEDIA LLC", "Acme Industrial Supply, Inc., a Delaware corporation",
// two parties side by side ("Beta Media LLC Acme Inc.").
function isEntityLine(t: string): boolean {
  // Past 200 characters it can't be a name of 100 (and the patterns below
  // would read a long run of spaces over and over).
  if (t.includes(":") || t.length > 200) return false;
  const name = t
    .replace(/[\s,;]+$/, "")
    .replace(/,\s*(?:a|an|its)\s+[^,]{3,60}$/i, "")
    .replace(/[\s,;]+$/, "");
  return (ENTITY.test(name) || ENTITY_TAIL.test(name)) && !/\d{2,}/.test(name) && wordCount(name) <= 12 && name.length <= 100 && isNameish(name, 12);
}

// A party's name after its role ("CLIENT: ACME INC., a Delaware
// corporation"), never an address ("Client: Acme Inc., 100 Main Street").
function isPartyName(v: string): boolean {
  return !/\d{2,}/.test(v) && (isNameish(v, 10) || isEntityLine(v));
}

// Who "For ..." names: a company, a role ("For Client:"), a role and its
// company ("For Supplier: ACME VALVES GMBH"), or, written with a colon
// ("For: ACME MEDICAL CENTER"), a name in capitals.
function isForParty(who: string, colon: boolean): boolean {
  // "For [CONSULTANT LEGAL NAME]": a blank template's stand-in for the name.
  if (isEntityLine(who) || ROLE_LINE.test(who) || /^\[[^\]]{2,60}\]$/.test(who)) return true;
  const named = ROLE_NAMED.exec(who);
  if (named) return isPartyName(named[1]);
  return colon && isAllCaps(who) && isNameish(who, 8) && !/\d/.test(who);
}

function partyKind(t: string): Kind | null {
  if (ROLE_LINE.test(t)) return "party";
  const named = ROLE_NAMED.exec(t);
  if (named && isPartyName(named[1])) return "roleParty";
  if (isEntityLine(t)) return "party";
  if (/[!?;]/.test(t) || /\d/.test(t) || wordCount(t) > 8 || t.length > 80) return null;
  if (/\.$/.test(t) && !ENTITY.test(t)) return null;
  if (isAllCaps(t) || isNameish(t, 5)) return "maybeParty";
  return null;
}

function signerDetail(t: string): Detail | null {
  if (DATE_ONLY.test(t)) return "date";
  if (NAME_ONLY.test(t) && !TITLE_WORD.test(t) && !NOT_NAME.test(t)) return "name";
  const nt = NAME_TITLE.exec(t);
  // A company's form right after the comma ("BETA PAYROLL, INC.    PARTNER")
  // ends a company's name, with the next column's heading beside it: no
  // signer's name and title.
  if (nt && TITLE_WORD.test(nt[1]) && isNameish(nt[1], 14) && !/\d/.test(nt[1]) && !ENTITY.test(nt[1].split(/\s+/)[0])) return "nameTitle";
  if (TITLE_WORD.test(t) && isNameish(t, 6) && !/[\d:]/.test(t)) return "title";
  return null;
}

// A sentence that starts like the testimony is read as one here; whether it
// says more than that the parties sign is guard 1's to judge, which keeps
// it in the contract if it does.
function isTestimony(t: string): boolean {
  // "Accepted by Client: ____" is the line to sign, not a sentence about it.
  if (wordCount(t) > 60 || UNDERSCORES.test(t)) return false;
  if (SWORN.test(t)) return true;
  // "Accepted by Client within ten days, a Deliverable is final" is a term.
  if (TERMS.test(t)) return false;
  const by = ACCEPTED_BY.exec(t);
  if (ACCEPTED.test(t) || (by && isNameish(by[1], 4))) return true;
  return (SIGN_BELOW.test(t) && /\bsign/i.test(t)) || (SIGN_CUE.test(t) && wordCount(t) <= 45);
}

// Splits "Label: value", or "Label ______" in a form with no colons.
function labelOf(t: string): { label: string; value: string } | null {
  // What's in parentheses doesn't change the label: "Approved by (signature):".
  const bare = (label: string) => label.replace(/\s*\([^)]*\)/g, "").trim();
  // "Label: value": up to the first colon, found by hand, as a pattern's
  // \s* before the colon would rescan a long run of spaces at every step.
  const colon = t.indexOf(":");
  const head = colon > 0 ? t.slice(0, colon).trimEnd() : "";
  if (head.length <= 60 && /^\p{L}/u.test(head)) return { label: bare(head), value: t.slice(colon + 1).trim() };
  const blank = UNDERSCORES.test(t) ? /^([^_]{1,60}?)\s*((?:_{3,}|\.{5,}|…{3,})[\s\S]*)$/.exec(t) : null;
  if (blank) {
    const label = bare(blank[1]);
    if (isSignLabel(label) || PERSON_LABEL.test(label) || DATE_LABEL.test(label) || INITIALS_LABEL.test(label)) return { label, value: blank[2].trim() };
  }
  return null;
}

// A role, with a word that says which ("REFERRAL PARTNER"), as a label.
const ROLE_SIGN = new RegExp(String.raw`^(?:\p{L}+\s+)?${ROLE}$`, "iu");

// "Jane Roe ____" without its line. Walked from the end instead of matched
// with "\.{5,}\s*$", which retries at every dot of a long run of them.
function withoutTrailingBlank(value: string): string {
  const v = value.trimEnd();
  const ch = v[v.length - 1];
  const least = ch === "_" || ch === "…" ? 3 : ch === "." ? 5 : 0;
  let i = v.length;
  while (least && i > 0 && v[i - 1] === ch) i--;
  return least && v.length - i >= least ? v.slice(0, i).trimEnd() : value;
}

// "[CONSULTANT LEGAL NAME]     [CLIENT LEGAL NAME]": a blank template's
// stand-ins for the parties' names, one per column, and nothing else. A
// role in them doesn't make the row a signer's title.
const STAND_IN = /\[[^\[\]]{2,60}\]/g;
function partyStandIns(t: string): boolean {
  const names = t.match(STAND_IN);
  return !!names && !t.replace(STAND_IN, "").trim() && names.every((n) => ROLE_NAME.test(n.slice(1, -1).trim()));
}

// A table's cell reads as what's in it: "By: ____ |" is "By: ____", and so
// is "By: ____ | |" from a splitter that ran the rows together. The end is
// walked by hand: "(?:\s*\|)+$" would rescan a long run of spaces from
// every one of them.
function cellText(t: string): string {
  let end = t.length;
  for (let k = end; k > 0; ) {
    while (k > 0 && /\s/.test(t[k - 1])) k--;
    if (k === 0 || t[k - 1] !== "|") break;
    end = --k;
  }
  return t.slice(0, end).replace(/^(?:\|\s*)+/, "").trimEnd();
}

function classify(text: string): Omit<Unit, "ci" | "row" | "start" | "end" | "text"> {
  // A bracket closing nothing at the end of a line is the column of marks a
  // Scottish block is written beside ("SIGNED by Acme Limited    )").
  // (Sliced, not matched with a regex: "\s*\)$" retries at every space and
  // turns a long run of spaces quadratic.)
  const trimmed = cellText(text.trim());
  const t = !trimmed.endsWith(")") || text.includes("(") ? trimmed : trimmed.slice(0, -1).trimEnd();
  if (!t && text.trim()) return { kind: "artifact" };
  if (ONLY_BLANKS.test(t)) return { kind: UNDERSCORES.test(t) ? "line" : "prose" };
  // A heading, not a sentence about audit trails.
  if (CERT.test(t) && !/[.!?]$/.test(t) && !TERMS.test(t)) return { kind: "cert" };
  if (isPartHeading(t)) return { kind: "part" };
  if (PAGE_NOTE.test(t)) return { kind: "pageNote" };
  if (SEAL.test(t)) return { kind: "seal" };
  if (isTestimony(t)) return { kind: "testimony", sworn: SWORN.test(t) };
  if (CLOSING.test(t)) return { kind: "closing" };
  if (isHash(t) || isEsignStamp(t) || IP_LINE.test(t) || NAME_STAMP.test(t)) return { kind: "stamp" };
  if (NOTARY.test(t)) return { kind: "notary" };
  if ((ARTIFACT.test(t) || isPageMark(t)) && wordCount(t) <= 16) return { kind: "artifact" };
  if (TYPED.test(t) && wordCount(t) <= 12) return { kind: "sign", capture: "typed" };

  // "AGENCY (as agent for Advertiser)": what's in brackets doesn't change whose line it is.
  // Matched from the bracket, not from the spaces before it: a leading \s*
  // would retry at every space of a long blank run and go quadratic.
  const paren = /\([^()]{1,60}\)\s*(:?)$/.exec(t);
  const noted = paren ? t.slice(0, paren.index).trimEnd() + paren[1] : t;
  if (ROLE_LINE.test(t) || (noted !== t && (ROLE_LINE.test(noted) || isEntityLine(noted))) || partyStandIns(t)) return { kind: "party" };
  const forParty = FOR_PARTY.exec(t);
  if (forParty && isForParty(forParty[2], !!(forParty[1] || forParty[3]))) return { kind: "party" };
  // "On behalf of the Controller:" heads a party's part, though the colon
  // makes it look like a label.
  if (/^(?:(?:(?:signed\s+)?for\s+and\s+)?on\s+behalf\s+of|(?:\S+\s+){0,2}acting\s+by)\b[^:]*:$/i.test(t) && DESCRIPTOR.test(t)) return { kind: "descriptor" };
  const lv = labelOf(t);
  if (lv) {
    const { label, value } = lv;
    const blank = ONLY_BLANKS.test(value);
    // A date line holds a blank or a date, and little more: a date line that
    // runs on into other words ("Date: ____ prepared by Acme LLC ...") is no
    // line of a block, so a block never takes what came after it.
    if (DATE_LABEL.test(label)) return blank || ((/^(?:\d|_)/.test(value) || MONTH_FIRST.test(value)) && (DATE_ONLY.test(value.replace(/[\s_]+$/, "")) || (wordCount(value) <= 5 && !value.includes(":")))) ? { kind: "date", blank } : { kind: "label" };
    if (isSignLabel(label)) {
      if (STAMP_SIGN.test(label) || /^(?:DOCU)?SIGNED BY$/.test(label)) return { kind: "sign", capture: "stamp" };
      if (blank) return { kind: "sign", capture: value ? "blank" : "empty" };
      if (TYPED.test(value)) return { kind: "sign", capture: "typed" };
      if (isEntityLine(value)) return { kind: "signer" };
      // A name written on the line ("Signature: Jane Doe"), not a setting
      // ("Electronic Signature: Permitted").
      if (isNameish(value, 12) && wordCount(value) >= 2 && !NOT_SIGNED.test(value)) return { kind: "sign", capture: "filled" };
      return { kind: "label" };
    }
    // "Name: Jane Roe ____": the line it was typed on doesn't count. A
    // colon in the value is another label run on after it ("Its: CEO
    // Project Contact: ..."), which isn't the signer's.
    const typed = withoutTrailingBlank(value);
    // A name is a few words, none of a heading's ("Name: Jane Doe Payment
    // Instructions" ran on into the next part).
    // A title may follow it after a comma ("Name: Jane Doe, Head of Sales").
    const nameOnly = /^(?:(?:printed|print|typed|full)\s+)?name$/i.test(label);
    const name = nameOnly ? typed.split(",")[0] : typed;
    if (PERSON_LABEL.test(label)) return blank || (isNameish(typed, 12) && !typed.includes(":") && !(nameOnly && (wordCount(name) > 5 || NOT_NAME.test(name)))) || (ROLE_FIELD.test(label) && wordCount(value) <= 5 && !/[\d.;:!?]/.test(value)) ? { kind: "person", blank } : { kind: "label" };
    if (ROLE_NAME.test(label) && (blank || isPartyName(value))) return { kind: "roleParty" };
    if (CONTACT_LABEL.test(label)) return { kind: "contact" };
    if (INITIALS_LABEL.test(label)) return { kind: "initials" };
    if (/^By (?:its|their|his|her)\b/.test(label) && wordCount(label) <= 6) return !value ? { kind: "descriptor" } : blank ? { kind: "sign", capture: "blank" } : TYPED.test(value) ? { kind: "sign", capture: "typed" } : { kind: "label" };
    // "WITNESS: ____": a role with a blank of its own is a line to sign
    // only inside a block (an order form's "Company: ____" is a field).
    // "Witnessed by:" with nothing after it heads the witness's lines.
    // A signer's title as the label ("Director: ......", in a deed) too.
    if ((ROLE_SIGN.test(label) || WITNESS_LABEL.test(label) || (TITLE_WORD.test(label) && isNameish(label, 3))) && blank && value) return { kind: "roleSign" };
    if (WITNESS_LABEL.test(label) && !value) return { kind: "descriptor" };
    if (ROLE_NAMED.test(t) && isPartyName(value)) return { kind: "roleParty" };
    if (!SIG_HEADING.test(label) || value) return { kind: "label", blank: blank && !!value };
  }

  if (DESCRIPTOR.test(t)) return { kind: "descriptor" };
  if (CAPTION.test(t)) return { kind: "caption" };
  if (SIG_HEADING.test(t.replace(/:$/, ""))) return { kind: "sigHeading" };
  // "Jane Doe, VP of Marketing, Acme Corporation" names the signer,
  // not a party, though it ends in a company's name.
  const detail = signerDetail(t);
  if (detail === "nameTitle" || detail === "date") return { kind: "signerLine", detail };
  const party = partyKind(t);
  if (party && party !== "maybeParty") return { kind: party };
  if (detail) return { kind: "signerLine", detail };
  if (party) return { kind: party };
  return { kind: "prose" };
}

// Lines repeated through the file that aren't anything else are running
// page headers or footers ("Master Services Agreement" on every page).
function repeatedLines(units: Unit[]): Set<string> {
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u.text, (counts.get(u.text) ?? 0) + 1);
  return new Set(units.filter((u) => (u.kind === "prose" || u.kind === "maybeParty") && (counts.get(u.text) ?? 0) >= 2 && wordCount(u.text) <= 10 && !/[.!?;:]$/.test(u.text)).map((u) => u.text));
}

// A code on the line under one that ends in a colon is that line's value
// ("The licence key is: / 7F3A2B19C4D5E6F7"), not an e-signature hash.
function markValues(units: Unit[]): void {
  units.forEach((u, k) => {
    const above = units[k - 1];
    if (u.kind === "stamp" && isHash(u.text) && above?.ci === u.ci && above.row < u.row && /:$/.test(above.text) && (above.kind === "prose" || above.kind === "label")) u.kind = "prose";
  });
}

function markRepeats(units: Unit[], headers: ReadonlySet<string>): void {
  units.forEach((u, k) => {
    if (u.kind !== "prose" && u.kind !== "maybeParty") return;
    // A running footer prints the document's name beside the page number
    // ("Acme Supply Agreement     Page 14 of 15"), on a page of its own too.
    const pageBeside = [units[k - 1], units[k + 1]].some((v) => v?.ci === u.ci && v.row === u.row && v.kind === "artifact" && isPageMark(v.text));
    if (headers.has(u.text) || (pageBeside && wordCount(u.text) <= 10 && DOCUMENT_NAME.test(u.text))) u.kind = "artifact";
  });
}

function piecesOf(clauses: Clause[]): Unit[] {
  const named = (headers: ReadonlySet<string>) => {
    const units = clauses.flatMap((c, ci) => unitsOf(c.body, ci, headers));
    for (const u of units) Object.assign(u, classify(u.text));
    return units;
  };
  const headers = repeatedLines(named(new Set()));
  const units = named(headers);
  markRepeats(units, repeatedLines(units));
  markValues(units);
  markRoles(units);
  markSignAndDate(units);
  return units;
}

// A party's role the contract uses in its terms, as the label over a
// party's part of a block: "Controller: Acme Retail Group plc", "CONSIGNOR:
// Acme Supply Co.", or "MEMBERS:" alone over the members' lines. Any one
// or two words that aren't a field ("Bill To", "Bank Details") count when a
// sentence of the terms names that party in title case ("Processor shall
// make available to Controller ..."), and then only with a company's name
// after them, a blank, or nothing.
function markRoles(units: Unit[]): void {
  // The words in title case the terms use, alone and in pairs, read once.
  let named: Set<string> | null = null;
  const termsName = (role: string) => {
    if (!named) {
      named = new Set<string>();
      for (const v of units) {
        if (v.kind !== "prose" || wordCount(v.text) < 6) continue;
        const words = v.text.split(/[^\p{L}'’]+/u);
        words.forEach((w, k) => {
          if (!/^\p{Lu}\p{Ll}+$/u.test(w)) return;
          named!.add(w);
          if (/^\p{Lu}\p{Ll}+$/u.test(words[k + 1] ?? "")) named!.add(`${w} ${words[k + 1]}`);
        });
      }
    }
    return named.has(role);
  };
  for (const [k, u] of units.entries()) {
    if (u.kind !== "label") continue;
    // "For the Customer:    For Beta:": a second column's heading, on the
    // row of a party's heading written the same way, names the other party.
    const besideParty = [units[k - 1], units[k + 1]].some((v) => v?.ci === u.ci && v.row === u.row && v.kind === "party" && /^For\s/i.test(v.text));
    if (besideParty && /^For\s+\p{Lu}[\p{L}&'’.,-]*(?:\s+[\p{L}&'’.,-]+){0,4}\s*:$/u.test(u.text) && !NOT_NAME.test(u.text.slice(4, -1))) {
      u.kind = "party";
      continue;
    }
    const m = /^(\p{L}+(?:\s+\p{L}+)?)\s*:\s*(.*)$/u.exec(u.text);
    // With a blank after it ("COUNTERPARTY: ____"), the role has a line of
    // its own, like "WITNESS: ____": one to sign only where a block is.
    const line = !!m?.[2] && ONLY_BLANKS.test(m[2]) && UNDERSCORES.test(m[2]);
    if (!m || (m[2] && !line && !isEntityLine(m[2])) || m[1].split(/\s+/).some((w) => JOINS.test(w)) || NOT_NAME.test(m[1])) continue;
    if (!isAllCaps(m[1]) && !/^\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+)?$/u.test(m[1])) continue;
    if (!termsName(m[1].toLowerCase().replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase()))) continue;
    u.kind = line ? "roleSign" : m[2] ? "roleParty" : "party";
  }
}

// "Client: ____  Date: ____": a label that names who signs, with a blank
// next to a date blank, is a line to sign and date. Who signs: a party's
// role ("Customer Representative"), someone who checks or approves
// ("Checked by", "Project Manager"). Any other field beside a date ("Cost
// Center: ____ Date: ____") is a field.
const SIGNER_LABEL = new RegExp(String.raw`^(?:(?:\p{L}+\s+)?${ROLE}(?:['’]s)?(?:\s+(?:representative|rep|approval|acceptance))?|(?:\p{L}+\s+){1,3}by|(?:\p{L}+\s+){0,2}(?:representative|manager|officer|supervisor|employee|signatory|signer|director|lead|engineer|inspector|technician|approver|homeowner|patient|parent|guardian|student|participant|applicant|recipient|resident))$`, "iu");
// A party's own name as the label ("Beta Media: ____ Date: ____") counts
// on a row beside one of those, or alone when it's a company's name with its
// form ("Beta Media LLC: ____ Date: ____").
function markSignAndDate(units: Unit[]): void {
  // Cut at the first line, found with indexOf: a regex starting "\s*_{3,}"
  // retries at every space of a long run of them.
  const label = (u: Unit) => {
    const head = u.text.split(":")[0];
    const line = head.indexOf("___");
    return (line < 0 ? head : head.slice(0, line)).trim();
  };
  const besideDate = (u: Unit, k: number) => {
    const next = units[k + 1];
    return (u.kind === "roleSign" || (u.kind === "label" && !!u.blank)) && next?.ci === u.ci && next.kind === "date" && !!next.blank && !/\b(?:e-?mail|phone|fax|address|p\.?o\.?|number|no\.?|#|contact|company|billing|amount|fee|total|budget|start|end|invoice|due|account|routing|bank|rate|price|name|title)\b/i.test(label(u));
  };
  const rows = units.map((u, k) => besideDate(u, k) && (u.kind === "roleSign" || SIGNER_LABEL.test(label(u))));
  units.forEach((u, k) => {
    const named = () => isNameish(label(u), 4) && !NOT_NAME.test(label(u)) && (rows[k - 2] || rows[k + 2]) && units[k + (rows[k - 2] ? -2 : 2)].ci === u.ci;
    // A company's name with its form ("Beta Pipeline Co.: ____ Date: ____")
    // is a party's name whatever's beside it.
    if (rows[k] || (besideDate(u, k) && (named() || isEntityLine(label(u))))) {
      u.kind = "sign";
      u.capture = "blank";
    }
  });
}

// ---------------------------------------------------------------------------
// Finding blocks
// ---------------------------------------------------------------------------

// A signature line, the party's own name lines and the signer's details:
// what tells a party's part of a block apart from a list of contacts.
const SIGNED: ReadonlySet<Kind> = new Set<Kind>(["sign", "line", "signer", "person", "stamp", "signerLine", "notary"]);
// Lines that always belong in a block once one has started.
const INSIDE: ReadonlySet<Kind> = new Set<Kind>(["sign", "line", "signer", "person", "date", "initials", "stamp", "notary", "testimony", "closing", "pageNote", "descriptor", "seal"]);
// What a party name sits right above.
const UNDER_PARTY: ReadonlySet<Kind> = new Set<Kind>(["sign", "line", "signer", "descriptor", "stamp", "party", "roleParty", "roleSign"]);
const PARTIES: ReadonlySet<Kind> = new Set<Kind>(["party", "roleParty", "maybeParty"]);
// Where a party's part of a block starts under its name.
const SIGNING: ReadonlySet<Kind> = new Set<Kind>(["sign", "line", "signer", "descriptor", "stamp"]);

// first: each clause's first piece. size: the length of the text before
// each piece, to measure a stretch at once. part: where the part each piece
// is in starts, for its heading (-1 before the first). nextPart/prevPart:
// the next part or certificate at or after each piece, and the last at or
// before it. prose/sentences/text: running totals before each piece of the
// prose's length, of its sentences, and of prose and labels together.
// back/forward: where a walk from a piece ended (forward, for each state of
// `signed`), so the walks from the anchors in a long run share one pass
// instead of each going over it again. noticesBelow: the terms send notices
// to the address printed under a party's signature. formParts: the parts
// the terms call a form, by name ("appendix c"). names: the parties' names
// and the document's own headings, for guard 1. blockTables: for each piece
// in a table, whether the table is a block laid out in one (guard 3).
type Doc = {
  clauses: Clause[];
  units: Unit[];
  first: Map<number, number>;
  size: number[];
  part: number[];
  nextPart: number[];
  prevPart: number[];
  prose: number[];
  sentences: number[];
  text: number[];
  back: Map<number, number>;
  forward: Map<number, number>;
  noticesBelow: boolean;
  formParts: Set<string>;
  names: Names;
  blockTables: Map<number, boolean>;
};

function cleanTitle(title: string): string {
  return title.replace(/\s*\(\d+\)$/, "").trim();
}

// Whether a clause can be part of a block that runs on from the clause
// before: its title is a party name, "Signatures", "AGREED AND ACCEPTED" or
// the like, and its text starts like a block.
function titleJoins(doc: Doc, ci: number): boolean {
  const title = cleanTitle(doc.clauses[ci].title);
  if (!title) return true;
  const kind = classify(title).kind;
  if (["party", "sigHeading", "testimony", "pageNote", "closing", "stamp"].includes(kind)) return true;
  if (kind !== "maybeParty") return false;
  const k = doc.first.get(ci);
  return k !== undefined && leadsToSigning(doc.units, k);
}

// Whether the block can cross from clause `from` into clause `to` (the next
// one with text): every clause it enters joins, and empty clauses between
// are block headings too.
function canCross(doc: Doc, from: number, to: number): boolean {
  for (let ci = from + 1; ci <= to; ci++) if (!titleJoins(doc, ci)) return false;
  return true;
}

function walkBack(doc: Doc, from: number): number {
  const { units, back } = doc;
  const path: number[] = [];
  let start = from;
  while (start > 0 && !back.has(start)) {
    path.push(start);
    const u = units[start - 1];
    const next = units[start];
    if (u.ci !== next.ci) {
      // Into the clause before only over the testimony sentence, a page
      // note or a party name under one, never over its terms ("Notices go
      // to: Beta Media LLC").
      if (!canCross(doc, u.ci, next.ci)) break;
      if (!["testimony", "closing", "pageNote", "party", "descriptor", "artifact"].includes(u.kind)) break;
      // A party name that opens its clause is that clause's header ("ORDER
      // FORM / Acme Software, Inc."), unless the clause's title heads a block.
      const above = units[start - 2];
      if (u.kind === "party" && !(above?.ci === u.ci ? ["testimony", "closing", "pageNote", "sigHeading", "party", "artifact"].includes(above.kind) : titleJoins(doc, u.ci))) break;
    } else if (!fitsAbove(u, next)) break;
    start--;
  }
  start = back.get(start) ?? start;
  for (const k of path) back.set(k, start);
  while (start < from && units[start].kind === "artifact") start++;
  return start;
}

// What can sit above the part of a block found so far.
function fitsAbove(u: Unit, next: Unit): boolean {
  // Over the testimony sentence sit only page notes, footers and a heading:
  // a company's name there belongs to the terms ("Payments go to: BETA
  // MEDIA LLC").
  if (next.kind === "testimony" && !["pageNote", "artifact", "sigHeading", "testimony", "closing"].includes(u.kind)) return false;
  switch (u.kind) {
    case "testimony":
    case "closing":
    case "pageNote":
    case "descriptor":
    case "artifact":
    case "sigHeading":
    case "signer":
    case "line":
      return true;
    case "party":
      // Right over where its part starts, or over the company it heads
      // ("AGENCY:" over "BETA MEDIA LLC"), or beside the other party; not
      // a company named at the end of the terms over the block.
      if (SIGNING.has(next.kind) || ["person", "date", "signerLine", "roleSign"].includes(next.kind)) return true;
      return PARTIES.has(next.kind) && (ROLE_LINE.test(u.text) || next.row === u.row || (isAllCaps(u.text) && isAllCaps(next.text)));
    case "roleParty":
    case "maybeParty":
      // Two names side by side, or in capitals, head two columns, as does
      // a name beside the other column's role and its line ("LICENSOR:
      // [LICENSOR]    LICENSEE: ____").
      return SIGNING.has(next.kind) || ((PARTIES.has(next.kind) || next.kind === "roleSign") && (next.row === u.row || (isAllCaps(u.text) && next.kind !== "roleSign")));
    case "signerLine":
      // A signer's title over the witness's heading ("Director / in the
      // presence of:") is the end of the signer's part.
      if (next.kind === "descriptor" && WITNESS_LABEL.test(next.text.replace(/:$/, "").trim())) return true;
      return u.detail === "name" && (SIGNING.has(next.kind) || next.kind === "roleSign");
    case "roleSign":
      // "COMPANY: ____" right over where that party signs, or over what's
      // printed under its own line ("in the presence of: ..... / (signature)").
      return SIGNING.has(next.kind) || next.kind === "caption";
    case "caption":
      // What's printed under a line, over the next line to sign.
      return ["sign", "line", "roleSign"].includes(next.kind);
    case "seal":
      return INSIDE.has(next.kind) || PARTIES.has(next.kind);
    case "person":
    case "date":
      // Blank name and title lines over a signature line that comes last.
      return !!u.blank && ["person", "date", "sign", "line"].includes(next.kind);
    default:
      return false;
  }
}

function walkForward(doc: Doc, from: number): number {
  const { units, forward } = doc;
  const path: number[] = [];
  let end = from;
  let signed = SIGNED.has(units[from].kind);
  let known: number | undefined;
  while ((known = forward.get(2 * end + Number(signed))) === undefined) {
    path.push(2 * end + Number(signed));
    const u = units[end + 1];
    if (!u || (u.ci !== units[end].ci && !canCross(doc, units[end].ci, u.ci))) break;
    if (!fitsBelow(doc, end, signed)) break;
    end++;
    if (PARTIES.has(u.kind)) signed = false;
    else if (SIGNED.has(u.kind)) signed = true;
  }
  end = known ?? end;
  for (const key of path) forward.set(key, end);
  return end;
}

// Whether the piece after `end` carries the block on. `signed`: the current
// party's part already has a signature line, name or title, so contact and
// signer lines under it are the signer's.
function fitsBelow(doc: Doc, end: number, signed: boolean): boolean {
  const { units } = doc;
  const k = end + 1;
  const u = units[k];
  const prev = units[end];
  const next = units[k + 1];
  if (u.kind === "person" && anotherPerson(units, k)) return false;
  // The testimony sentence opens a block; right after an e-signature trace
  // it's the start of the next one, and a trace-like line over it ("IP
  // Address: 198.51.100.24" closing an access term) is the terms' own.
  if (u.kind === "testimony" && prev.kind === "stamp") return false;
  if (INSIDE.has(u.kind)) return true;
  // The signer's name and title under their typed signature, in whatever
  // language the title is ("/s/ Jane Doe" over "Jane Doe, Directrice
  // Générale"): the same name makes it theirs.
  if (prev.kind === "sign" && prev.capture === "typed" && NAME_TITLE.test(u.text) && wordCount(u.text) <= 8 && !/\d/.test(u.text) && u.text.split(",")[0].trim().toLowerCase() === signedName(prev.text)) return true;
  switch (u.kind) {
    case "party":
      // A letter's signer, then the firm they sign for ("Sincerely, / /s/
      // Jane Roe / Jane Roe, Partner / Doe & Roe, LLP").
      if (["signerLine", "person"].includes(prev.kind) && isEntityLine(u.text) && closedAbove(units, end) && next?.kind !== "contact" && !/^\d/.test(next?.text ?? "")) return true;
      return !next || UNDER_PARTY.has(next.kind) || next.kind === "person" || next.kind === "maybeParty" || next.kind === "testimony";
    case "roleParty":
    case "maybeParty":
    case "sigHeading":
      // A blank template's stand-in printed under a bare line ("____ /
      // [ASSIGNOR NAME]") is whose line it is.
      if (u.kind === "maybeParty" && prev.kind === "line" && /^\[[^\[\]]{2,60}\]$/.test(u.text)) return true;
      return leadsToSigning(units, k + 1);
    case "prose":
      // A witness list's number before its line on the row ("1. ____"),
      // under the list's label or the witness before.
      return /^\(?\d{1,2}[.)]$/.test(u.text) && next?.kind === "line" && next.ci === u.ci && next.row === u.row && (signed || prev.kind === "descriptor");
    case "contact":
      // The signer's email or address goes with their name and title, not
      // after the date that ends their part ("Email: ap@acme.com" for
      // billing). When the terms send notices to "the address shown under
      // its signature", a party's street address there is a term: the
      // block ends before it.
      if (doc.noticesBelow && isPartyAddress(u.text)) return false;
      return signed && ["person", "signerLine", "contact", "sign", "stamp", "initials"].includes(prev.kind);
    case "roleSign":
      // Under the party's heading too ("ACME LIMITED / acting by a director
      // in the presence of a witness: / Director: ......").
      return (signed || prev.kind === "descriptor" || PARTIES.has(prev.kind)) && (!next || ["person", "date", "line", "notary", "signerLine", "descriptor", "sign", "stamp"].includes(next.kind));
    case "caption":
      // Under the line, or under the name typed on it ("Printed Name and Title").
      return ["line", "signerLine", "caption"].includes(prev.kind);
    case "signerLine": {
      // A title or date line without a label sits right under the signature
      // or the signer's name, never after the part's last line ("Client
      // Project Lead" heading a contacts list after the block).
      if (u.detail === "date") return signed && ["sign", "stamp", "line", "signerLine", "person", "caption"].includes(prev.kind);
      // Under a row that holds the line to sign with its date or seal beside
      // it ("____  Date: ____", "By: ____ (SEAL)"), the name is the line's.
      const lead = rowLead(units, end);
      // The attesting officer's title, printed under their line after the
      // signer's details ("ATTEST: ____ ... Title: VP / Assistant Secretary").
      if (u.detail !== "name") return signed && (["sign", "stamp", "line", "signerLine", "caption", "roleSign"].includes(lead.kind) || (u.detail === "title" && ["person", "date"].includes(prev.kind) && attestAbove(units, end)));
      // A line set apart by a blank line above and below, with a field or
      // the terms going on under it ("NOTICE OF CANCELLATION" over "Date of
      // Transaction: ____" and the notice's text), heads what follows: it
      // isn't a name typed under the line.
      const after = units[k + 1];
      if (after && after.ci === u.ci && u.row - prev.row >= 2 && after.row - u.row >= 2 && (after.kind === "prose" || after.kind === "label")) return false;
      return (lead.kind === "sign" && lead.capture !== "filled") || ["stamp", "line", "roleSign"].includes(lead.kind) || leadsToSigning(units, k + 1);
    }
    case "artifact": {
      // Page footers and headers only where the block goes on after them.
      let j = k;
      while (j < units.length && units[j].kind === "artifact") j++;
      return j < units.length && (INSIDE.has(units[j].kind) || PARTIES.has(units[j].kind)) && units[j].kind !== "testimony";
    }
    default:
      return false;
  }
}

// The piece a row starts with, past the date or seal beside a line to sign
// at its end ("____  Date: ____", "By: ____ (SEAL)").
function rowLead(units: Unit[], end: number): Unit {
  let j = end;
  while (j > 0 && (units[j].kind === "date" || units[j].kind === "seal") && units[j - 1].ci === units[j].ci && units[j - 1].row === units[j].row) j--;
  return units[j];
}

// Whether the party's part that ends at `end` has an "ATTEST:" or
// "WITNESS:" line in it.
function attestAbove(units: Unit[], end: number): boolean {
  for (let j = end; j >= 0 && j >= end - 8 && units[j].ci === units[end].ci && !PARTIES.has(units[j].kind); j--) {
    if (["descriptor", "roleSign"].includes(units[j].kind) && WITNESS_LABEL.test(units[j].text.split(":")[0].trim())) return true;
  }
  return false;
}

// Whether a letter's closing ("Sincerely,") sits a few lines above `end`.
function closedAbove(units: Unit[], end: number): boolean {
  for (let j = end; j >= 0 && j >= end - 4 && units[j].ci === units[end].ci; j--) if (units[j].kind === "closing") return true;
  return false;
}

// A filled "Name:" after the signer's details are done (their title or the
// date), when their part already has a name and nothing to sign follows:
// someone else listed right under the block, such as a billing contact
// ("Name: Mary Major / Title: Accounts Payable Manager / Email: ...").
// The signer may be named on the line itself ("By: /s/ Jane Doe"); then
// their part is done once its date or a contact line has come, and the
// new name is someone else's unless it's theirs again.
// Two names side by side ("Name: ____ Name: John Roe") are two columns.
const NAME_FIELD = /^(?:(?:printed|print|typed|full)\s+)?name\s*:/i;
function anotherPerson(units: Unit[], k: number): boolean {
  const u = units[k];
  const prev = units[k - 1];
  if (!NAME_FIELD.test(u.text) || u.blank || NAME_FIELD.test(prev.text) || !["person", "date", "contact", "signerLine"].includes(prev.kind)) return false;
  let named = false;
  for (let j = k - 1; j >= 0 && j >= k - 8 && units[j].ci === u.ci && !PARTIES.has(units[j].kind); j--) {
    const v = units[j];
    if (v.kind === "person" && NAME_FIELD.test(v.text)) named = true;
    if (!SIGNING.has(v.kind)) continue;
    if (!named && v.kind === "sign" && (v.capture === "typed" || v.capture === "filled") && (prev.kind === "date" || prev.kind === "contact")) named = signedName(v.text) !== signedName(u.text);
    break;
  }
  if (!named) return false;
  for (let j = k + 1; j < units.length && j <= k + 4 && units[j].ci === u.ci; j++) {
    if (SIGNING.has(units[j].kind)) return false;
    if (!["person", "date", "contact", "signerLine", "caption"].includes(units[j].kind)) break;
  }
  return true;
}

// The name on a signature or name line, to compare two: "By: /s/ Jane
// Doe" and "Name: Jane Doe" both give "jane doe".
function signedName(t: string): string {
  return t.replace(/^[^:]*:/, "").replace(/^\s*\/?s\//, "").split(",")[0].replace(/\s+/g, " ").trim().toLowerCase();
}

// Whether a name line at `k - 1` heads a party's part of a block: what
// follows it, past another name or a descriptor line, is somewhere to sign.
// "Customer Billing Details" over "Company: Acme Corporation" is not.
function leadsToSigning(units: Unit[], k: number): boolean {
  for (let j = k; j < units.length && j < k + 3; j++) {
    const kind = units[j].kind;
    if (SIGNING.has(kind)) return true;
    // The signer's name printed over an e-signature stamp.
    if (!PARTIES.has(kind) && kind !== "artifact" && units[j].detail !== "name") return false;
  }
  return false;
}

// Whether the block ends the contract or one of its parts: nothing but a few
// lines (billing details, bank instructions, a rate table) between it and
// the next exhibit, an e-signature certificate or the end of the file, and
// less of that than there is of the contract above it. A proposal's header
// ("Approved By: John Roe / Date: ...") has the whole proposal below it.
function atPartEnd(doc: Doc, start: number, end: number): boolean {
  const { nextPart, prevPart, prose, sentences, text } = doc;
  const stop = nextPart[end + 1];
  if (sentences[stop] - sentences[end + 1] > 3) return false;
  const from = start > 0 ? Math.max(prevPart[start - 1], 0) : 0;
  return prose[stop] - prose[end + 1] <= text[start] - text[from];
}

// How a run of pieces reads as a block. byEnd: it's only taken because it
// ends its part (it has no sentence saying the parties sign).
// heading: a sign-off heading over the block, taken with it though a
// sentence between stays (-1 for none).
// named: it has a party's name or a Name/Title line, as an execution
// block does and a list of fields to sign in the terms doesn't.
type Verdict = { strong: number; sworn: boolean; testimony: boolean; byEnd: boolean; heading: number; named: boolean };

// What reads as a signature block rather than terms: somewhere to sign
// (a blank, a typed /s/ signature, an e-signature stamp) and more lines of
// a block with it.
function judgeBlock(doc: Doc, start: number, end: number): Verdict | null {
  if (doc.size[end + 1] - doc.size[start] > 6000) return null;
  const block = doc.units.slice(start, end + 1);
  let strong = 0;
  let filled = 0;
  let details = 0;
  let parties = 0;
  let testimony = false;
  let sworn = false;
  block.forEach((u, k) => {
    const after = block.slice(k + 1, k + 4);
    if (u.kind === "sign") {
      if (u.capture === "filled") filled++;
      // An empty "By:" over a printed line the text lost, with Name: under it.
      else if (u.capture !== "empty" || after.some((n) => n.kind === "person")) strong++;
    } else if (u.kind === "line") {
      // A blank line with what to write under it, or whose line it is
      // ("____ / Client").
      if (after.slice(0, 2).some((n) => ["caption", "person", "signerLine", "date", "sign", "notary", "party"].includes(n.kind))) strong++;
    } else if (u.kind === "stamp") strong++;
    else if (["person", "date", "caption", "signerLine", "contact", "initials", "notary"].includes(u.kind)) details++;
    else if (PARTIES.has(u.kind)) parties++;
    else if (["testimony", "closing", "pageNote"].includes(u.kind)) {
      testimony = true;
      if (u.sworn) sworn = true;
    }
  });
  const named = parties > 0 || block.some((u) => u.kind === "person");
  const verdict = (byEnd: boolean, heading = -1): Verdict => ({ strong, sworn, testimony, byEnd, heading, named });
  const terminal = atPartEnd(doc, start, end);
  const support = strong + filled + details + parties + (testimony ? 1 : 0);
  if (strong > 0 && support >= 2) {
    if (testimony) return verdict(false);
    if (terminal) return verdict(true);
    const heading = coverAcceptance(doc, start, end);
    return heading >= 0 ? verdict(false, heading) : null;
  }
  // A name typed into the signature line, with no /s/ or e-signature
  // trace, only where the contract ends: in the middle it may be a term
  // ("Signature authority: Jane Doe").
  if (filled > 0 && details > 0) return terminal ? verdict(true) : null;
  // The file ends right after "IN WITNESS ..." and the party names: the
  // rest of the block was cut off.
  if (sworn && end === doc.units.length - 1) {
    const last = block[block.length - 1];
    return parties > 0 || (last.kind === "testimony" && !/[.!?:;"”)\]]$/.test(last.text)) ? verdict(false) : null;
  }
  return null;
}

// A party's part written name first and signed last ("On behalf of the
// Controller: / Name: Jane Roe / Position: Head of Compliance / Address:
// ... / Signature: ____"): over the line to sign, the signer's details and
// contact lines, back to the party's own heading, are the block's. Without
// that heading right over them they may be a contacts list, and stay.
const PART_HEAD: ReadonlySet<Kind> = new Set<Kind>(["descriptor", "party", "roleParty", "sigHeading"]);
function namedAbove(doc: Doc, start: number): number {
  const { units } = doc;
  if (units[start].kind !== "sign") return start;
  let j = start - 1;
  let persons = 0;
  while (j >= 0 && j >= start - 12 && units[j].ci === units[start].ci && (units[j].kind === "person" || units[j].kind === "contact")) {
    if (units[j].kind === "person") persons++;
    j--;
  }
  if (j < 0 || j === start - 1 || !persons || units[j].ci !== units[start].ci || !PART_HEAD.has(units[j].kind)) return start;
  return walkBack(doc, j);
}

// The block from `start` through `end` as runs of pieces, leaving out a
// party's street address that sits over where the party signs: its details
// are terms (notices go there), the lines around them are the block's.
function aroundAddresses(units: Unit[], start: number, end: number): [number, number][] {
  const runs: [number, number][] = [];
  let from = start;
  for (let k = start; k <= end; k++) {
    if (units[k].kind !== "contact" || !isPartyAddress(units[k].text)) continue;
    let j = k + 1;
    while (j <= end && !SIGNING.has(units[j].kind) && !PARTIES.has(units[j].kind) && units[j].kind !== "descriptor") j++;
    if (j > end || !SIGNING.has(units[j].kind)) continue;
    if (from < k) runs.push([from, k - 1]);
    from = k + 1;
  }
  if (from <= end) runs.push([from, end]);
  return runs;
}

// A proposal's acceptance block on its cover, above the whole proposal
// ("PROPOSAL ACCEPTANCE / Client accepts this proposal ... / Signature: ____
// / Name: ____ / Title: ____ / Date: ____", then "1. Introduction"): only
// blank lines to sign and fill in, three or more, closing their clause (or
// a box signed with a typed signature, its details filled in), under a
// sign-off heading at most a sentence above them, with hardly any text
// before it in the file. Returns the heading, or -1. The sentence between
// stays: it may tie the acceptance to terms.
function coverAcceptance(doc: Doc, start: number, end: number): number {
  const { units, sentences, prevPart, first, clauses } = doc;
  // A sign-off heading the walk took in is the heading itself.
  if (units[start].kind === "sigHeading" && start < end) {
    const h = coverAcceptance(doc, start + 1, end);
    return h === start ? start : -1;
  }
  const block = units.slice(start, end + 1);
  if (block.length < 3 || !block.some((u) => u.kind === "sign")) return -1;
  // A box signed with a typed signature or an e-signature, its signer's
  // details filled in, is the file's own acceptance whatever follows it;
  // one with blank lines must close its clause.
  const signed = block.some((u) => u.kind === "stamp" || (u.kind === "sign" && (u.capture === "typed" || u.capture === "stamp")));
  if (signed) {
    if (!block.every((u) => ["sign", "person", "date", "line", "stamp", "signerLine"].includes(u.kind))) return -1;
  } else if (units[end + 1]?.ci === units[end].ci || !block.every((u) => (u.kind === "sign" && u.capture === "blank") || ((u.kind === "person" || u.kind === "date") && u.blank) || u.kind === "line")) return -1;
  const early = (h: number) => sentences[h] <= 2 && (h === 0 || prevPart[h - 1] <= 0);
  // The heading as the clause's title, from a splitter that makes one of it.
  if (first.get(units[start].ci) === start) return classify(cleanTitle(clauses[units[start].ci].title)).kind === "sigHeading" && early(start) ? start : -1;
  for (let h = start - 1; h >= 0 && h >= start - 2 && units[h].ci === units[start].ci; h--) {
    if (units[h].kind === "sigHeading") return early(h) ? h : -1;
    if (units[h].kind !== "prose") return -1;
  }
  return -1;
}

// The request to sign above the block at `start`, past a sentence or two
// on the same line, or -1.
function requestAbove(units: Unit[], start: number): number {
  for (let j = start - 1; j >= 0 && j >= start - 3; j--) {
    const u = units[j];
    if (u.ci !== units[start].ci) return -1;
    if (u.kind === "testimony") return j < start - 1 && !u.sworn && units.slice(j + 1, start).every((v) => v.row === u.row) ? j : -1;
    if (u.kind !== "prose") return -1;
  }
  return -1;
}

// A heading that starts with "Form of" ("FORM OF CHANGE ORDER") starts a
// part. "Form of Payment: ACH" is a field, not a heading.
const FORM_HEADING = /^form of\b[^:.!?]{0,80}$/i;

// Whether a block was signed: a typed /s/ signature, a name written on the
// line, or an e-signature trace.
function executed(units: Unit[], start: number, end: number): boolean {
  for (let j = start; j <= end; j++) {
    const u = units[j];
    if (u.kind === "stamp" || (u.kind === "sign" && (u.capture === "typed" || u.capture === "filled" || u.capture === "stamp"))) return true;
  }
  return false;
}

// In a signed copy, a block in a later part with nothing filled in (no
// signature, name or date) wasn't signed with the contract: it's a form
// for later, whatever its heading says ("EXHIBIT B / PERSONNEL
// ACKNOWLEDGMENT / I have read Section 9 ... / Name: ____ / Signature: ____").
// `signedBefore`: a block found before this one was signed.
function unsignedLater(doc: Doc, start: number, end: number, before: Found[], signedBefore: boolean): boolean {
  const p = doc.part[start];
  if (!signedBefore || p < 0 || before[before.length - 1].end >= p) return false;
  for (let j = start; j <= end; j++) {
    const u = doc.units[j];
    if ((u.kind === "person" || u.kind === "date" || u.kind === "signerLine") && !u.blank) return false;
  }
  return !executed(doc.units, start, end);
}

type Found = { start: number; end: number; verdict: Verdict };

const ANCHORS: ReadonlySet<Kind> = new Set<Kind>(["sign", "line", "stamp", "testimony", "pageNote", "closing"]);

export function findSignatureBlocks(clauses: Clause[]): SignatureRange[] {
  const units = piecesOf(clauses);
  const first = new Map<number, number>();
  units.forEach((u, k) => {
    if (!first.has(u.ci)) first.set(u.ci, k);
  });
  const size = [0];
  for (const u of units) size.push(size[size.length - 1] + u.text.length);
  const part: number[] = [];
  units.forEach((u, k) => {
    const title = cleanTitle(clauses[u.ci].title);
    const titled = first.get(u.ci) === k && (isPartHeading(title) || FORM_HEADING.test(title));
    part.push(u.kind === "part" || titled || FORM_HEADING.test(u.text) ? k : k ? part[k - 1] : -1);
  });
  // Where each part starts, and running totals of the text, so how much is
  // left before the next part and how much came before is read at once.
  const startsPart = units.map((u, k) => u.kind === "part" || u.kind === "cert" || (k > 0 && first.get(u.ci) === k && isPartHeading(cleanTitle(clauses[u.ci].title))));
  const nextPart = new Array<number>(units.length + 1).fill(units.length);
  for (let k = units.length - 1; k >= 0; k--) nextPart[k] = startsPart[k] ? k : nextPart[k + 1];
  const prevPart: number[] = [];
  startsPart.forEach((s, k) => prevPart.push(s ? k : k ? prevPart[k - 1] : -1));
  const prose = [0];
  const sentences = [0];
  const text = [0];
  for (const u of units) {
    prose.push(prose[prose.length - 1] + (u.kind === "prose" ? u.text.length : 0));
    sentences.push(sentences[sentences.length - 1] + (u.kind === "prose" && wordCount(u.text) >= 6 ? 1 : 0));
    text.push(text[text.length - 1] + (u.kind === "prose" || u.kind === "label" ? u.text.length : 0));
  }
  const noticesBelow = clauses.some((c) => NOTICES_BELOW.test(c.body));
  const doc: Doc = { clauses, units, first, size, part, nextPart, prevPart, prose, sentences, text, back: new Map(), forward: new Map(), noticesBelow, formParts: formParts(clauses), names: namesOf(clauses, units), blockTables: new Map() };

  const found: Found[] = [];
  let signedBefore = false;
  for (let i = 0; i < units.length; i++) {
    if (!ANCHORS.has(units[i].kind)) continue;
    const start = namedAbove(doc, walkBack(doc, i));
    let end = walkForward(doc, i);
    const verdict = judgeBlock(doc, start, end);
    if (!verdict) continue;
    if (unsignedLater(doc, start, end, found, signedBefore)) {
      i = end;
      continue;
    }
    // A page footer left alone at the end of the clause goes with the block.
    let j = end + 1;
    while (j < units.length && units[j].ci === units[end].ci && units[j].kind === "artifact") j++;
    if (j === units.length || units[j].ci !== units[end].ci) end = j - 1;
    found.push({ start, end, verdict });
    signedBefore ||= executed(units, start, end);
    i = end;
  }

  // A block taken only because little follows it in its part doesn't end
  // the part when a stronger one (with "IN WITNESS ..." or more lines to
  // sign) still comes in it: a line to sign in the last terms ("Witnessed
  // by: ____ Date: ____ Results are binding only ...") stays. Nor does one
  // with no party and no Name/Title line when a block that has them still
  // follows: lines to sign that the terms list (a change log's "Requested
  // by: ____ Date: ____") come before the parties' own block.
  const blocks: [number, number][] = [];
  found.forEach((b, n) => {
    if (b.verdict.byEnd) {
      for (let m = n + 1; m < found.length && found[m].start < nextPart[b.end + 1]; m++) {
        if (found[m].verdict.sworn || found[m].verdict.strong > b.verdict.strong || (!b.verdict.named && found[m].verdict.named)) return;
      }
      // Guard 5 too: such a block with no party and no Name/Title line, and
      // terms (two sentences or more) between it and a block found above,
      // is a form the contract hands over for later, such as a notice of
      // cancellation ("I HEREBY CANCEL ... / Date: ____ / Buyer's
      // Signature: ____"): the contract's own block came first.
      if (!b.verdict.named && n > 0 && sentences[b.start] - sentences[found[n - 1].end + 1] >= 2) return;
    }
    const kept = precisionGuards(doc, b.start, b.end, n > 0 ? found[n - 1].end : -1);
    if (!kept.length) return;
    // A request to sign run onto a term on its line ("To accept this
    // proposal, sign below. Work begins within ten days ...") goes with the
    // block; the term stays.
    const request = requestAbove(units, kept[0][0]);
    if (request >= 0 && !keptSentence(doc, request)) blocks.push([request, request]);
    if (b.verdict.heading >= 0) blocks.push([b.verdict.heading, b.verdict.heading]);
    blocks.push(...kept);
  });
  // A sign-off heading right under one block, with the next block a line or
  // two below it ("... Doe & Roe, LLP / REPLY: / We agree to the
  // above ... / Client signature: ____"), goes; the
  // lines between it and that block stay.
  const headings: [number, number][] = [];
  for (let n = 0; n + 1 < blocks.length; n++) {
    const h = blocks[n][1] + 1;
    const next = blocks[n + 1][0];
    if (h < next && next - h <= 3 && units[h].kind === "sigHeading" && units[h].ci === units[h - 1].ci && !units.slice(h, next).some((u) => u.kind === "part")) headings.push([h, h]);
  }
  blocks.push(...headings);

  const ranges: SignatureRange[] = [];
  for (const [start, end] of blocks) for (const [a, b] of aroundAddresses(units, start, end)) ranges.push(...rangesOf(doc, a, b));
  ranges.push(...certificates(doc, blocks));

  // A clause called "Signatures" that only says who signs ("For Client:
  // Acme Inc., by Jane Doe, CFO") is the block too, labels or not. One that
  // says how signing works is a term.
  clauses.forEach((c, ci) => {
    if (!SIGNATURES_TITLE.test(cleanTitle(c.title)) || ranges.some((r) => r.clause === ci)) return;
    const mine = units.filter((u) => u.ci === ci);
    const statements = mine.filter((u) => SIGNER_STATEMENT.test(u.text) && wordCount(u.text) <= 30);
    if (statements.length && mine.every((u) => statements.includes(u) || PARTIES.has(u.kind) || u.kind === "signerLine")) ranges.push({ clause: ci, start: 0, end: c.body.length });
  });

  return mergeRanges([...ranges, ...emptyHeadings(clauses, ranges)]);
}

// The pieces from `start` through `end` as ranges: each clause they touch,
// from its first piece there through the whitespace after its last, so what
// follows starts cleanly.
function rangesOf(doc: Doc, start: number, end: number): SignatureRange[] {
  const { units, clauses, first } = doc;
  const out: SignatureRange[] = [];
  for (let a = start; a <= end; ) {
    const ci = units[a].ci;
    let b = a;
    while (b < end && units[b + 1].ci === ci) b++;
    const after = b + 1 < units.length && units[b + 1].ci === ci ? units[b + 1].start : clauses[ci].body.length;
    out.push({ clause: ci, start: first.get(ci) === a ? 0 : units[a].start, end: after });
    a = b + 1;
  }
  return out;
}

// The parties' names over the signers' with no label or suffix to mark
// them ("Acme Design   Beta Web Studio"): only words in
// title case, right over the signers' lines (a blank line between at most),
// and on a line of its own or after a finished sentence. A splitter that
// runs a clause onto one line may leave the names and titles in it too
// ("... notice. Acme Design Beta Web Studio Jane Doe John Roe Owner
// Principal 01 / 02 / 2026").
const TITLE_ROW = /^\p{Lu}[\p{L}'’.-]*(?:\s+(?:&|and|of|\p{Lu}[\p{L}'’.,-]*))*$/u;
function partyRow(units: Unit[], j: number, below: number): boolean {
  const u = units[j];
  const next = units[below];
  const prev = j > 0 && units[j - 1].ci === u.ci && units[j - 1].row === u.row ? units[j - 1] : null;
  const gap = next.row - u.row;
  return (
    below === j + 1 &&
    next.kind === "signerLine" &&
    next.ci === u.ci &&
    gap >= 0 &&
    gap <= 2 &&
    (!prev || /[.!?:]["'’”)]*$/.test(prev.text)) &&
    wordCount(u.text) <= 16 &&
    TITLE_ROW.test(u.text)
  );
}

// Every two words in title case side by side ("Jane Doe"), as a set.
const WORD_PAIR = /(?<!\p{L})(?=(\p{Lu}\p{Ll}+\s+\p{Lu}\p{Ll}+)(?!\p{L}))/gu;
function wordPairs(s: string): Set<string> {
  return new Set([...s.matchAll(WORD_PAIR)].map((m) => m[1].replace(/\s+/g, " ")));
}

// The dates in a text as year-month-day keys, however they're written
// ("Jul 14, 2026", "14 July 2026", "07 / 14 / 2026", "2026-07-14"). A date in
// numbers alone could be month first or day first, so it gives both.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DATE_FORMS = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b|\b(\p{L}{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b|\b(\d{1,2})\s+(\p{L}{3,9})\.?,?\s+(\d{4})\b|\b(\d{1,2})\s*[/.]\s*(\d{1,2})\s*[/.]\s*(\d{4}|\d{2})\b/gu;
function dateKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const month = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  const add = (y: string, m: number, d: string) => {
    if (m >= 1 && m <= 12) keys.add(`${y.length === 2 ? `20${y}` : y}-${m}-${Number(d)}`);
  };
  for (const g of text.matchAll(DATE_FORMS)) {
    if (g[1]) add(g[1], Number(g[2]), g[3]);
    else if (g[4]) add(g[6], month(g[4]), g[5]);
    else if (g[7]) add(g[9], month(g[8]), g[7]);
    else {
      add(g[12], Number(g[10]), g[11]);
      add(g[12], Number(g[11]), g[10]);
    }
  }
  return keys;
}

// An e-signature service draws the signatures as pictures, so all the text
// may hold above its certificate is who signed and when ("Jane Doe /
// Acme Events LLC / Jul 14, 2026"). Right over a certificate those lines
// are the block when they hold a name and a date the certificate records
// too: a schedule's "Go Live / 10/15/2026", or a sponsor named in a table
// of key dates, looks the same, and only the match tells them apart. Returns where they start, or
// `k` when there are none. Into the clause before only from a certificate
// that is a clause of its own, and to that clause's start only when its
// title heads a block. `certificate`: the certificate's text.
const SIGNER_ONLY: ReadonlySet<Kind> = new Set<Kind>(["signerLine", "party", "maybeParty", "roleParty", "artifact", "caption"]);
function signersAbove(doc: Doc, k: number, blocks: [number, number][], certificate: string): number {
  const { units, clauses, first } = doc;
  let start = k;
  let dates = 0;
  for (let j = k - 1; j >= 0; j--) {
    const u = units[j];
    if (u.ci !== units[j + 1].ci && first.get(units[j + 1].ci) !== k) break;
    if (u.kind === "sigHeading" || (u.kind === "prose" && partyRow(units, j, start))) {
      start = j;
      break;
    }
    if (!SIGNER_ONLY.has(u.kind)) break;
    if (first.get(u.ci) === j && clauses[u.ci].title.trim() && !["sigHeading", "party", "testimony"].includes(classify(cleanTitle(clauses[u.ci].title)).kind)) break;
    if (u.kind === "signerLine" && u.detail === "date") dates++;
    start = j;
  }
  // Lines like these after a block that was found are the document's own,
  // not the signers'.
  if (!dates || start === k || blocks.some(([, end]) => end < start)) return k;
  const when = dateKeys(certificate);
  if (!units.slice(start, k).some((u) => [...dateKeys(u.text)].some((d) => when.has(d)))) return k;
  const signed = wordPairs(certificate);
  for (let j = start; j < k; j++) {
    for (const pair of wordPairs(units[j].text)) if (signed.has(pair)) return start;
  }
  return k;
}

// An e-signature certificate or audit trail, from its heading through the
// end of its clause. The heading may be a line of its own or, from a
// splitter that makes headings in capitals into titles, a clause's title.
// After a block it runs on through the clauses that are more of it (the
// service appends it to the end of the file), but never into terms: it stops
// at the next part, at a sentence of terms, or at the heading of something
// else ("SUPPORT"). Without a block before it, only a heading that
// only a service writes counts, and only in its own clause.
const CERT_LOOK = 120;
// A sentence in words: a capital, six words or more with three in lower
// case, a full stop, and no time or number a trail's line would have.
const FULL_SENTENCE = /^(?=(?:\S+\s+){5})(?=(?:.*?\s\p{Ll}+\b){3})\p{Lu}[^\d]*[.!?]$/u;
// The words after a line's last number and the time zone or AM/PM after
// it. In a trail run onto one line, a sentence can follow the last IP
// address or time with no break between ("... IP Address: 198.51.100.23
// The Customer keeps this record ...").
function afterLastNumber(t: string): string {
  let i = t.length - 1;
  while (i >= 0 && !(t[i] >= "0" && t[i] <= "9")) i--;
  return i < 0 ? "" : t.slice(i + 1).replace(/^\S*\s+(?:\p{Lu}{2,4}\.?\s+)*/u, "");
}
function certificates(doc: Doc, blocks: [number, number][]): SignatureRange[] {
  const { units, clauses, first } = doc;
  const out: SignatureRange[] = [];
  // A clause's pieces sit together, from its first one on.
  const clauseUnits = new Map<number, Unit[]>();
  const inClause = (ci: number) => {
    let mine = clauseUnits.get(ci);
    if (!mine) {
      mine = [];
      for (let j = first.get(ci) ?? units.length; j < units.length && units[j].ci === ci; j++) mine.push(units[j]);
      clauseUnits.set(ci, mine);
    }
    return mine;
  };
  // Guard 6 too: a certificate stops at the next part, at any full
  // sentence (a term about audit trails, not a line of the trail), or at
  // the heading of something else.
  const ends = (mine: Unit[], j: number) => mine[j].kind === "part" || TERMS.test(mine[j].text) || FULL_SENTENCE.test(mine[j].text) || FULL_SENTENCE.test(afterLastNumber(mine[j].text)) || endsCertificate(mine[j].text, mine[j + 1]?.text);
  // For each piece of a clause, the first piece from it on that ends a
  // certificate, worked out once: a clause with many headings that aren't
  // certificates would otherwise be scanned again from each of them.
  const stops = new Map<number, number[]>();
  const stopFrom = (ci: number, j: number) => {
    let stop = stops.get(ci);
    if (!stop) {
      const mine = inClause(ci);
      stop = new Array<number>(mine.length + 1);
      stop[mine.length] = mine.length;
      for (let t = mine.length - 1; t >= 0; t--) stop[t] = ends(mine, t) ? t : stop[t + 1];
      stops.set(ci, stop);
    }
    return stop[j];
  };
  // A later clause is more of the certificate when it records events (or
  // its title says it's part of one, "Signer Events", and it has times or
  // IP addresses) and holds nothing that ends one.
  const carriesOn = (ci: number) => {
    const mine = inClause(ci);
    const title = cleanTitle(clauses[ci].title);
    if (isPartHeading(title) || endsCertificate(title, mine[0]?.text) || mine.some((_, j) => ends(mine, j))) return false;
    const text = [title, ...mine.map((u) => u.text)].join("\n");
    // Times, not the word "timestamps", which a security term uses too.
    return hasIdValue(text) || EVENTS.some((re) => re.test(text)) || (CERT_PART.test(title) && (/\d{1,2}:\d{2}/.test(text) || IP_VALUE.test(text)));
  };
  // DocuSign's consent text runs to the next part, through clauses a
  // splitter made of its own headings ("Getting paper copies").
  const consentOn = (ci: number) => !isPartHeading(cleanTitle(clauses[ci].title)) && !inClause(ci).some((u) => u.kind === "part");
  for (let k = 0; k < units.length; k++) {
    const u = units[k];
    const titled = first.get(u.ci) === k && CERT.test(cleanTitle(clauses[u.ci].title));
    if (u.kind !== "cert" && !titled) continue;
    // Guard 6: a certificate follows its block with no new part between
    // them ("ANNEX 2 - SECURITY / Audit Report / Document ID: ..." is the
    // annex's). One with no block before it needs a heading only a service
    // writes, and comes after every block: one above the block is a term
    // about audit trails, whatever sample it shows.
    const afterBlock = blocks.some(([start, end]) => start < k && doc.part[k] <= end);
    if (!afterBlock && (!CERT_OWN.test(titled ? cleanTitle(clauses[u.ci].title) : u.text) || blocks.some(([start]) => start > k))) continue;
    // What follows the heading in its clause, up to whatever ends it.
    const mine = inClause(u.ci);
    const from = k - (first.get(u.ci) ?? k) + (titled ? 0 : 1);
    let to = stopFrom(u.ci, from);
    // Its first lines show whether it's one; a bounded look keeps a clause
    // full of such headings linear.
    if (!isCertificate(mine.slice(from, Math.min(to, from + CERT_LOOK)), titled ? "" : u.text)) continue;
    // Past the consent text's heading, the rest of it goes too.
    let consent = afterBlock && mine.slice(from, Math.min(to + 1, mine.length)).some((v) => ERSD.test(v.text));
    if (consent) while (to < mine.length && mine[to].kind !== "part") to++;
    // The document's name on the line between the signatures and the
    // certificate's heading ("Services Agreement - Acme x Beta") is the
    // certificate's header.
    const name = units[k - 1];
    const named = !titled && name?.ci === u.ci && name.kind === "prose" && wordCount(name.text) <= 12 && !/[.!?:;]$/.test(name.text) && !TERMS.test(name.text) && blocks.some(([, end]) => end === k - 2);
    const start = first.get(u.ci) === k ? 0 : named ? name.start : u.start;
    out.push({ clause: u.ci, start, end: to < mine.length ? mine[to].start : clauses[u.ci].body.length });
    const signers = signersAbove(doc, named ? k - 1 : k, blocks, mine.slice(from, to).map((v) => v.text).join("\n"));
    if (signers < k) out.push(...rangesOf(doc, signers, (named ? k - 1 : k) - 1));
    let ci = u.ci;
    if (to === mine.length && afterBlock) {
      while (ci + 1 < clauses.length) {
        if (!consent && ERSD.test(cleanTitle(clauses[ci + 1].title))) consent = true;
        if (!(consent ? consentOn(ci + 1) : carriesOn(ci + 1))) break;
        out.push({ clause: ++ci, start: 0, end: clauses[ci].body.length });
      }
    }
    while (k + 1 < units.length && units[k + 1].ci <= ci) k++;
  }
  return out;
}

// Whether the lines under a certificate heading are one: lines of IDs,
// events and times that start right away, not with a sentence (a line
// that starts with a date and runs on is the trail itself). Page headers
// ("DocuSign Envelope ID: ...") don't count, as an executed copy has them on
// every page. `heading`: the heading's own line, which may hold the ID.
function isCertificate(units: Unit[], heading: string): boolean {
  const lines = units.filter((u) => u.kind !== "artifact");
  if (!lines.length) return false;
  if (lines[0].kind === "prose" && wordCount(lines[0].text) >= 8 && /^\p{L}/u.test(lines[0].text) && /[.!?]$/.test(lines[0].text)) return false;
  return isAuditTrail([heading, ...lines.map((u) => u.text)].join("\n"));
}

// Clauses with a title and no text, where the splitter made a line of the
// block a title ("AGENCY", "CLIENT", "AGREED AND ACCEPTED"): they go with
// the block they sit inside, or with the clause they head when all of it is
// block. Their range is empty, which takes the clause and its title.
const HEADS_BLOCK: ReadonlySet<Kind> = new Set<Kind>(["party", "roleParty", "testimony", "sigHeading", "closing", "pageNote"]);
function emptyHeadings(clauses: Clause[], ranges: SignatureRange[]): SignatureRange[] {
  const empty = (ci: number) => !clauses[ci].body.trim();
  const reachesEnd = (r: SignatureRange) => r.end >= clauses[r.clause].body.trimEnd().length;
  const kind = (ci: number) => classify(cleanTitle(clauses[ci].title)).kind;
  const out: SignatureRange[] = [];
  for (let a = 0; a < clauses.length; a++) {
    if (!empty(a)) continue;
    let b = a;
    while (b + 1 < clauses.length && empty(b + 1)) b++;
    const next = ranges.filter((r) => r.clause === b + 1 && r.start === 0);
    // The run of block headings right above the next clause, by what counts.
    const heads = (ok: (k: Kind) => boolean) => {
      let from = b + 1;
      while (from > a && ok(kind(from - 1))) from--;
      return from;
    };
    let from = next.some(reachesEnd) ? heads((k) => HEADS_BLOCK.has(k)) : b + 1;
    // Between two clauses of a block, any name-like title is part of it.
    const inside = next.length && ranges.some((r) => r.clause === a - 1 && reachesEnd(r));
    if (inside && heads((k) => HEADS_BLOCK.has(k) || k === "maybeParty") === a) from = a;
    for (let ci = from; ci <= b; ci++) out.push({ clause: ci, start: 0, end: 0 });
    a = b;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Precision guards
// ---------------------------------------------------------------------------

// Guard 1 reads a sentence for what it says beyond "the parties sign this".
// The words signing is said in: a closed set, and a sentence that uses any
// other word is about something else, so it stays. One word is enough to
// make a term ("irrevocably", "jointly", "retroactively", "supersedes"), so
// there's no allowance. Words that carry terms ("counterparts",
// "electronically", "binding", "provided") are left out on purpose, and the
// words of a letter's request ("terms", "understanding", "letter") count only
// inside the phrases below, never on their own.
const SIGNING_WORDS = new Set(
  (
    "in witness whereof thereof hereof hereto herein hereby hereunder hereunto below above parties party each both undersigned " +
    "have has had having be been being is are was were executed execute executes executing execution signed sign signs signing " +
    "signature signatures countersign countersigned caused cause causes duly authorized authorised authority representative " +
    "representatives officer officers signatory signatories agent agents person persons named respective respectively through " +
    "intending intend legally bound sealed seal seals under hands hand delivered accepted accept accepts acceptance agreed approve " +
    "approved approves approval acknowledged acknowledge acknowledges confirm confirms confirmed indicate date dated dates day " +
    "effective first last later latest written set forth stated shown indicated appearing opposite beginning entered into as of " +
    "by the a an and or to on its their his her our your my it they them we you us i me for with behalf name names please " +
    "kindly return copy enclosed where following follows this that these those at from upon same hereinafter mentioned year"
  ).split(" "),
);
const ROLE_WORDS = new Set<string>(ROLE.match(/[a-z]+/g));
// Another document a sentence brings in ("the Terms of Service", "the Data
// Processing Addendum", "Exhibit A"), which signing doesn't. In title case
// or in capitals, not after "this".
const DOCUMENT_WORDS = ["Terms", "Addendum", "Addenda", "Policy", "Policies", "Notice", "Notices", "Schedule", "Schedules", "Exhibit", "Exhibits", "Annex", "Annexes", "Appendix", "Appendices", "Attachment", "Attachments", "Rider", "Riders", "Amendment", "Amendments", "Guidelines", "Specifications", "Statement of Work", "Order Form", "Purchase Order"];
const DOCUMENT_ALT = [...DOCUMENT_WORDS, ...DOCUMENT_WORDS.map((w) => w.toUpperCase())].join("|");
const OTHER_DOCUMENT = new RegExp(String.raw`(?<!\b(?:this|these|THIS|THESE)\s)\b(?:${DOCUMENT_ALT})\b`);
// The document's own name, which says nothing more: "this Agreement", "the
// Order Form", "this Consulting Agreement", "this Amendment No. 1",
// "this Note". After "this", any name in title case that isn't another
// document's ("this Agreement and Exhibit A" brings in the exhibit); with
// "the", only the bare name: "the Master Services Agreement" may be another
// document. "Agrees to this Order Form" accepts it, no more.
const anyCase = (words: string[]) =>
  words.flatMap((w) => [w, w.replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase()), w.replace(/(^|\s)(?!(?:of|and)\b)\p{Ll}/gu, (c) => c.toUpperCase()), w.toUpperCase()]).join("|");
const OWN_NAME = String.raw`(?:${anyCase(["agreement", "contract", "amendment", "order form", "order", "form", "proposal", "quote", "quotation", "estimate", "offer", "sow", "statement of work", "letter agreement", "letter", "document", "instrument", "engagement"])})s?(?:\s+No\.?\s*\d+)?\b`;
const NAME_WORD = String.raw`(?!(?:${DOCUMENT_ALT})\b)\p{Lu}[\p{L}-]*`;
const SELF_REFERENCE = new RegExp(
  String.raw`\b(?:agree[sd]?\s+(?:to|with)\s+)?(?:(?:${anyCase(["this", "these"])})\s+(?:(?:${NAME_WORD}|and|of|&)\s+){0,5}(?:${OWN_NAME}|${NAME_WORD}\p{L}\b)|(?:${anyCase(["the", "our", "your"])})\s+${OWN_NAME})`,
  "gu",
);
// A date the contract defines: "as of the Commencement Date", "the SOW
// Effective Date".
const DEFINED_DATE = /\b(?:the|its|their)\s+(?:\p{Lu}[\p{L}-]*\s+){1,3}Date\b/gu;
// The phrases of signing that hold words which, alone, could be terms.
const SIGNING_PHRASES = /\b(?:in\s+)?the\s+spaces?\s+provided\b|\bin\s+the\s+presence\s+of\b/gi;
// A letter's request to sign refers to the letter by what it holds: "these
// terms", "our understanding", "the terms of our engagement", "these
// arrangements". Only after such a word, and only in lower case: "the Terms
// and Conditions" is a part of its own.
const BACK_REFERENCE = /\b(?:[Tt]he|[Tt]hese|[Tt]his|[Oo]ur|[Yy]our|[Ii]ts|[Tt]heir)\s+(?:mutual\s+)?(?:terms|understanding|engagement|arrangements?)\b/gu;
// What a letter says before it asks, up to the comma: "If you agree with
// the terms of our engagement as described in this letter,", "If this
// letter accurately reflects our understanding,", "If these terms are
// acceptable,". The whole clause or nothing: its words don't count alone.
const LETTER_IF = /\bif\s+(?:you\s+agree(?:\s+(?:with|to))?|(?:this|the|these|our)\s+(?:letter|foregoing|terms|above)(?:\s+(?:is|are))?(?:\s+(?:accurately|correctly|fairly))?\s+(?:reflects?|sets?\s+forth|states?|confirms?|acceptable|agreeable|satisfactory))(?:\s+(?:with|to))?(?:\s+(?:the\s+terms\s+of\s+)?(?:our|your|the)\s+(?:understanding|agreement|engagement|arrangements?))?(?:\s+(?:as\s+)?(?:described|set\s+(?:forth|out))\s+(?:in\s+this\s+letter|above))?(?:\s+to\s+you)?\s*,/gi;
// Who a signed copy goes back to ("return it to Beta Media"), and who
// a party signs for ("Accepted and agreed on behalf of Acme Clinics:").
const RETURN_TO = /\b(return\b[^.;:]{0,40}?\bto|\bon\s+behalf\s+of(?:\s+the)?)\s+(?:\p{Lu}[\p{L}&'’.,-]*:?(?:\s+|$)){1,6}/gu;
// Who signs, named before the verb: "the Members have executed", "Lessor
// and Lessee have signed".
const SIGNERS = /\b(?:the\s+)?(?:\p{Lu}[\p{L}'’-]*(?:\s+(?:and|&)\s+|\s*,\s*|\s+)?){1,4}(?=(?:hereto\s+)?(?:have|has)\s+(?:duly\s+)?(?:executed|signed|caused|set)\b)/gu;
const MONEY = /[$€£¥]\s?\d|\b(?:USD|EUR|GBP|CAD|AUD)\s?\d|\d\s?(?:USD|EUR|GBP|dollars)\b/i;
const URL_OR_EMAIL = /\S@\S|\bhttps?:\/\/|\bwww\.|\b[\w-]+\.(?:com|net|org|io|co|gov|edu)\b/i;
// A company's name in a sentence ("Acme Supply, Inc.", "ACME TRADING
// LIMITED"), or a name in capitals in a sentence that isn't: who signs, not
// what's agreed.
const COMPANY_NAME = new RegExp(
  String.raw`(?<![\p{L}\d&'’.-])(?:\p{Lu}[\p{L}&'’.-]*,?\s+){1,5}(?:L\.?L\.?C\.?|Inc\.?|INC\.?|Incorporated|INCORPORATED|Corp\.?|CORP\.?|Corporation|CORPORATION|Ltd\.?|LTD\.?|Limited|LIMITED|L\.?L\.?P\.?|L\.P\.|LP|P\.?L\.?L\.?C\.?|P\.C\.|PLC|GmbH|GMBH|S\.A\.|B\.V\.|N\.A\.|Co\.|CO\.|Company|COMPANY)(?=$|[\s,.;:)])`,
  "gu",
);
const CAPS_NAME = /(?<![\p{L}\d&'’.-])\p{Lu}[\p{Lu}&'’.-]+(?:\s+\p{Lu}[\p{Lu}&'’.-]+)+(?![\p{L}\d])/gu;

// What guard 1 needs to know about the document: the words of the parties'
// names (as they're written: "Beta Media" names a party, "media" in a
// sentence doesn't), and its own headings ("the Key Terms" names a section
// of it, not another document). A party's name may also be in a label
// ("Prepared by: Beta Media LLC").
type Names = { parties: Set<string>; headings: string[] };
function namesOf(clauses: Clause[], units: Unit[]): Names {
  const parties = new Set<string>();
  const add = (t: string) => {
    for (const w of t.match(/\p{Lu}[\p{L}'’]*/gu) ?? []) parties.add(w.toLowerCase());
  };
  for (const u of units) if (u.kind === "party" || u.kind === "roleParty") add(u.text);
  for (const c of clauses) for (const m of c.body.matchAll(COMPANY_NAME)) add(m[0]);
  const headings = clauses.map((c) => cleanTitle(c.title)).filter((t) => wordCount(t) <= 5 && OTHER_DOCUMENT.test(t));
  return { parties, headings };
}

// Whether a sentence says no more than that the parties sign: every word,
// less the document's own name, the dates, the parties' names, roles and
// signers' titles, is a word of signing, and there's no number, amount,
// link or other document.
function onlySigning(text: string, names: Names, cutOff = false): boolean {
  if (MONEY.test(text) || URL_OR_EMAIL.test(text)) return false;
  let rest = text.replace(LETTER_IF, " ").replace(RETURN_TO, "$1 ").replace(SIGNERS, " ").replace(SELF_REFERENCE, " ").replace(DEFINED_DATE, " ").replace(DATE_ANYWHERE, " ").replace(BACK_REFERENCE, " ").replace(SIGNING_PHRASES, " ").replace(COMPANY_NAME, " ");
  // "ACCEPTED BY STAFFING FIRM": who accepts, named in a heading.
  const by = ACCEPTED_BY.exec(rest.trim());
  if (by && isNameish(by[1], 4)) rest = rest.replace(by[1], " ");
  for (const h of names.headings) if (rest.includes(h)) rest = rest.split(h).join(" ");
  if (OTHER_DOCUMENT.test(rest)) return false;
  if (/\p{Ll}/u.test(rest)) rest = rest.replace(CAPS_NAME, " ");
  if (/\d/.test(rest)) return false;
  const words = rest.match(/\p{L}+(?:['’]\p{L}+)?/gu) ?? [];
  // A file cut off inside the sentence ("... the parties have ex") ends on
  // the start of a word, which counts as the word of signing it begins.
  const last = words[words.length - 1];
  return words.every((word) => {
    const w = word.replace(/['’]s$/i, "");
    const lower = w.toLowerCase();
    return SIGNING_WORDS.has(lower) || ROLE_WORDS.has(lower) || (/^\p{Lu}/u.test(w) && (names.parties.has(lower) || TITLE_WORD.test(w))) || (cutOff && word === last && [...SIGNING_WORDS].some((s) => s.startsWith(lower)));
  });
}

// The guards. The walks above find a block by what its lines look like;
// these look at each block found for what a signature block never holds,
// and hand it back to the contract. They only shrink a block or drop it,
// never grow one, and each stands on its own. A form signed later keeps
// the whole block (guard 5); sentences, table cells and other people's
// contacts are handed back piece by piece (guards 1, 3 and 4), which may
// split the block; each run left must then show signing (guard 2) and not
// be a list of fields (guard 3). Returns what's left of the block from
// `start` through `end`, as runs of pieces.
// `after`: where the block found before this one ends, or -1.
function precisionGuards(doc: Doc, start: number, end: number, after = -1): [number, number][] {
  if (formSignedLater(doc, start, after)) return [];
  const back = new Set<number>();
  for (let j = start; j <= end; j++) if (keptSentence(doc, j)) back.add(j);
  const value = sentenceValue(doc, start);
  if (value >= 0) back.add(value);
  for (const j of tableCells(doc, start, end)) back.add(j);
  for (const j of othersContacts(doc.units, start, end)) back.add(j);
  for (const j of rolesFieldRow(doc.units, start, end)) back.add(j);
  const runs: [number, number][] = [];
  for (let j = start, from = -1; j <= end + 1; j++) {
    const inside = j <= end && !back.has(j);
    if (inside && from < 0) from = j;
    if (!inside && from >= 0) {
      runs.push([from, j - 1]);
      from = -1;
    }
  }
  return runs.filter(([a, b]) => !fieldList(doc, a, b) && signingEvidence(doc, a, b));
}

// Guard 1: a sentence in a block stays unless it only says the parties
// sign (see onlySigning). Kept at the top of a block it moves the block's
// start below it; inside one it splits the block around it. A line naming
// who signs for a party ("On behalf of ...", "By its ...") holds names, not
// wording, so only a number, an amount or a link makes it a term.
function keptSentence(doc: Doc, j: number): boolean {
  const u = doc.units[j];
  // A witness list's number on the line before its line to sign ("2.
  // ____") says nothing.
  if (u.kind === "prose" && /^\(?\d{1,2}[.)]$/.test(u.text) && doc.units[j + 1]?.kind === "line" && doc.units[j + 1].ci === u.ci) return false;
  if (u.kind === "testimony" || u.kind === "prose") return !onlySigning(u.text, doc.names, j === doc.units.length - 1 && !/[.!?:;"”)\]]$/.test(u.text));
  if (u.kind === "descriptor") return MONEY.test(u.text) || URL_OR_EMAIL.test(u.text) || /\d/.test(u.text);
  return false;
}

// Guard 1, for names: a name on the line under a sentence that runs on
// ("..., with a copy to" / a law firm's name; "Notices go to:" / a company)
// finishes that sentence, so it isn't a party heading the block below.
// Returns that line, or -1.
function sentenceValue(doc: Doc, start: number): number {
  const { units } = doc;
  const above = units[start - 1];
  const u = units[start];
  if (!above || above.ci !== u.ci || above.kind !== "prose" || !PARTIES.has(u.kind)) return -1;
  return /(?::|\s\p{Ll}+)$/u.test(above.text) && wordCount(above.text) >= 3 ? start : -1;
}

// Guard 2: a block holds evidence of signing: a signer's line with a blank
// or a typed /s/ signature, a line to sign with what to write under it, an
// e-signature stamp or a service's trace ("DocuSigned by", a hash), or an
// e-signature certificate right after it. A name typed on a signer's line
// ("By: Jane Doe", "Signature: Jane Doe", "Signed by: Jane Doe") counts
// under a party's name or the sentence that says the parties sign, or with
// the same name on the Name: line under it. On an "<Word> By:" line
// ("Approved By: Jane Doe", "PREPARED BY:", "Received by:") it counts only
// under that sentence: alone it's a record of who did something, or a
// contact. A block cut off right after "IN WITNESS ..." at the end of the
// file counts too: the rest of it was lost.
const SERVICE_HASH = /\b[0-9A-F]{8,}(?:\.{3}|…)?$/;
function signingEvidence(doc: Doc, a: number, b: number): boolean {
  const { units } = doc;
  const run = units.slice(a, b + 1);
  const testimony = run.some((u) => u.kind === "testimony");
  const party = testimony || run.some((u) => u.kind === "party" || u.kind === "roleParty" || u.kind === "sigHeading");
  if (testimony && b === units.length - 1 && run.some((u) => u.sworn)) return true;
  if (certificateAfter(doc, b)) return true;
  return run.some((u, k) => {
    const after = run.slice(k + 1, k + 4);
    if (u.kind === "roleSign" || (u.kind === "sign" && (u.capture === "blank" || u.capture === "typed"))) return true;
    if (u.kind === "sign" && u.capture === "empty") return after.some((n) => n.kind === "line" || n.kind === "person");
    if (u.kind === "line") return after.slice(0, 2).some((n) => ["caption", "person", "signerLine", "date", "sign", "notary", "party"].includes(n.kind));
    if (u.kind === "stamp") return isEsignStamp(u.text) || NAME_STAMP.test(u.text);
    if (u.kind !== "sign") return false;
    if (u.capture === "stamp" && (/^docu\s?signed/i.test(u.text) || [u, ...after].some((n) => SERVICE_HASH.test(n.text) || hasServiceId(n.text) || TYPED.test(n.text)))) return true;
    if (/\S\s+by\s*:/i.test(u.text)) return testimony;
    // "By: Jane Doe / Name: Jane Doe": the signer's name typed on the line.
    return party || after.some((n) => n.kind === "person" && NAME_FIELD.test(n.text) && signedName(n.text) === signedName(u.text));
  });
}

// Whether an e-signature certificate starts the next part after `b`.
function certificateAfter(doc: Doc, b: number): boolean {
  const k = doc.nextPart[b + 1];
  const u = doc.units[k];
  if (!u || (u.kind !== "cert" && !(doc.first.get(u.ci) === k && CERT.test(cleanTitle(doc.clauses[u.ci].title))))) return false;
  return isAuditTrail(doc.units.slice(k, k + 40).map((v) => v.text).join("\n"));
}

// Guard 3: fields the terms list, not a block. Lines that a sentence ending
// in ":" introduces ("Each ticket shall show the following:"), and a list
// of fields inside the terms (text follows it in its clause) with no
// party, no sentence about signing and no Name/Title lines. A sentence
// ending in ":" may be read as a label; one that says more than signing
// (guard 1's test) introduces fields, while "in the presence of:" or
// "Customer Billing Details:" doesn't.
const FIELD: ReadonlySet<Kind> = new Set<Kind>(["sign", "line", "date", "label", "person", "roleSign", "initials", "contact", "caption", "signerLine"]);
function introduces(u: Unit, names: Names): boolean {
  if (!/:$/.test(u.text) || wordCount(u.text) < 3) return false;
  return u.kind === "prose" || (u.kind === "label" && !onlySigning(u.text, names));
}
function fieldList(doc: Doc, a: number, b: number): boolean {
  const { units } = doc;
  for (let j = a - 1; j >= 0 && j >= a - 8 && units[j].ci === units[a].ci; j--) {
    if (introduces(units[j], doc.names)) return !units.slice(a, b + 1).some((u) => ["party", "roleParty", "testimony"].includes(u.kind));
    if (!FIELD.has(units[j].kind)) break;
  }
  const run = units.slice(a, b + 1);
  if (run.some((u) => PARTIES.has(u.kind) || ["testimony", "sigHeading", "closing", "pageNote", "person", "notary", "stamp"].includes(u.kind))) return false;
  const above = units[a - 1];
  if (above?.ci === units[a].ci && ["sigHeading", "party", "roleParty", "testimony"].includes(above.kind)) return false;
  if (doc.first.get(units[a].ci) === a && ["sigHeading", "party", "testimony"].includes(classify(cleanTitle(doc.clauses[units[a].ci].title)).kind)) return false;
  const next = units[b + 1];
  return !!next && next.ci === units[b].ci && next.kind === "prose";
}

// Guard 3, for tables: a cell in a table's row ("Milestone 2 | Due:
// 12/14/2026 | Fee: $14,000 | Accepted by: ____ Date: ____") is the
// table's, however it reads: from a cell that follows a "|" or a tab, the
// fields after it in the row. A tab also lays out a block's two columns
// ("By: ____ <tab> By: ____"), so it marks a table only in a row that has
// a cell no block holds: a row heading, an amount, "Due: 12/14/2026".
// A block laid out as a table ("| ACME INC. | BETA LLC |" over "| By: ____ |
// By: ____ |") is no table of terms: every cell of it, row after row, is a
// block's (a party, a line to sign, a signer's details), none a row
// heading, an amount or a term.
const BLOCK_CELL: ReadonlySet<Kind> = new Set<Kind>(["party", "roleParty", "maybeParty", "sign", "line", "signer", "person", "date", "caption", "signerLine", "roleSign", "artifact", "seal"]);
function blockTable(doc: Doc, j: number): boolean {
  const known = doc.blockTables.get(j);
  if (known !== undefined) return known;
  const { units, clauses } = doc;
  // Cells joined by a border, with no empty line between: one ends a table,
  // as does the heading of the next part ("EXHIBIT A - RATE CARD | Level |
  // Rate |" starts that part's own table).
  const joined = (a: Unit, b: Unit) => {
    const gap = a.ci === b.ci ? clauses[a.ci].body.slice(a.end, b.start) : "\n\n";
    return !/\n\s*\n/.test(gap) && a.kind !== "part" && b.kind !== "part" && (a.text.slice(-1) + gap + b.text[0]).includes("|");
  };
  let a = j;
  while (a > 0 && joined(units[a - 1], units[a])) a--;
  let b = j;
  while (b + 1 < units.length && joined(units[b], units[b + 1])) b++;
  let block = true;
  for (let k = a; k <= b && block; k++) block = BLOCK_CELL.has(units[k].kind);
  // Every cell of the table gets the answer, so a long table is read once.
  for (let k = a; k <= b; k++) doc.blockTables.set(k, block);
  return block;
}
function tableCells(doc: Doc, start: number, end: number): number[] {
  const { units, clauses } = doc;
  const out: number[] = [];
  for (let j = start; j <= end; j++) {
    const prev = units[j - 1];
    if (!prev || prev.ci !== units[j].ci || prev.row !== units[j].row) continue;
    const gap = prev.text.slice(-1) + clauses[prev.ci].body.slice(prev.end, units[j].start);
    const inRow = (u: Unit) => u.ci === prev.ci && u.row === prev.row;
    if (!gap.includes("|") && !(gap.includes("\t") && units.slice(Math.max(0, j - 20), j + 20).some((u) => inRow(u) && (u.kind === "label" || u.kind === "prose")))) continue;
    if (gap.includes("|") && blockTable(doc, j)) continue;
    for (let k = j; k <= end && units[k].row === units[j].row && FIELD.has(units[k].kind); k++) out.push(k);
  }
  return out;
}

// Guard 4: contact details in a block that aren't the signer's. Filled
// lines after a party's own fields were left blank ("By: ____ / Its: ____
// / Date: ____ / Name: Jane Roe / Email: ap@beta.com") belong to someone
// else; so does a party's heading over filled contact fields with nothing
// to sign ("Customer: / Name: Jane Roe / Email: ...").
function othersContacts(units: Unit[], start: number, end: number): number[] {
  const out: number[] = [];
  const filled = (u: Unit) => (u.kind === "person" || u.kind === "contact" || u.kind === "signerLine") && !u.blank && !ONLY_BLANKS.test(u.text.replace(/^[^:]*:/, ""));
  let part = start;
  for (let j = start; j <= end + 1; j++) {
    if (j <= end && !(PARTIES.has(units[j].kind) && j > part)) continue;
    // One party's part: [part, j - 1].
    const mine = units.slice(part, j);
    const signs = mine.findIndex((u) => ["sign", "line", "signer", "stamp", "roleSign"].includes(u.kind));
    if (signs < 0) {
      if (PARTIES.has(mine[0].kind) && mine.length > 1 && mine.slice(1).every(filled)) for (let k = part; k < j; k++) out.push(k);
    } else if (["line", "roleSign"].includes(mine[signs].kind) || mine[signs].capture === "blank" || mine[signs].capture === "empty") {
      // Past the line to sign and the blank fields under it ("Its: ____",
      // "Date: ____", or the printed captions), the first filled line.
      let k = part + signs + 1;
      let identity = false;
      while (k < j && (units[k].kind === "caption" || units[k].kind === "line" || ((units[k].kind === "person" || units[k].kind === "date") && units[k].blank))) {
        if (units[k].kind === "person") identity = true;
        k++;
      }
      // Only past a blank Name or Title: a name typed after a blank date
      // ("Signature: ____ Date: ____ / Name: Jane Doe") is the signer's. And
      // not a name over the next line to sign, which heads that signer.
      let m = k;
      while (m < j && filled(units[m])) m++;
      if (identity && m > k && !units.slice(m, j).some((u) => ["sign", "line", "stamp", "roleSign"].includes(u.kind))) for (let n = k; n < m; n++) out.push(n);
    }
    part = j;
  }
  return out;
}

// Guard 4 too: a role's own name field at the end of a block ("Sales
// Representative Name: ____", which the cutter reads as a title over a
// Name: line), when a field the block doesn't take goes on beside it on its
// row ("... HIS Registration No.: ____"), names someone who doesn't sign
// here: the row is a list of details the contract asks for, so it stays
// whole. Returns the pieces to hand back, from the role through the block's
// end.
function rolesFieldRow(units: Unit[], start: number, end: number): number[] {
  const next = units[end + 1];
  if (!next || next.ci !== units[end].ci || next.row !== units[end].row || next.kind !== "label") return [];
  let j = end;
  while (j > start && units[j].row === next.row && (units[j].kind === "person" || units[j].kind === "contact")) j--;
  const name = units[j + 1];
  const role = units[j];
  if (j === end || !NAME_FIELD.test(name.text) || role.kind !== "signerLine" || role.detail !== "title" || role.row !== name.row) return [];
  const out: number[] = [];
  for (let k = j; k <= end; k++) out.push(k);
  return out;
}

// Guard 5: a part that holds a form is signed when the form is used, not
// with the contract, so its lines to sign are part of the contract. A part
// holds a form when its heading names one ("Form of Joinder", "Change Order
// Form", a certificate, an acknowledgment, a waiver or release, a receipt,
// a request), when the terms call it one ("in the form of Appendix C"),
// when it speaks as the one who signs it ("I have read ...", "the
// undersigned ..."), or, for an exhibit, schedule or the like, when it has
// fields to fill in ("[Client Name]", blanks) before the block.
const FORM = /\bform of\s+\p{L}|\bcertificat\w*|\backnowledge?ments?\b|\bwaivers?\b|\breleases?\b|\breceipts?\b|\bdeclarations?\b|\baffidavits?\b|\brequests?\b/iu;
const FORM_REF = /\bform\b[^.;]{0,40}?\b(exhibit|schedule|annex|appendix|attachment)\s+([A-Z]{1,2}|\d{1,3})(?![\p{L}\d])/giu;
const PART_NAME = /^(exhibit|schedule|annex|appendix|attachment|addendum|rider)\s+([A-Z]{1,2}|\d{1,3})(?![\p{L}\d])/iu;
const FORM_VOICE = /\bI (?:have|am|agree|acknowledge|confirm|understand|will|certify|declare|accept|consent|hereby|received)\b|\bthe undersigned\b/;
const PLACEHOLDER = /\[[^\]]{1,40}\]|_{3,}|\.{5,}/;
// "Appendix C" and "APPENDIX C - CHANGE ORDER" both give "appendix c".
function partName(t: string): string {
  const m = PART_NAME.exec(t);
  return m ? `${m[1]} ${m[2]}`.toLowerCase() : "";
}
function formParts(clauses: Clause[]): Set<string> {
  const names = new Set<string>();
  for (const c of clauses) {
    for (const m of c.body.matchAll(FORM_REF)) {
      if (isPartLetter(m[2], c.body.slice((m.index ?? 0) + m[0].length))) names.add(`${m[1]} ${m[2]}`.toLowerCase());
    }
  }
  return names;
}
// The heading of the part that starts at `p`, and the piece it starts on:
// cut in two on its line ("EXHIBIT D FORM OF" and "CHANGE ORDER"), finished
// on the line under it ("EXHIBIT C" over "FORM OF ACCEPTANCE CERTIFICATE"),
// or made the clause's title by the splitter.
function partHeading(doc: Doc, p: number): { a: number; heading: string[] } {
  const { units, clauses, first } = doc;
  const u = units[p];
  let a = p;
  while (a > 0 && units[a - 1].kind === "part" && units[a - 1].ci === u.ci && units[a - 1].row === u.row) a--;
  const lead = (t: string) => t.split(/\s+/).slice(0, 12).join(" ");
  const heading = units.slice(a, p + 1).filter((v) => v.kind === "part" || wordCount(v.text) <= 12).map((v) => lead(v.text));
  const next = units[p + 1];
  if (next && next.ci === u.ci && wordCount(next.text) <= 12) heading.push(next.text);
  const title = cleanTitle(clauses[u.ci].title);
  if (first.get(u.ci) === a && (u.kind !== "part" || isPartHeading(title) || FORM_HEADING.test(title))) heading.unshift(title);
  return { a, heading };
}
// A sentence in the voice of the one who signs it, in capitals too ("I
// HEREBY CANCEL THIS TRANSACTION.").
const FORM_VOICE_CAPS = new RegExp(FORM_VOICE.source, "i");
function speaksAsSigner(t: string): boolean {
  return FORM_VOICE.test(t) || (isAllCaps(t) && FORM_VOICE_CAPS.test(t));
}
// `after`: where the block found before this one ends, or -1.
function formSignedLater(doc: Doc, start: number, after = -1): boolean {
  const { units } = doc;
  let p = doc.part[start];
  if (p < 0) return false;
  let { a, heading } = partHeading(doc, p);
  // A heading that names no exhibit or form ("TERMS AND CONDITIONS" inside
  // an order form, or a field still read as a heading) may sit inside an
  // exhibit: the exhibit's own heading above it, back to the block before,
  // names the part too ("EXHIBIT A - ORDER FORM").
  const named = (h: string[]) => h.some((t) => PART_NAME.test(t) || FORM.test(t) || doc.formParts.has(partName(t)));
  while (!named(heading) && a > 0 && doc.part[a - 1] > after) {
    p = doc.part[a - 1];
    const outer = partHeading(doc, p);
    a = outer.a;
    heading = [...outer.heading, ...heading];
  }
  if (FORM.test(heading.join(" ")) || heading.some((t) => doc.formParts.has(partName(t)))) return true;
  // The rest only for a part after the contract's text.
  if (doc.text[p] === 0) return false;
  for (let j = p; j < start; j++) if (units[j].kind === "prose" && speaksAsSigner(units[j].text)) return true;
  if (!heading.some((t) => PART_NAME.test(t))) return false;
  if (heading.some((t) => /\bform\b/i.test(t))) return true;
  for (let j = a; j < start; j++) if (!SIGNING.has(units[j].kind) && PLACEHOLDER.test(units[j].text.replace(PART_NAME, ""))) return true;
  return false;
}

function mergeRanges(ranges: SignatureRange[]): SignatureRange[] {
  const sorted = [...ranges].sort((a, b) => a.clause - b.clause || a.start - b.start);
  const out: SignatureRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.clause === r.clause && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

// Marks the signature block in clauses already cut into text and fields, so
// the review screen can show it and leave it out on save. The segments of a
// clause put back together are its body, which is what the ranges count in.
export function markSignatureBlocks(clauses: ReviewClause[], ranges: SignatureRange[]): ReviewClause[] {
  return clauses.map((c, ci) => {
    const mine = ranges.filter((r) => r.clause === ci);
    if (!mine.length) return c;
    // A clause with no text in a block: one empty piece, marked, so the
    // clause goes with its title.
    if (c.segments.every((s) => s.kind === "text" && !s.text)) return { ...c, segments: [{ kind: "text", text: "", signature: true }] };
    const inside = (at: number) => mine.some((r) => at >= r.start && at < r.end);
    const segments: Segment[] = [];
    let pos = 0;
    for (const s of c.segments) {
      if (s.kind === "field") {
        segments.push(inside(pos) ? { ...s, signature: true } : s);
        pos += s.original === null ? s.key.length + 2 : s.original.length;
        continue;
      }
      // Text is cut where the block starts and ends.
      const cuts = new Set([0, s.text.length]);
      for (const r of mine) for (const at of [r.start, r.end]) if (at > pos && at < pos + s.text.length) cuts.add(at - pos);
      const points = [...cuts].sort((a, b) => a - b);
      for (let k = 0; k < points.length - 1; k++) {
        const text = s.text.slice(points[k], points[k + 1]);
        segments.push(inside(pos + points[k]) ? { kind: "text", text, signature: true } : { kind: "text", text });
      }
      pos += s.text.length;
    }
    return { ...c, segments };
  });
}
