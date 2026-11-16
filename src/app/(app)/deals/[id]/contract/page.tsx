import { redirect } from "next/navigation";

// The contract has one screen: the deal page, which draws it the same way
// during the call and whenever it's opened later. Links made before (emails,
// notifications, webhooks, Slack, the API) still point here and go on to it,
// and it checks who may see the deal.
export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/deals/${encodeURIComponent(id)}`);
}
