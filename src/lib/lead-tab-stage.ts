import type { LeadTab } from "@/lib/lead-pipeline";
import type { PipelineStage } from "@/lib/pipeline-stages";

// Which Leads tabs a lead at each stage can turn up on (see leadTabWhere in
// lead-pipeline.ts): a client only on Clients; Lost, Not now and Not signed
// only on Inactive; the rest on Active, or on Inactive once nothing has
// happened for 30 days. All has everyone. No server code here: the filter
// bar (a client component) uses it too.
const STAGE_TABS: Record<PipelineStage, readonly LeadTab[]> = {
  new: ["active", "inactive", "all"],
  proposal_sent: ["active", "inactive", "all"],
  contract_sent: ["active", "inactive", "all"],
  client: ["clients", "all"],
  lost: ["inactive", "all"],
  not_now: ["inactive", "all"],
  not_signed: ["inactive", "all"],
};

const TABS: readonly LeadTab[] = ["active", "clients", "inactive", "all"];

// The tab in the address bar: Active when there's none (or one we don't know).
export function parseLeadTab(value: string | null | undefined): LeadTab {
  return TABS.find((t) => t === value) ?? "active";
}

// Whether a lead at this stage can be on this tab. No stage fits anywhere.
export function stageFitsTab(stage: PipelineStage | null, tab: LeadTab): boolean {
  return !stage || STAGE_TABS[stage].includes(tab);
}

// The tab a stage filter shows on: the one asked for when leads at that
// stage can be there, otherwise the only tab they can be on, or All when
// there's more than one (a New lead is on Active or, gone quiet, Inactive).
// So picking Lost on Active shows the lost leads, not an empty list.
export function tabForStage(stage: PipelineStage | null, tab: LeadTab): LeadTab {
  if (!stage || stageFitsTab(stage, tab)) return tab;
  const homes = STAGE_TABS[stage].filter((t) => t !== "all");
  return homes.length === 1 ? homes[0] : "all";
}
