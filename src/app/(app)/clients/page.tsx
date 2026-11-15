import { redirect } from "next/navigation";

// Clients are leads who signed: an old link to the list opens that tab of
// Leads. A client's own page (/clients/[id], which the API links to) stays.
export default function ClientsPage() {
  redirect("/leads?tab=clients");
}
