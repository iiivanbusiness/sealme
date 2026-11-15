import { feeCurrency, parseFee } from "@/lib/money";

// The shapes the public API returns. One place, so a deal looks the same
// in a list, on its own, and inside a webhook-triggered fetch.

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
// Where the record opens in SealMe, for a "View in SealMe" button.
const appLink = (path: string) => `${process.env.NEXT_PUBLIC_APP_URL ?? "https://app.sealme.net"}${path}`;
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

export function serializeClient(client: { id: string; name: string; company: string; email: string | null; billingAddress: string | null; createdAt: Date }) {
  return {
    id: client.id,
    name: client.name,
    company: client.company,
    email: client.email,
    billingAddress: client.billingAddress,
    url: appLink(`/clients/${client.id}`),
    createdAt: client.createdAt.toISOString(),
  };
}

type DealRow = {
  id: string;
  service: string;
  feeDisplay: string;
  status: string;
  source: string;
  summary?: string | null;
  createdAt: Date;
  updatedAt: Date;
  client: { id: string; name: string; company: string; email: string | null };
  owner?: { name: string; email: string } | null;
  leadId?: string | null;
  kind?: string;
};

export function serializeDeal(deal: DealRow) {
  const fee = parseFee(deal.feeDisplay);
  return {
    id: deal.id,
    status: deal.status,
    source: deal.source,
    // A proposal or a contract, and the lead it's for.
    kind: deal.kind ?? "contract",
    leadId: deal.leadId ?? null,
    service: deal.service,
    fee: deal.feeDisplay,
    value: fee || null,
    currency: feeCurrency(deal.feeDisplay),
    client: { id: deal.client.id, name: deal.client.name, company: deal.client.company, email: deal.client.email },
    owner: deal.owner ? { name: deal.owner.name, email: deal.owner.email } : null,
    url: appLink(`/deals/${deal.id}`),
    createdAt: deal.createdAt.toISOString(),
    updatedAt: deal.updatedAt.toISOString(),
  };
}

export function serializeDealDetail(
  deal: DealRow & {
    contract: { id: string; status: string; sentAt: Date | null; signedAt: Date | null } | null;
    fields: { fieldKey: string; label: string; value: string | null; status: string; orderIndex: number }[];
  },
) {
  return {
    ...serializeDeal(deal),
    summary: deal.summary ?? null,
    // The terms agreed on the call, in the order the deal page shows them.
    terms: [...deal.fields].sort((a, b) => a.orderIndex - b.orderIndex).map((f) => ({ key: f.fieldKey, label: f.label, value: f.value, status: f.status })),
    contract: deal.contract
      ? { id: deal.contract.id, status: deal.contract.status, sentAt: iso(deal.contract.sentAt), signedAt: iso(deal.contract.signedAt), url: appLink(`/deals/${deal.id}/contract`) }
      : null,
  };
}

export function serializeLead(lead: {
  id: string;
  externalId: string | null;
  campaign: string | null;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  domain: string | null;
  stage: string;
  pipelineStage: string;
  isClient: boolean;
  interest: string | null;
  isDecisionMaker: boolean | null;
  painPoints: string | null;
  objections: string | null;
  nextStep: string | null;
  nextStepAt: Date | null;
  summary: string | null;
  notes: string | null;
  source: string;
  lastContactedAt: Date | null;
  convertedDealId: string | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  owner: { name: string; email: string } | null;
}) {
  return {
    id: lead.id,
    externalId: lead.externalId,
    campaign: lead.campaign,
    name: lead.name,
    company: lead.company,
    title: lead.title,
    email: lead.email,
    phone: lead.phone,
    domain: lead.domain,
    // The old stage names, which calls move on; pipelineStage is where the
    // lead is on the Leads list, and isClient whether a contract was signed.
    stage: lead.stage,
    pipelineStage: lead.pipelineStage,
    isClient: lead.isClient,
    interest: lead.interest,
    isDecisionMaker: lead.isDecisionMaker,
    painPoints: lead.painPoints,
    objections: lead.objections,
    nextStep: lead.nextStep,
    nextStepAt: day(lead.nextStepAt),
    summary: lead.summary,
    notes: lead.notes,
    source: lead.source,
    owner: lead.owner ? { name: lead.owner.name, email: lead.owner.email } : null,
    lastContactedAt: iso(lead.lastContactedAt),
    convertedDealId: lead.convertedDealId,
    convertedAt: iso(lead.convertedAt),
    url: appLink(`/leads/${lead.id}`),
    createdAt: lead.createdAt.toISOString(),
    updatedAt: lead.updatedAt.toISOString(),
  };
}

export const LEAD_API_SELECT = {
  id: true,
  externalId: true,
  campaign: true,
  name: true,
  company: true,
  title: true,
  email: true,
  phone: true,
  domain: true,
  stage: true,
  pipelineStage: true,
  isClient: true,
  interest: true,
  isDecisionMaker: true,
  painPoints: true,
  objections: true,
  nextStep: true,
  nextStepAt: true,
  summary: true,
  notes: true,
  source: true,
  lastContactedAt: true,
  convertedDealId: true,
  convertedAt: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { name: true, email: true } },
} as const;
