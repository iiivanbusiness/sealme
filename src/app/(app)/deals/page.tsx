import { redirect } from "next/navigation";

// The deals list is gone: a proposal or contract lives on the call it came
// from, under the lead. An old link to the list opens Leads; a deal's own
// pages (/deals/[id], its contract, the trash) are unchanged.
export default function DealsPage() {
  redirect("/leads");
}
