// One description of the public API, used by the /developers page and by
// /api/v1/openapi.json, so the two can't drift apart. Keep it in step with
// the routes under src/app/api/v1 and the payloads in src/lib/webhooks.ts.

export type DocField = { name: string; type: string; required?: boolean; description: string };
export type DocEndpoint = {
  id: string;
  group: "Deals" | "Clients" | "Contracts" | "Templates" | "Leads" | "Calls" | "Tasks";
  method: "GET" | "POST" | "PATCH";
  path: string;
  summary: string;
  description: string;
  write?: boolean;
  query?: DocField[];
  body?: DocField[];
  exampleBody?: Record<string, unknown>;
  responses: { status: number; description: string; schema?: SchemaName; list?: boolean; example?: unknown }[];
};
export type SchemaName = "Deal" | "DealDetail" | "Client" | "Contract" | "Template" | "Lead" | "Call" | "Task";

const iso = "2026-10-04T14:32:10.000Z";

export const EXAMPLES: Record<SchemaName, Record<string, unknown>> = {
  Deal: {
    id: "cmdeal8f2k0001",
    status: "ready",
    source: "api",
    kind: "contract",
    leadId: "cmlead5e6f0005",
    service: "Brand identity refresh",
    fee: "$8,500",
    value: 8500,
    currency: "USD",
    client: { id: "cmcli4h1x0002", name: "Avery Chen", company: "Northwind Studio", email: "avery.chen@example.com" },
    owner: { name: "Dana Lopez", email: "dana@yourcompany.com" },
    url: "https://app.sealme.net/deals/cmdeal8f2k0001",
    createdAt: iso,
    updatedAt: iso,
  },
  DealDetail: {
    id: "cmdeal8f2k0001",
    status: "ready",
    source: "api",
    service: "Brand identity refresh",
    fee: "$8,500",
    value: 8500,
    currency: "USD",
    client: { id: "cmcli4h1x0002", name: "Avery Chen", company: "Northwind Studio", email: "avery.chen@example.com" },
    owner: { name: "Dana Lopez", email: "dana@yourcompany.com" },
    url: "https://app.sealme.net/deals/cmdeal8f2k0001",
    createdAt: iso,
    updatedAt: iso,
    summary: "Avery wants a full brand refresh before the spring launch. Agreed on $8,500, half upfront.",
    terms: [
      { key: "clientName", label: "Client", value: "Avery Chen", status: "extracted" },
      { key: "service", label: "Service", value: "Brand identity refresh", status: "extracted" },
      { key: "fee", label: "Fee", value: "$8,500", status: "extracted" },
      { key: "startDate", label: "Start date", value: null, status: "missing" },
    ],
    contract: { id: "cmcon2b9q0003", status: "sent", sentAt: iso, signedAt: null, url: "https://app.sealme.net/deals/cmdeal8f2k0001/contract" },
  },
  Client: { id: "cmcli4h1x0002", name: "Avery Chen", company: "Northwind Studio", email: "avery.chen@example.com", billingAddress: null, url: "https://app.sealme.net/clients/cmcli4h1x0002", createdAt: iso },
  Contract: {
    id: "cmcon2b9q0003",
    status: "signed",
    dealId: "cmdeal8f2k0001",
    client: { id: "cmcli4h1x0002", name: "Avery Chen", company: "Northwind Studio" },
    sentAt: iso,
    viewedAt: iso,
    signedAt: iso,
    expiresAt: null,
    signerName: "Avery Chen",
    renewalDate: "2027-10-04T00:00:00.000Z",
    autoRenews: false,
    url: "https://app.sealme.net/deals/cmdeal8f2k0001/contract",
  },
  Template: { id: "cmtpl7c3d0004", name: "Service Agreement", description: "General-purpose agreement for project work.", kind: "contract", locked: false },
  Lead: {
    id: "cmlead5e6f0005",
    externalId: "hs-48213",
    campaign: "Acme Freight Q4",
    name: "Sam Rivera",
    company: "Acme Freight",
    title: "Head of Revenue Operations",
    email: "sam.rivera@example.com",
    phone: "+12025550161",
    domain: "acmefreight.com",
    stage: "contacted",
    pipelineStage: "new",
    isClient: false,
    interest: "warm",
    isDecisionMaker: true,
    painPoints: "Contracts take a week to go out after a call.",
    objections: null,
    nextStep: "Demo with the RevOps team",
    nextStepAt: "2026-10-20",
    summary: null,
    notes: null,
    source: "api",
    owner: { name: "Dana Lopez", email: "dana@yourcompany.com" },
    lastContactedAt: iso,
    convertedDealId: null,
    convertedAt: null,
    url: "https://app.sealme.net/leads/cmlead5e6f0005",
    createdAt: iso,
    updatedAt: iso,
  },
  Call: {
    id: "cmcall3d4e0006",
    externalId: "pb-77120",
    leadId: "cmlead5e6f0005",
    leadExternalId: "hs-48213",
    leadName: "Sam Rivera",
    campaign: "Acme Freight Q4",
    dealId: null,
    status: "processed",
    kind: "cold",
    outcome: "meeting_booked",
    connected: true,
    skipReason: null,
    summary: "Sam runs RevOps for 40 reps. Contracts take a week after a call. Agreed to a demo Tuesday at 2pm.",
    notes: "- Sam runs RevOps for 40 reps at Acme Freight\n- Contracts go out about a week after a verbal yes\n- Demo with their RevOps team on Tuesday at 2pm; we send the invite",
    source: "api",
    toNumber: "+12025550161",
    recorded: false,
    durationSec: 312,
    rep: { name: "Dana Lopez", email: "dana@yourcompany.com" },
    url: "https://app.sealme.net/leads/cmlead5e6f0005",
    startedAt: iso,
    endedAt: iso,
    processedAt: iso,
    updatedAt: iso,
  },
  Task: {
    id: "cmtask7g8h0008",
    externalId: "aih-mtg-5521",
    type: "sales_call",
    status: "open",
    leadId: "cmlead5e6f0005",
    leadExternalId: "hs-48213",
    leadName: "Sam Rivera",
    campaign: "Acme Freight Q4",
    dealId: null,
    assignee: { name: "Dana Lopez", email: "dana@yourcompany.com" },
    date: "2026-10-20",
    time: "14:00",
    timeZone: "America/New_York",
    priority: "normal",
    note: "Demo with the RevOps team",
    completedAt: null,
    url: "https://app.sealme.net/leads/cmlead5e6f0005",
    createdAt: iso,
    updatedAt: iso,
  },
};

export const SCHEMA_FIELDS: Record<SchemaName, DocField[]> = {
  Deal: [
    { name: "id", type: "string", description: "Deal id." },
    { name: "status", type: "string", description: "processing, missing_info, extraction_failed, ready, pending_approval, changes_requested, sent or signed." },
    { name: "source", type: "string", description: "Where the deal came from: zoom, meet, local, upload, phone, manual, renewal, import, proposal (a contract made from a proposal) or api." },
    { name: "kind", type: "string", description: "proposal or contract. GET /deals lists contracts unless you send kind." },
    { name: "leadId", type: "string | null", description: "The lead it's for (GET /leads/{id}). Every proposal and contract is on a lead." },
    { name: "service", type: "string", description: "What's being sold, as agreed on the call." },
    { name: "fee", type: "string", description: "The agreed fee, as written (e.g. \"$4,000 a month\")." },
    { name: "value", type: "number | null", description: "The fee as a number (\"$4,000 a month\" is 4000; \"$8.5k\" is 8500). Null when the fee has no number in it." },
    { name: "currency", type: "string | null", description: "ISO code read from the fee (\"$\" is USD, \"€\" EUR...). Null when the fee doesn't say." },
    { name: "client", type: "object", description: "{ id, name, company, email }" },
    { name: "owner", type: "object | null", description: "{ name, email } of the teammate who owns the deal." },
    { name: "url", type: "string", description: "Where the deal opens in SealMe." },
    { name: "createdAt", type: "string", description: "ISO 8601." },
    { name: "updatedAt", type: "string", description: "ISO 8601." },
  ],
  DealDetail: [
    { name: "…", type: "", description: "Everything in Deal, plus:" },
    { name: "summary", type: "string | null", description: "A short summary of the call." },
    { name: "terms", type: "array", description: "The agreed terms: { key, label, value, status }, status being extracted, confirmed, user_edited or missing." },
    { name: "contract", type: "object | null", description: "{ id, status, sentAt, signedAt, url } once a contract exists." },
  ],
  Client: [
    { name: "id", type: "string", description: "Client id." },
    { name: "name", type: "string", description: "Contact's name." },
    { name: "company", type: "string", description: "Company name." },
    { name: "email", type: "string | null", description: "Where contracts are sent." },
    { name: "billingAddress", type: "string | null", description: "Billing address." },
    { name: "url", type: "string", description: "Where the client opens in SealMe." },
    { name: "createdAt", type: "string", description: "ISO 8601." },
  ],
  Contract: [
    { name: "id", type: "string", description: "Contract id." },
    { name: "status", type: "string", description: "draft, pending_approval, changes_requested, sent, partially_signed, signed, expired or not_signed (a rep marked it as not signed)." },
    { name: "dealId", type: "string", description: "The deal it belongs to." },
    { name: "client", type: "object", description: "{ id, name, company }" },
    { name: "sentAt / viewedAt / signedAt / expiresAt", type: "string | null", description: "ISO 8601 timestamps." },
    { name: "signerName", type: "string | null", description: "Who signed for the client." },
    { name: "renewalDate", type: "string | null", description: "When the agreement renews, read from the signed contract." },
    { name: "autoRenews", type: "boolean | null", description: "Whether it renews on its own." },
    { name: "url", type: "string", description: "Where the contract opens in SealMe." },
  ],
  Template: [
    { name: "id", type: "string", description: "Template id, for POST /deals." },
    { name: "name", type: "string", description: "Template name." },
    { name: "description", type: "string", description: "What it's for." },
    { name: "kind", type: "string", description: "proposal or contract: which kind of deal it makes. Set when the template is made; it doesn't change." },
    { name: "locked", type: "boolean", description: "Locked after legal review; can't be edited without approval." },
  ],
  Lead: [
    { name: "id", type: "string", description: "Lead id." },
    { name: "externalId", type: "string | null", description: "Your own id for the lead, if you sent one." },
    { name: "campaign", type: "string | null", description: "The campaign it's in, such as the client an agency is calling for." },
    { name: "name, company, title, email, phone, domain", type: "string | null", description: "Who the person is. Phone is E.164 when it parses." },
    { name: "stage", type: "string", description: "new, contacted, interested, meeting, converted or lost: how far the calls got. A client is always converted: a stage sent for one is ignored." },
    {
      name: "pipelineStage",
      type: "string",
      description:
        "Where the lead is on the Leads list in SealMe: new, proposal_sent, contract_sent, client, lost, not_now (set aside for later) or not_signed (a contract ran out or was marked not signed). Its proposals and contracts move it. lost, not_now and not_signed are on Inactive. You can't set it; stage lost sets it to lost.",
    },
    { name: "isClient", type: "boolean", description: "true once a contract on the lead is signed: it's on Clients, with pipelineStage client and stage converted." },
    { name: "interest", type: "string | null", description: "cold, warm or hot." },
    { name: "isDecisionMaker", type: "boolean | null", description: "From the calls so far." },
    { name: "painPoints, objections, summary, notes", type: "string | null", description: "Filled in from processed calls, or by hand." },
    { name: "nextStep / nextStepAt", type: "string | null", description: "What's next, and on which day (YYYY-MM-DD)." },
    { name: "source", type: "string", description: "manual, paste, csv, xlsx, hubspot, salesforce, call or api." },
    { name: "owner", type: "object | null", description: "{ name, email } of the rep it's assigned to." },
    { name: "convertedDealId / convertedAt", type: "string | null", description: "Set once the lead became a client: the deal whose contract was signed, and when. Setting stage to converted yourself sets convertedAt only." },
    { name: "url", type: "string", description: "Where the lead opens in SealMe." },
    { name: "lastContactedAt, createdAt, updatedAt", type: "string", description: "ISO 8601." },
  ],
  Call: [
    { name: "id", type: "string", description: "Call id." },
    { name: "externalId", type: "string | null", description: "Your dialer's id for the call, if you logged it with one." },
    { name: "leadId / leadExternalId / leadName / campaign", type: "string | null", description: "The lead it was with." },
    { name: "dealId", type: "string | null", description: "The deal a sales call started." },
    { name: "status", type: "string", description: "processing, processed, skipped (set aside: nobody picked up, too short, not recorded), failed, pending, recording or discarded." },
    { name: "kind", type: "string | null", description: "cold or sales." },
    { name: "outcome", type: "string | null", description: "meeting_booked, interested, follow_up, not_interested, wrong_person, voicemail or no_answer." },
    { name: "connected", type: "boolean", description: "Whether they actually talked." },
    { name: "skipReason", type: "string | null", description: "Why a skipped call was set aside, e.g. no_pickup or too_short." },
    { name: "summary", type: "string | null", description: "A short summary of the call, or the one you logged." },
    { name: "notes", type: "string | null", description: "SealMe's write-up of the call, one \"- \" line per point: what was discussed, what they need, next steps." },
    { name: "source", type: "string", description: "phone (through SealMe), paste, desktop, or api (logged by you)." },
    { name: "toNumber", type: "string | null", description: "The number called." },
    { name: "recorded", type: "boolean", description: "Whether SealMe recorded it." },
    { name: "durationSec", type: "number | null", description: "Length in seconds." },
    { name: "rep", type: "object | null", description: "{ name, email } of who made it." },
    { name: "transcript", type: "string | null", description: "Only from GET /calls/{id}." },
    { name: "url", type: "string | null", description: "The lead in SealMe, where the call is in its history." },
    { name: "startedAt, endedAt, processedAt, updatedAt", type: "string | null", description: "ISO 8601." },
  ],
  Task: [
    { name: "id", type: "string", description: "Task id." },
    { name: "externalId", type: "string | null", description: "Your id for a meeting you booked through the API." },
    { name: "type", type: "string", description: "cold_call, sales_call (a booked meeting), follow_up or other." },
    { name: "status", type: "string", description: "open, done or skipped." },
    { name: "leadId / leadExternalId / leadName / campaign", type: "string | null", description: "The lead it's about." },
    { name: "dealId", type: "string | null", description: "The deal it's about, for tasks on a deal." },
    { name: "assignee", type: "object | null", description: "{ name, email } of the rep it's for." },
    { name: "date / time / timeZone", type: "string | null", description: "The day (YYYY-MM-DD) and optional time (HH:mm) in that IANA time zone." },
    { name: "priority", type: "string", description: "low, normal, high or urgent." },
    { name: "note", type: "string | null", description: "What it's about." },
    { name: "completedAt", type: "string | null", description: "When it was done or skipped." },
    { name: "url", type: "string | null", description: "The lead (or deal) in SealMe." },
    { name: "createdAt, updatedAt", type: "string", description: "ISO 8601." },
  ],
};

const cursorParams: DocField[] = [{ name: "cursor", type: "string", description: "nextCursor from the previous page. Pages hold 50 items." }];
const updatedSince: DocField = { name: "updatedSince", type: "string", description: "ISO 8601. Only what changed at or after this time." };
const leadBody: DocField[] = [
  { name: "name", type: "string", required: true, description: "The person's name. Required on create." },
  { name: "campaign", type: "string", description: "The campaign it's in, up to 100 characters. An agency uses it for the client it's calling for; every event about the lead carries it." },
  { name: "externalId", type: "string", description: "Your own id for the lead (your CRM's or dialer's), up to 200 characters. Unique in the workspace: a second lead with the same one answers 409. Comes back on the lead and in every webhook about it." },
  { name: "company", type: "string", description: "Company." },
  { name: "title", type: "string", description: "Job title." },
  { name: "email", type: "string", description: "Email. A lead with the same email or phone already here answers 409." },
  { name: "phone", type: "string", description: "Any format; stored as E.164 when it parses." },
  { name: "domain", type: "string", description: "Company website or domain." },
  { name: "stage", type: "string", description: "new, contacted, interested, meeting, converted or lost. lost also puts the lead on Inactive (pipelineStage lost). converted is recorded, but only a signed contract makes a lead a client." },
  { name: "interest", type: "string", description: "cold, warm or hot." },
  { name: "nextStep", type: "string", description: "What's next." },
  { name: "nextStepAt", type: "string", description: "YYYY-MM-DD." },
  { name: "notes", type: "string", description: "Free text, up to 4,000 characters." },
  { name: "ownerEmail", type: "string", description: "Email of an active teammate to assign it to; null unassigns." },
];

export const ENDPOINTS: DocEndpoint[] = [
  {
    id: "list-deals",
    group: "Deals",
    method: "GET",
    path: "/deals",
    summary: "List deals",
    description: "Every contract deal in the workspace, oldest first. Proposals are left out unless you ask for them with kind. Deals in the trash aren't included.",
    query: [
      { name: "status", type: "string", description: "Only deals with this status." },
      { name: "kind", type: "string", description: "contract (the default), proposal, or all for both." },
      updatedSince,
      ...cursorParams,
    ],
    responses: [{ status: 200, description: "A page of deals.", schema: "Deal", list: true }],
  },
  {
    id: "get-deal",
    group: "Deals",
    method: "GET",
    path: "/deals/{id}",
    summary: "Get a deal",
    description: "One deal with its summary, the agreed terms and its contract.",
    responses: [{ status: 200, description: "The deal.", schema: "DealDetail" }, { status: 404, description: "No such deal in this workspace." }],
  },
  {
    id: "create-deal",
    group: "Deals",
    method: "POST",
    path: "/deals",
    summary: "Start a deal",
    description:
      "Two ways. Send a call transcript and a template, and SealMe reads the agreed terms the same way it does for a call: the answer is 202 with the deal \"processing\", and it becomes \"ready\" or \"missing_info\" (or \"extraction_failed\") a few seconds later, when deal.created fires. Or send terms you already know (service and fee) for a deal that's \"ready\" right away (201).",
    write: true,
    body: [
      { name: "transcript", type: "string", description: "The call, as text, up to 400,000 characters. Needs templateId." },
      { name: "templateId", type: "string", description: "Which template's terms to look for (GET /templates). A deal made here is a contract, so use one with kind contract. Required with a transcript." },
      { name: "client", type: "object", description: "{ name, company, email }. With a transcript, anything left out is filled in from the call." },
      { name: "clientId", type: "string", description: "An existing client instead of client." },
      { name: "service", type: "string", description: "Without a transcript: what's being sold." },
      { name: "fee", type: "string", description: "Without a transcript: the fee, as written." },
      { name: "ownerEmail", type: "string", description: "Email of the teammate who owns the deal." },
      { name: "leadId", type: "string", description: "The lead it's for. Or send leadExternalId. Left out, it goes on the lead the client's other deals are on, or one with the client's email, or a new lead." },
      { name: "leadExternalId", type: "string", description: "Your id for the lead, instead of leadId." },
    ],
    exampleBody: { transcript: "Rep: … The total is $18,000, half upfront …", templateId: "cmtpl7c3d0004", client: { company: "Northwind Studio" }, ownerEmail: "dana@yourcompany.com" },
    responses: [
      { status: 202, description: "Transcript accepted; the deal is processing.", schema: "Deal", example: { ...EXAMPLES.Deal, status: "processing", service: "", fee: "", client: { id: "cmcli4h1x0002", name: "New client", company: "Northwind Studio", email: null } } },
      { status: 201, description: "Deal created from known terms.", schema: "Deal" },
      { status: 400, description: "Something in the body is missing or wrong; the error says what." },
      { status: 413, description: "The transcript is too long." },
    ],
  },
  {
    id: "list-clients",
    group: "Clients",
    method: "GET",
    path: "/clients",
    summary: "List clients",
    description: "Every client in the workspace, oldest first.",
    query: cursorParams,
    responses: [{ status: 200, description: "A page of clients.", schema: "Client", list: true }],
  },
  {
    id: "get-client",
    group: "Clients",
    method: "GET",
    path: "/clients/{id}",
    summary: "Get a client",
    description: "One client.",
    responses: [{ status: 200, description: "The client.", schema: "Client" }, { status: 404, description: "No such client in this workspace." }],
  },
  {
    id: "create-client",
    group: "Clients",
    method: "POST",
    path: "/clients",
    summary: "Add a client",
    description: "Adds a client, for example from your CRM, so a deal can be started for them.",
    write: true,
    body: [
      { name: "name", type: "string", required: true, description: "Contact's name." },
      { name: "company", type: "string", description: "Company; the name is used when left out." },
      { name: "email", type: "string", description: "Where contracts go." },
      { name: "billingAddress", type: "string", description: "Billing address." },
    ],
    exampleBody: { name: "Avery Chen", company: "Northwind Studio", email: "avery.chen@example.com" },
    responses: [{ status: 201, description: "The new client.", schema: "Client" }, { status: 400, description: "name is missing." }],
  },
  {
    id: "get-contract",
    group: "Contracts",
    method: "GET",
    path: "/contracts/{id}",
    summary: "Get a contract",
    description: "One contract: where it is in signing, and the renewal terms read from it once signed.",
    responses: [{ status: 200, description: "The contract.", schema: "Contract" }, { status: 404, description: "No such contract in this workspace." }],
  },
  {
    id: "list-templates",
    group: "Templates",
    method: "GET",
    path: "/templates",
    summary: "List templates",
    description: "The proposal and contract templates a deal can use.",
    responses: [{ status: 200, description: "All templates (not paged).", schema: "Template", list: true }],
  },
  {
    id: "list-leads",
    group: "Leads",
    method: "GET",
    path: "/leads",
    summary: "List leads",
    description: "Every lead in the workspace, oldest first: the people your reps call, and the clients they became.",
    query: [
      { name: "stage", type: "string", description: "new, contacted, interested, meeting, converted or lost." },
      { name: "pipelineStage", type: "string", description: "new, proposal_sent, contract_sent, client, lost, not_now or not_signed: where the lead is on the Leads list." },
      { name: "ownerEmail", type: "string", description: "Only one rep's leads." },
      { name: "externalId", type: "string", description: "The lead with this externalId (your own id)." },
      { name: "campaign", type: "string", description: "Only one campaign's leads." },
      updatedSince,
      ...cursorParams,
    ],
    responses: [{ status: 200, description: "A page of leads.", schema: "Lead", list: true }],
  },
  {
    id: "get-lead",
    group: "Leads",
    method: "GET",
    path: "/leads/{id}",
    summary: "Get a lead",
    description: "One lead.",
    responses: [{ status: 200, description: "The lead.", schema: "Lead" }, { status: 404, description: "No such lead in this workspace." }],
  },
  {
    id: "create-lead",
    group: "Leads",
    method: "POST",
    path: "/leads",
    summary: "Add a lead",
    description: "Adds a lead. If one with the same externalId, email or phone is already here the answer is 409 with its id, so a sync can update it instead. Fires lead.created.",
    write: true,
    body: leadBody,
    exampleBody: { name: "Sam Rivera", company: "Acme Freight", email: "sam.rivera@example.com", phone: "+1 202 555 0161", ownerEmail: "dana@yourcompany.com" },
    responses: [
      { status: 201, description: "The new lead.", schema: "Lead" },
      { status: 409, description: "Already here.", example: { error: "A lead with this externalId already exists", existingId: "cmlead5e6f0005" } },
      { status: 400, description: "Something in the body is wrong; the error says what." },
    ],
  },
  {
    id: "update-lead",
    group: "Leads",
    method: "PATCH",
    path: "/leads/{id}",
    summary: "Update a lead",
    description:
      "Changes only the fields you send; null clears one. Fires lead.updated when something changed. The stage names still move the lead on the Leads list (pipelineStage): lost takes it off Active, onto Inactive. new, contacted, interested or meeting bring a lead that's lost, not now or not signed back to Active, when the stage changes; sending the stage it already has leaves it where it is. converted is recorded with when, but a lead becomes a client only when a contract on it is signed. A client stays converted: any other stage sent for one is ignored, and the other fields you sent still change.",
    write: true,
    body: leadBody.map((f) => ({ ...f, required: false })),
    exampleBody: { stage: "meeting", nextStep: "Demo with the RevOps team", nextStepAt: "2026-10-20" },
    responses: [
      { status: 200, description: "The updated lead.", schema: "Lead" },
      { status: 404, description: "No such lead in this workspace." },
      { status: 409, description: "Another lead already has that externalId.", example: { error: "Another lead already has this externalId", existingId: "cmlead9a1b0007" } },
    ],
  },
  {
    id: "list-calls",
    group: "Calls",
    method: "GET",
    path: "/calls",
    summary: "List calls",
    description: "Every call, logged by you or made through SealMe, oldest first. For a nightly sync, ask for what changed since the last run with updatedSince.",
    query: [
      { name: "leadId", type: "string", description: "Only one lead's calls." },
      { name: "leadExternalId", type: "string", description: "The same, by your id for the lead." },
      { name: "externalId", type: "string", description: "The call you logged with this id." },
      { name: "status", type: "string", description: "processing, processed, skipped, failed, pending, recording or discarded." },
      updatedSince,
      ...cursorParams,
    ],
    responses: [{ status: 200, description: "A page of calls (without transcripts).", schema: "Call", list: true }],
  },
  {
    id: "get-call",
    group: "Calls",
    method: "GET",
    path: "/calls/{id}",
    summary: "Get a call",
    description: "One call, with its transcript.",
    responses: [{ status: 200, description: "The call.", schema: "Call" }, { status: 404, description: "No such call in this workspace." }],
  },
  {
    id: "log-call",
    group: "Calls",
    method: "POST",
    path: "/calls",
    summary: "Log a call",
    description:
      "A call made in your own dialer. With just an outcome it's saved right away (201): it goes in the lead's history, the lead moves on (a meeting moves it to Meeting, not interested to Lost and onto Inactive) and the rep's open call task on the lead is done. Send its transcript or a link to its recording instead and SealMe writes it up like its own calls (202, status processing): notes, the lead's details, follow-ups, and for a sales call a deal and contract. call.completed fires once it's done.",
    write: true,
    body: [
      { name: "leadId", type: "string", description: "The lead the call was with. Or send leadExternalId." },
      { name: "leadExternalId", type: "string", description: "Your id for the lead, instead of leadId." },
      { name: "repEmail", type: "string", description: "Who made the call, by their SealMe login. Defaults to the lead's owner; without either the call is saved without a rep. A sales call needs one." },
      { name: "outcome", type: "string", description: "meeting_booked, interested, follow_up, not_interested, wrong_person, voicemail or no_answer. Required without a transcript or recording; with one, SealMe works it out." },
      { name: "summary", type: "string", description: "Notes on the call, up to 4,000 characters." },
      { name: "transcript", type: "string", description: "What was said, \"Name: text\" per line, up to 400,000 characters." },
      { name: "recordingUrl", type: "string", description: "An https link SealMe can download the recording from (mp3, wav, m4a...). Used once to transcribe it, then forgotten." },
      { name: "kind", type: "string", description: "cold or sales. Left out, SealMe tells from the transcript." },
      { name: "startedAt", type: "string", description: "ISO 8601. Defaults to now." },
      { name: "durationSec", type: "number", description: "Length in seconds." },
      { name: "toNumber", type: "string", description: "The number called; defaults to the lead's." },
      { name: "externalId", type: "string", description: "Your dialer's id for the call. Logging the same one twice answers 409." },
    ],
    exampleBody: { leadExternalId: "hs-48213", repEmail: "dana@yourcompany.com", outcome: "no_answer", startedAt: "2026-10-07T14:05:00Z", durationSec: 28, externalId: "pb-77120" },
    responses: [
      { status: 201, description: "Logged with its outcome.", schema: "Call" },
      { status: 202, description: "Being written up from the transcript or recording; call.completed follows.", schema: "Call" },
      { status: 409, description: "Already logged.", example: { error: "A call with this externalId already exists", existingId: "cmcall3d4e0006" } },
      { status: 400, description: "Something in the body is wrong; the error says what." },
      { status: 404, description: "No such lead in this workspace." },
    ],
  },
  {
    id: "book-meeting",
    group: "Tasks",
    method: "POST",
    path: "/meetings",
    summary: "Book a meeting",
    description:
      "A meeting booked outside SealMe. It goes on the rep's day as a sales call (a task), the lead moves to Meeting (and to the rep, if nobody had it), the rep gets a notification, and meeting.booked fires. Move or cancel it with PATCH /tasks/{id}.",
    write: true,
    body: [
      { name: "leadId", type: "string", description: "The lead it's with. Or send leadExternalId." },
      { name: "leadExternalId", type: "string", description: "Your id for the lead, instead of leadId." },
      { name: "date", type: "string", required: true, description: "YYYY-MM-DD." },
      { name: "time", type: "string", description: "HH:mm." },
      { name: "timeZone", type: "string", description: "IANA time zone of date and time. Defaults to the rep's." },
      { name: "repEmail", type: "string", description: "Who takes the meeting, by their SealMe login. Defaults to the lead's owner; without either it's unassigned, for a manager to hand out." },
      { name: "note", type: "string", description: "What it's about." },
      { name: "externalId", type: "string", description: "Your id for the meeting. Booking the same one twice answers 409." },
    ],
    exampleBody: { leadExternalId: "hs-48213", date: "2026-10-20", time: "14:00", timeZone: "America/New_York", repEmail: "dana@yourcompany.com", note: "Demo with the RevOps team", externalId: "aih-mtg-5521" },
    responses: [
      { status: 201, description: "The sales call on the rep's day.", schema: "Task" },
      { status: 409, description: "Already booked.", example: { error: "A meeting with this externalId already exists", existingId: "cmtask7g8h0008" } },
      { status: 400, description: "Something in the body is wrong; the error says what." },
      { status: 404, description: "No such lead in this workspace." },
    ],
  },
  {
    id: "list-tasks",
    group: "Tasks",
    method: "GET",
    path: "/tasks",
    summary: "List tasks",
    description: "Every task, oldest first. For a nightly sync, ask for what changed since the last run with updatedSince.",
    query: [
      { name: "status", type: "string", description: "open, done or skipped." },
      { name: "type", type: "string", description: "cold_call, sales_call, follow_up or other." },
      { name: "assigneeEmail", type: "string", description: "Only one rep's tasks." },
      { name: "leadId", type: "string", description: "Only one lead's tasks." },
      { name: "leadExternalId", type: "string", description: "The same, by your id for the lead." },
      { name: "externalId", type: "string", description: "The meeting you booked with this id." },
      updatedSince,
      ...cursorParams,
    ],
    responses: [{ status: 200, description: "A page of tasks.", schema: "Task", list: true }],
  },
  {
    id: "get-task",
    group: "Tasks",
    method: "GET",
    path: "/tasks/{id}",
    summary: "Get a task",
    description: "One task.",
    responses: [{ status: 200, description: "The task.", schema: "Task" }, { status: 404, description: "No such task in this workspace." }],
  },
  {
    id: "update-task",
    group: "Tasks",
    method: "PATCH",
    path: "/tasks/{id}",
    summary: "Update a task",
    description: "Move it (date, time, timeZone), give it to someone else (repEmail), or close it: status done, or skipped for a cancelled meeting. Changes only the fields you send; null clears time and note. Fires task.completed when it closes.",
    write: true,
    body: [
      { name: "date", type: "string", description: "YYYY-MM-DD." },
      { name: "time", type: "string", description: "HH:mm, or null for any time that day." },
      { name: "timeZone", type: "string", description: "IANA time zone." },
      { name: "repEmail", type: "string", description: "Who it's for, by their SealMe login; null leaves it unassigned." },
      { name: "status", type: "string", description: "open, done or skipped." },
      { name: "priority", type: "string", description: "low, normal, high or urgent." },
      { name: "note", type: "string", description: "What it's about; null clears it." },
    ],
    exampleBody: { date: "2026-10-21", time: "10:30" },
    responses: [{ status: 200, description: "The updated task.", schema: "Task" }, { status: 404, description: "No such task in this workspace." }],
  },
];

export type DocEvent = { name: string; when: string; data: Record<string, unknown> };

const deal = { dealUrl: "https://app.sealme.net/deals/cmdeal8f2k0001", feeDisplay: "$8,500", dealValue: 8500, currency: "USD" };
const contractLinks = { ...deal, contractUrl: "https://app.sealme.net/deals/cmdeal8f2k0001/contract" };
const leadUrl = "https://app.sealme.net/leads/cmlead5e6f0005";
const leadNow = { leadId: "cmlead5e6f0005", externalId: "hs-48213", campaign: "Acme Freight Q4", name: "Sam Rivera", company: "Acme Freight", title: "Head of Revenue Operations", email: "sam.rivera@example.com", phone: "+12025550161" };
const rep = { name: "Dana Lopez", email: "dana@yourcompany.com" };

// Every event about a lead or a deal also carries leadUrl / dealUrl (and
// contractUrl with a contract), and one about a deal its value as a number.
export const EVENTS: DocEvent[] = [
  {
    name: "deal.created",
    when: "A contract deal is started: from a call, a pasted transcript, a renewal or the API. Deals started from a transcript fire once their terms are in. Proposals don't fire it.",
    data: { dealId: "cmdeal8f2k0001", kind: "contract", leadId: "cmlead5e6f0005", clientId: "cmcli4h1x0002", clientName: "Avery Chen", company: "Northwind Studio", service: "Brand identity refresh", feeDisplay: "$8,500", status: "ready", source: "api", owner: rep, createdAt: iso, leadUrl, dealUrl: deal.dealUrl, dealValue: 8500, currency: "USD" },
  },
  { name: "contract.sent", when: "A contract goes out for signature. Proposals don't fire it.", data: { dealId: "cmdeal8f2k0001", contractId: "cmcon2b9q0003", clientName: "Avery Chen", signLink: "https://app.sealme.net/sign/cmcon2b9q0003", ...contractLinks } },
  { name: "contract.viewed", when: "The client opens the contract for the first time. Proposals don't fire it.", data: { dealId: "cmdeal8f2k0001", contractId: "cmcon2b9q0003", clientName: "Avery Chen", viewedAt: iso, ...contractLinks } },
  {
    name: "contract.signed",
    when: "Everyone who has to sign has signed, on SealMe's own page or in DocuSign. The lead it's on is a client from then on (lead.converted fires the first time). sourceDealId is the proposal the contract was made from, or null.",
    data: { dealId: "cmdeal8f2k0001", contractId: "cmcon2b9q0003", leadId: "cmlead5e6f0005", sourceDealId: null, clientName: "Avery Chen", signerName: "Avery Chen", signedAt: iso, leadUrl, ...contractLinks },
  },
  { name: "contract.declined", when: "A signer declines and asks for changes.", data: { dealId: "cmdeal8f2k0001", contractId: "cmcon2b9q0003", signerName: "Jordan Patel", signerEmail: "jordan.patel@example.com", reason: "Payment terms need to be net 30.", declinedAt: iso, ...contractLinks } },
  { name: "contract.expired", when: "A sent contract passes its expiry date unsigned.", data: { dealId: "cmdeal8f2k0001", contractId: "cmcon2b9q0003", leadId: "cmlead5e6f0005", sentAt: iso, expiredAt: iso, leadUrl, ...contractLinks } },
  {
    name: "contract.not_signed",
    when: "A rep marks a sent contract as not signed: the client won't sign it. The client's link stops taking signatures, and a DocuSign envelope is voided. The rep can still send it again.",
    data: { dealId: "cmdeal8f2k0001", contractId: "cmcon2b9q0003", leadId: "cmlead5e6f0005", sentAt: iso, markedAt: iso, markedBy: rep.email, leadUrl, ...contractLinks },
  },
  { name: "lead.created", when: "A lead is added: by hand, from a file, from HubSpot or Salesforce, or through the API.", data: { ...leadNow, stage: "new", pipelineStage: "new", isClient: false, source: "hubspot", owner: rep, createdAt: iso, leadUrl } },
  {
    name: "lead.updated",
    when: "Something about a lead changes: its stage, its owner, contact details or what was learned on a call. changed lists the fields; previousStage is set when the stage moved. Fires alongside lead.converted, meeting.booked and call.completed when those change the lead.",
    data: { ...leadNow, stage: "meeting", pipelineStage: "new", isClient: false, source: "api", owner: rep, createdAt: iso, changed: ["stage", "nextStep", "nextStepAt"], previousStage: "contacted", updatedAt: iso, leadUrl },
  },
  { name: "lead.converted", when: "A lead becomes a client: the first contract on it is signed. Fires once per lead.", data: { leadId: "cmlead5e6f0005", dealId: "cmdeal8f2k0001", clientId: "cmcli4h1x0002", name: "Sam Rivera", company: "Acme Freight", convertedAt: iso, leadUrl, ...deal } },
  {
    name: "call.completed",
    when: "SealMe is done with a call: its notes are written (status processed, with the outcome), or it was set aside (status skipped: nobody picked up, too short, nothing recorded...). Calls you log through the API fire it too (source api, with your externalCallId). A call processed again later fires again with the same callId.",
    data: {
      callId: "cmcall3d4e0006",
      externalCallId: null,
      leadId: "cmlead5e6f0005",
      externalId: "hs-48213",
      campaign: "Acme Freight Q4",
      leadName: "Sam Rivera",
      company: "Acme Freight",
      dealId: null,
      status: "processed",
      kind: "cold",
      outcome: "meeting_booked",
      connected: true,
      skipReason: null,
      summary: "Sam runs RevOps for 40 reps. Contracts take a week after a call. Agreed to a demo Tuesday at 2pm.",
      notes: "- Sam runs RevOps for 40 reps at Acme Freight\n- Contracts go out about a week after a verbal yes\n- Demo with their RevOps team on Tuesday at 2pm; we send the invite",
      source: "phone",
      toNumber: "+12025550161",
      recorded: true,
      durationSec: 312,
      rep,
      startedAt: iso,
      endedAt: iso,
      completedAt: iso,
      leadUrl,
    },
  },
  {
    name: "meeting.booked",
    when: "A cold call ends with a meeting (source call), someone puts a sales call with a lead on a rep's day by hand (manual), or one is booked through POST /meetings (api). date and time are in timeZone; either can be null when the call didn't pin it down.",
    data: { leadId: leadNow.leadId, externalId: leadNow.externalId, campaign: leadNow.campaign, leadName: leadNow.name, company: leadNow.company, title: leadNow.title, email: leadNow.email, phone: leadNow.phone, date: "2026-10-20", time: "14:00", timeZone: "America/New_York", rep, source: "call", callId: "cmcall3d4e0006", taskId: "cmtask7g8h0008", bookedAt: iso, leadUrl },
  },
  {
    name: "task.completed",
    when: "A task is marked done or skipped: by a person (completedBy), because a processed call covered it (callId), or through PATCH /tasks/{id}. externalTaskId is your id for a meeting you booked through the API.",
    data: {
      taskId: "cmtask7g8h0008",
      externalTaskId: null,
      type: "cold_call",
      status: "done",
      leadId: "cmlead5e6f0005",
      externalId: "hs-48213",
      campaign: "Acme Freight Q4",
      leadName: "Sam Rivera",
      dealId: null,
      assignee: rep,
      dueDate: "2026-10-07",
      dueTime: null,
      timeZone: "America/New_York",
      priority: "normal",
      note: null,
      callId: "cmcall3d4e0006",
      completedBy: null,
      completedAt: iso,
      leadUrl,
    },
  },
];

export const BASE_URL = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.sealme.net"}/api/v1`;

// "string | null" → ["string", "null"]; "…" rows and blanks are skipped.
function jsonType(t: string): string | string[] | undefined {
  const parts = t.split("|").map((x) => x.trim()).filter((x) => ["string", "number", "boolean", "object", "array", "null"].includes(x));
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : parts;
}

// A table row can describe several fields at once ("sentAt / viewedAt");
// in the schema each gets its own property.
function schemaProperties(fields: DocField[]) {
  const props: Record<string, Record<string, unknown>> = {};
  for (const f of fields) {
    const type = jsonType(f.type);
    for (const name of f.name.split(/\s*[,/]\s*/)) {
      if (!/^\w+$/.test(name)) continue;
      props[name] = { ...(type ? { type } : {}), description: f.description };
    }
  }
  return props;
}

function modelSchema(name: SchemaName) {
  const own = schemaProperties(SCHEMA_FIELDS[name]);
  const properties = name === "DealDetail" ? { ...schemaProperties(SCHEMA_FIELDS.Deal), ...own } : own;
  return { type: "object", properties, required: Object.keys(EXAMPLES[name]).filter((k) => k in properties), example: EXAMPLES[name] };
}

// OpenAPI 3.1 for the same API, for code generators and API clients.
export function openApiSpec() {
  const schema = (name: SchemaName) => ({ $ref: `#/components/schemas/${name}` });
  const bodySchema = (fields: DocField[]) => ({ type: "object", properties: schemaProperties(fields), required: fields.filter((f) => f.required).map((f) => f.name) });
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of ENDPOINTS) {
    const params = [
      ...(e.path.includes("{id}") ? [{ name: "id", in: "path", required: true, schema: { type: "string" } }] : []),
      ...(e.query ?? []).map((q) => ({ name: q.name, in: "query", required: false, description: q.description, schema: { type: "string" } })),
    ];
    const paged = e.query?.some((q) => q.name === "cursor");
    const responses: Record<string, unknown> = {};
    for (const r of e.responses) {
      const body = r.schema
        ? r.list
          ? { type: "object", properties: { data: { type: "array", items: schema(r.schema) }, ...(paged ? { nextCursor: { type: ["string", "null"] } } : {}) }, required: ["data", ...(paged ? ["nextCursor"] : [])] }
          : schema(r.schema)
        : { $ref: "#/components/schemas/Error" };
      const example = r.example ?? (r.schema ? (r.list ? { data: [EXAMPLES[r.schema]], ...(paged ? { nextCursor: null } : {}) } : EXAMPLES[r.schema]) : undefined);
      responses[String(r.status)] = { description: r.description, content: { "application/json": { schema: body, ...(example ? { example } : {}) } } };
    }
    const error = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });
    responses["401"] = error("Missing or wrong API key.");
    responses["429"] = error("Over the rate limit; see Retry-After.");
    const prospecting = e.group === "Leads" || e.group === "Calls" || e.group === "Tasks";
    if (e.write || prospecting) responses["403"] = error(prospecting ? "The key is read-only, or Prospecting is off for this workspace." : "The key is read-only.");
    paths[e.path] = {
      ...(paths[e.path] ?? {}),
      [e.method.toLowerCase()]: {
        operationId: e.id,
        tags: [e.group],
        summary: e.summary,
        description: e.description,
        parameters: params,
        ...(e.body ? { requestBody: { required: true, content: { "application/json": { schema: bodySchema(e.body), ...(e.exampleBody ? { example: e.exampleBody } : {}) } } } } : {}),
        responses,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "SealMe API", version: "1.0.0", description: "Read deals, clients, contracts, leads, calls and tasks, start deals from call transcripts, add leads, log calls from your own dialer and book meetings. Webhooks are described at /developers.", contact: { email: "ivan@sealme.net" } },
    servers: [{ url: BASE_URL }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: "Deals", description: "Deals started from calls, transcripts, leads, renewals or the API." },
      { name: "Clients", description: "The people and companies deals are with." },
      { name: "Contracts", description: "A deal's contract and where it is in signing." },
      { name: "Templates", description: "Proposal and contract templates a deal can use." },
      { name: "Leads", description: "Prospects before they become deals (Prospecting)." },
      { name: "Calls", description: "Calls with leads, made through SealMe or logged from your own dialer (Prospecting)." },
      { name: "Tasks", description: "Reps' to-dos, including booked meetings (Prospecting)." },
    ],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "An API key from Settings → API & webhooks (sk_live_… or, for a sandbox, sk_test_…)." } },
      schemas: {
        ...Object.fromEntries((Object.keys(SCHEMA_FIELDS) as SchemaName[]).map((n) => [n, modelSchema(n)])),
        Error: { type: "object", properties: { error: { type: "string", description: "What went wrong, written to be shown to a person." }, existingId: { type: "string", description: "On a 409: the record that already exists." } }, required: ["error"] },
      },
    },
  };
}
