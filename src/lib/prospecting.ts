import { requireWorkspace } from "@/lib/workspace";

// Every page and server action behind Leads, tasks, and phone calls calls
// this first. Leads used to be a feature a workspace had to have turned on
// (Workspace.prospectingEnabled); every call is on a lead now, so every
// workspace has them and the column is no longer read.
export async function requireProspecting() {
  return requireWorkspace();
}
