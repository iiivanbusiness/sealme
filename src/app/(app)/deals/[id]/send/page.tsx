import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { isEmailConfigured } from "@/lib/email";
import { requireWorkspace, requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { canSendDocument } from "@/lib/review";
import { sendContractEmail } from "../actions";
import SendContractForm from "@/components/SendContractForm";

export default async function SendContractPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;
  const workspaceId = await requireWorkspaceId();
  const { where: visibility } = await dealVisibilityFilter();
  const [deal, workspace] = await Promise.all([
    prisma.deal.findFirst({
      where: { id, workspaceId, ...visibility },
      include: { client: true, template: true, contract: { include: { signers: { orderBy: { order: "asc" } } } } },
    }),
    requireWorkspace(),
  ]);
  if (!deal || !deal.contract || !deal.template) notFound();
  // Already with a reviewer or the client (e.g. Back after sending). A sent
  // proposal can go again, so "Send again" lands here.
  if (!canSendDocument(deal.contract, deal.kind)) redirect(`/deals/${deal.id}/contract`);

  const docusignAvailable = Boolean(workspace?.docusignEnabled);

  // The CC list the last send used, so sending again keeps it.
  let defaultCc = "";
  try {
    defaultCc = deal.contract.ccEmails ? (JSON.parse(deal.contract.ccEmails) as string[]).join(", ") : "";
  } catch {
    defaultCc = "";
  }

  const workspaceName = workspace?.name ?? "Your workspace";
  const configured = isEmailConfigured();
  // A proposal is read, not signed: the email links to it, and none of the
  // signing setup applies.
  const isProposal = deal.kind === "proposal";
  const firstName = deal.client.name.split(" ")[0];

  const defaultSubject = `${deal.template.name} from ${workspaceName}`;
  const defaultMessage = isProposal
    ? `Hi ${firstName},\n\nThanks again for the call. Here's the proposal we discussed. Take a look whenever you're ready.\n\nLet me know if anything needs adjusting.`
    : `Hi ${firstName},\n\nThanks again for the call. Here's the ${deal.template.name.toLowerCase()} we discussed. Take a look and sign whenever you're ready.\n\nLet me know if anything needs adjusting.`;

  return (
    <>
    <Link href={`/deals/${deal.id}/contract`} className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
      {isProposal ? "← Proposal" : "← Contract review"}
    </Link>

    <div className="mb-6 max-w-[560px]">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>{isProposal ? `Send the proposal to ${deal.client.name}` : `Send to ${deal.client.name}`}</h1>
      <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        {isProposal ? "A link to the proposal is added below your message." : "Review and edit before it goes out. The sign link is added automatically."}
      </div>
    </div>

    {error && (
      <div className="chip chip-warn mb-4 max-w-[560px] w-full justify-start px-4 py-2.5 text-[12.5px]">
        {error}
      </div>
    )}

    {!configured && (
      <div className="chip chip-warn mb-4 max-w-[560px] w-full justify-start px-4 py-2.5 text-[12.5px]">
        Email sending isn&apos;t set up yet. Add a <span className="font-mono-tab">RESEND_API_KEY</span> to <span className="font-mono-tab">.env</span> first.
      </div>
    )}

    <SendContractForm
      dealId={deal.id}
      configured={configured}
      defaultTo={deal.client.email ?? ""}
      defaultSubject={defaultSubject}
      defaultMessage={defaultMessage}
      clientName={deal.client.name}
      docusignAvailable={docusignAvailable && !isProposal}
      docusignAccountEmail={workspace?.docusignAccountEmail ?? null}
      defaultCc={defaultCc}
      defaultDeliveryMethod={isProposal ? "sealme" : deal.contract.deliveryMethod}
      // Sending again keeps the way it went last time; a first send defaults
      // to DocuSign when it's connected. Changes asked for before it ever
      // went out mean a review started, which saved how it goes out (the
      // Send page's pick, or the one "Send to" made); a draft has only the
      // schema default.
      wentOutBefore={deal.contract.sentAt != null || deal.contract.status === "changes_requested"}
      initialSigners={isProposal ? [] : deal.contract.signers.map((s) => ({ name: s.name, email: s.email, role: s.role }))}
      kind={deal.kind}
      sendAction={sendContractEmail}
    />
    </>
  );
}
