// What SealMe already knows about the person a call was with (the lead, and
// the client on file), matched to the fields a template asks for by what
// they're called. An uploaded contract often has {clientSignerName},
// {contactTitle} or {clientAddress}, which nobody says out loud on a call;
// left empty they'd hold up a contract that's otherwise ready to send.

export type KnownDetails = { name?: string | null; title?: string | null; email?: string | null; phone?: string | null; address?: string | null };

// Keys compared without case, underscores or dashes: {clientSignerName},
// {client_signer_name} and {CLIENT-SIGNER-NAME} are the same field. A
// person's details only, never the company's: clientName is the party the
// contract is with and is filled on its own.
const PERSON = "(?:signer|signatory|signee|contact|representative|rep|primarycontact|authorizedsigner|authorisedsigner|pointofcontact|poc)";
const KINDS: [RegExp, keyof KnownDetails][] = [
  [new RegExp(`^(?:client${PERSON}|${PERSON})(?:name|fullname)?$`), "name"],
  [new RegExp(`^(?:client${PERSON}?|${PERSON})(?:title|jobtitle|position|role)$`), "title"],
  [new RegExp(`^(?:client(?:${PERSON}|notice|notices)?|${PERSON}|notice|notices)(?:email|emailaddress)$`), "email"],
  [new RegExp(`^(?:client${PERSON}?|${PERSON})(?:phone|phonenumber|telephone|mobile)$`), "phone"],
  [/^(?:client|clientbilling|billing|clientmailing|mailing)address$/, "address"],
];

export function knownDetailFor(fieldKey: string): keyof KnownDetails | null {
  const key = fieldKey.replace(/[_-]/g, "").toLowerCase();
  return KINDS.find(([re]) => re.test(key))?.[1] ?? null;
}

// Fills the empty fields SealMe has a value for, as confirmed (they came
// from the record, not from the model's reading of the call). A field the
// call already filled keeps what was said.
export function fillKnownDetails<T extends { fieldKey: string; value: string | null; status: string; confidence: number | null; sourceQuote: string | null }>(rows: T[], known: KnownDetails): T[] {
  return rows.map((row) => {
    if (row.value?.trim()) return row;
    const kind = knownDetailFor(row.fieldKey);
    const value = kind ? known[kind]?.trim() : null;
    return value ? { ...row, value, status: "confirmed", confidence: null, sourceQuote: null } : row;
  });
}
