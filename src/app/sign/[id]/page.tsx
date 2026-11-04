import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { dispatchWebhookEvent } from "@/lib/webhooks";
import { contractParty, fillClauses } from "@/lib/contract";
import { signContract, requestClauseChange } from "./actions";
import BrandLogo from "@/components/BrandLogo";
import SignForm from "@/components/SignForm";
import ClauseChangeForm from "@/components/ClauseChangeForm";
import DownloadContractButton from "@/components/DownloadContractButton";
import LocalDateTime from "@/components/LocalDateTime";
import { canCommentOnClauses, signPageMessage, signPageState } from "./sign-state";

export default async function SignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ feedbackSent?: string }> }) {
  const { id } = await params;
  const { feedbackSent } = await searchParams;
  const contract = await prisma.contract.findUnique({
    where: { id },
    include: { deal: { include: { client: true, fields: true, workspace: true } }, template: true, signers: { orderBy: { order: "asc" } } },
  });
  if (!contract || !contract.template) notFound();

  if (!contract.viewedAt) {
    // updateMany so two tabs opening at once announce it only once.
    const viewedAt = new Date();
    const first = await prisma.contract.updateMany({ where: { id: contract.id, viewedAt: null }, data: { viewedAt } });
    if (first.count === 1) {
      await dispatchWebhookEvent(contract.deal.workspaceId, "contract.viewed", { dealId: contract.dealId, contractId: contract.id, clientName: contract.deal.client.name, viewedAt: viewedAt.toISOString() });
    }
  }

  const clauses = fillClauses(contract.template.clauses, contract.deal.fields);
  // The client is the only signer whose page this is — "signed" here means
  // the CLIENT'S OWN part is done, whether or not counter-signers still
  // need to act (partially_signed) or everyone's fully done (signed).
  const state = signPageState(contract);
  const clientSigned = state === "signed";
  const canComment = canCommentOnClauses(contract);
  const notice = clientSigned ? null : signPageMessage(state, contract.deal.workspace.name);

  return (
    <div className="sm-theme min-h-screen" style={{ background: "var(--canvas)" }}>
      <header className="border-b px-6 py-4" style={{ borderColor: "var(--hairline)" }}>
        <div className="mx-auto flex max-w-[720px] items-center gap-2.5">
          {contract.deal.workspace.logoImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={contract.deal.workspace.logoImage} alt={contract.deal.workspace.name} style={{ height: 28, maxWidth: 160, objectFit: "contain" }} />
          ) : (
            <>
              <div
                className="flex h-[30px] w-[30px] items-center justify-center rounded-[9px] font-display text-[14px] font-semibold"
                style={{ background: "var(--primary)", color: "var(--on-primary)" }}
              >
                S
              </div>
              <span className="text-[14px] font-medium">{contract.deal.workspace.name}</span>
            </>
          )}
          <span style={{ color: "var(--ink-muted)" }}>·</span>
          <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>via</span>
          <BrandLogo height={13} className="opacity-70" />
        </div>
      </header>

      <main className="mx-auto max-w-[720px] px-6 py-10">
        {feedbackSent && (
          <div className="chip chip-success mb-6 w-full justify-start px-4 py-3 text-[13.5px]">
            ✓ Thanks. Your feedback was sent. We&apos;ll follow up.
          </div>
        )}
        {notice && (
          <div className="chip chip-warn mb-6 w-full justify-start whitespace-normal px-4 py-3 text-[13.5px]">
            {notice}
          </div>
        )}
        {clientSigned && (
          <div className="mb-6 flex flex-col gap-3">
            <div className="chip chip-success px-4 py-3 text-[13.5px]">
              ✓ Signed by {contract.signerName}{contract.signedAt && <> on <LocalDateTime iso={contract.signedAt.toISOString()} options={{ year: "numeric", month: "numeric", day: "numeric" }} /></>}
            </div>
            {contract.signatureImage && (
              <div className="card inline-block w-fit px-4 py-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={contract.signatureImage} alt={`${contract.signerName}'s signature`} style={{ height: 60 }} />
              </div>
            )}
            {contract.status === "partially_signed" && contract.signers.length > 0 && (
              <div className="card px-4 py-3 text-[13px]" style={{ color: "var(--ink-muted)" }}>
                Waiting on {contract.signers.filter((s) => s.status === "pending").map((s) => `${s.name} (${s.role})`).join(", ")} before this is fully complete.
              </div>
            )}
          </div>
        )}

        <div className="card px-5 py-7 md:px-[46px] md:py-[42px]">
          <div className="mb-1.5 text-[22px] font-medium" style={{ letterSpacing: "-0.6px" }}>{contract.template.name}</div>
          <div className="mb-7 border-b pb-[22px] text-[13.5px]" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline-soft)" }}>
            Between {contract.deal.workspace.name} and {contractParty(contract.deal.fields, contract.deal.client)}
          </div>
          {clauses.map((clause, i) => (
            <div key={clause.title} className="mb-5 max-w-[64ch]">
              <h3 className="mb-1.5 flex gap-2 text-[14px] font-semibold">
                <span className="font-mono-tab font-normal" style={{ color: "var(--ink-muted)" }}>{i + 1}.</span>
                {clause.title}
              </h3>
              <p className="text-[14px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>{clause.body}</p>
              {canComment && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12px] font-medium" style={{ color: "var(--accent-blue)" }}>
                    Request a change to this clause
                  </summary>
                  <ClauseChangeForm contractId={contract.id} clauseTitle={clause.title} requestChangeAction={requestClauseChange} />
                </details>
              )}
            </div>
          ))}
        </div>

        {state === "open" ? (
          <div className="card mt-5 p-6">
            <h2 className="mb-1 text-[16px] font-medium">Review &amp; sign</h2>
            <p className="mb-4 text-[13px]" style={{ color: "var(--ink-muted)" }}>
              Draw your signature below and click Sign to complete this agreement.
            </p>
            <SignForm contractId={contract.id} signAction={signContract} />
          </div>
        ) : clientSigned ? (
          <div className="mt-5 text-center text-[12px]" style={{ color: "var(--ink-muted)" }}>
            This agreement was signed electronically
            {contract.signedAt && <> on <LocalDateTime iso={contract.signedAt.toISOString()} options={{ year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }} /></>}.
          </div>
        ) : null}

        <DownloadContractButton contractId={contract.id} className="btn btn-secondary mt-5 w-full justify-center" />
      </main>
    </div>
  );
}
