import { redirect } from "next/navigation";

// Notes used to be its own page; every call has notes on its lead now, so an
// old link opens Leads.
export default function NotesPage() {
  redirect("/leads");
}
