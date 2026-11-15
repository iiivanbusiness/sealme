// The lead stages, with no server code: the Leads filters (a client
// component) use them too. lead-pipeline.ts works out which one a lead is at.
// Where a lead is on the Leads list. Clients are for good (a signed
// contract); lost and not_now are someone's call and stay until someone
// changes them; the rest follow the lead's proposals and contracts.
export const PIPELINE_STAGES = ["new", "proposal_sent", "contract_sent", "client", "lost", "not_now", "not_signed"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_LABEL: Record<string, string> = {
  new: "New",
  proposal_sent: "Proposal sent",
  contract_sent: "Contract sent",
  client: "Client",
  lost: "Lost",
  not_now: "Not now",
  not_signed: "Not signed",
};

export const PIPELINE_STAGE_CHIP: Record<string, string> = {
  new: "chip-neutral",
  proposal_sent: "chip-active",
  contract_sent: "chip-warn",
  client: "chip-success",
  lost: "chip-danger",
  not_now: "chip-neutral",
  not_signed: "chip-danger",
};

export function isPipelineStage(value: string | null | undefined): value is PipelineStage {
  return (PIPELINE_STAGES as readonly string[]).includes(value ?? "");
}
