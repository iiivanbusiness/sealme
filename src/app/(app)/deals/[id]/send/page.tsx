import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { isEmailConfigured } from "@/lib/email";
import { requireWorkspace, requireWorkspaceId } from "@/lib/workspace";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { canSendContract } from "@/lib/review";
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
  // Already with a reviewer or the client (e.g. Back after sending).
  if (!canSendContract(deal.contract)) redirect(`/deals/${deal.id}/contract`);

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

  const defaultSubject = `${deal.template.name} from ${workspaceName}`;
  const defaultMessage = `Hi ${deal.client.name.split(" ")[0]},\n\nThanks again for the call. Here's the ${deal.template.name.toLowerCase()} we discussed. Take a look and sign whenever you're ready.\n\nLet me know if anything needs adjusting.`;

  return (
    <>
    <Link href={`/deals/${deal.id}/contract`} className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
      ← Contract review
    </Link>

    <div className="mb-6 max-w-[560px]">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>Send to {deal.client.name}</h1>
      <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        Review and edit before it goes out. The sign link is added automatically.
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
      docusignAvailable={docusignAvailable}
      docusignAccountEmail={workspace?.docusignAccountEmail ?? null}
      defaultCc={defaultCc}
      defaultDeliveryMethod={deal.contract.deliveryMethod}
      initialSigners={deal.contract.signers.map((s) => ({ name: s.name, email: s.email, role: s.role }))}
      sendAction={sendContractEmail}
    />
    </>
  );
}
