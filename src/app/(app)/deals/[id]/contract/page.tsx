import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { contractExpired } from "@/lib/contract-status";
import { liveContractText, readContractText, showsLiveTerms, snapshotDiffers } from "@/lib/contract-snapshot";
import { clauseNumbers } from "@/lib/contract";
import { docusignVoid } from "@/lib/docusign-sync";
import { canSendContract } from "@/lib/review";
import { requireWorkspaceId } from "@/lib/workspace";
import { currentUserWithRole } from "@/lib/permissions";
import { dealVisibilityFilter } from "@/lib/deal-visibility";
import { leadAccess } from "@/lib/lead-visibility";
import DownloadContractButton from "@/components/DownloadContractButton";
import AuditTrailButton from "@/components/AuditTrailButton";
import LocalDateTime from "@/components/LocalDateTime";
import ProposalActions from "@/components/ProposalActions";
import MarkNotSignedButton from "@/components/MarkNotSignedButton";
import RestoreFromTrashButton from "@/components/RestoreFromTrashButton";
import { canMarkNotSigned } from "@/lib/deal-status";
import { wentOut } from "@/lib/lead-pipeline";
import { startRenewal, updateFieldValues } from "../actions";

function daysUntil(date: Date): number {
  return Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default async function ContractPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ updated?: string }>;
}) {
  const { id } = await params;
  const { updated } = await searchParams;
  const workspaceId = await requireWorkspaceId();
  const currentUser = await currentUserWithRole();
  const { where: visibility } = await dealVisibilityFilter(currentUser);
  const deal = await prisma.deal.findFirst({
    where: { id, workspaceId, ...visibility },
    include: {
      client: true,
      fields: true,
      contract: {
        include: {
          template: true,
          clauseComments: { where: { resolved: false }, orderBy: { createdAt: "asc" } },
          signers: { orderBy: { order: "asc" } },
        },
      },
      workspace: true,
      // A proposal's contract, once one was made from it, and the proposal
      // a contract was made from.
      derivedDeals: { where: { trashedAt: null, kind: { not: "proposal" } }, select: { id: true }, orderBy: { createdAt: "desc" }, take: 1 },
      sourceDeal: { select: { id: true } },
      lead: { select: { id: true, name: true } },
    },
  });
  if (!deal || !deal.contract) notFound();
  // A proposal is only read: no signing, counter-signers, expiry, review or
  // renewal, and its sidebar has the proposal's own actions.
  const isProposal = deal.kind === "proposal";
  const contractTemplates = isProposal
    ? await prisma.contractTemplate.findMany({ where: { workspaceId, kind: { not: "proposal" } }, select: { id: true, name: true }, orderBy: { name: "asc" } })
    : [];

  // While the contract is being worked on (draft, review, changes asked for,
  // a lapsed link) this previews what the next send carries; once it's out,
  // it shows exactly what the client got.
  // A proposal stays editable after it went out, so the team always sees its
  // current terms, with a note when the client still has an earlier version.
  const now = new Date();
  const liveProposal = isProposal ? liveContractText({ template: deal.contract.template, deal }) : null;
  const agreement = liveProposal ?? (await readContractText({ ...deal.contract, deal }, { asTeam: true, now }));
  if (!agreement) notFound();
  const changedSinceSent = isProposal && deal.contract.status === "sent" && snapshotDiffers(deal.contract.snapshot, liveProposal);
  // The subtitle says the client has this text only when they do. A proposal
  // changed since it went out, or a contract being reworked for another send
  // (readContractText then shows the live terms), shows newer terms.
  const reworked = isProposal ? changedSinceSent : showsLiveTerms(deal.contract, now) && deal.contract.template != null;
  const clientName = deal.client.name;
  const subtitle = !wentOut(deal.contract)
    ? isProposal
      ? `Check it before it goes to ${clientName}`
      : "Confirm the details before sending to your client"
    : reworked
      ? isProposal
        ? `Your latest version. ${clientName} still has the one you sent`
        : `Check it before it goes back to ${clientName}`
      : isProposal
        ? `What ${clientName} sees on their link`
        : `Sent to ${clientName}`;
  // Back to the lead only when this viewer can open it: a reviewer, or anyone
  // on an unowned deal, can see the deal without seeing its lead.
  const lead = deal.lead
    ? await prisma.lead.findFirst({ where: { id: deal.lead.id, workspaceId, ...(await leadAccess(currentUser)).where }, select: { id: true, name: true } })
    : null;
  const numbers = clauseNumbers(agreement.clauses);
  // The sign page stops taking signatures the moment expiresAt passes; the
  // daily cron only catches up on the status later, so both count here.
  const expired = !isProposal && contractExpired(deal.contract, now);
  // The rep closed it by hand: nobody can sign it, and Send again reopens it.
  // Contract rows keep no updatedAt, so the when comes from the audit log.
  const notSigned = !isProposal && deal.contract.status === "not_signed";
  const markedNotSigned = notSigned
    ? await prisma.auditLog.findFirst({
        where: { workspaceId, action: "contract.marked_not_signed", targetId: { in: [deal.contract.id, deal.id] } },
        select: { createdAt: true },
        orderBy: { createdAt: "desc" },
      })
    : null;
  const canResend = canSendContract(deal.contract);
  // Nothing goes out from the trash (every send refuses it), so the page
  // says so where Send would be, instead of a button that only fails.
  const trashed = Boolean(deal.trashedAt);
  const voided = await docusignVoid({ id: deal.contract.id, dealId: deal.id, status: deal.contract.status, deliveryMethod: deal.contract.deliveryMethod }, workspaceId);
  const waitingOn = deal.contract.signers.filter((s) => s.status === "pending").map((s) => `${s.name} (${s.role})`).join(", ");
  // Which deal fields each clause pulls in (e.g. "Fees & Payment" -> {fee}),
  // so a client's change request can be answered right under the comment.
  const fieldsByClause = new Map<string, typeof deal.fields>();
  for (const raw of deal.contract.template ? (JSON.parse(deal.contract.template.clauses) as { title: string; body: string }[]) : []) {
    const keys = new Set([...raw.body.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
    fieldsByClause.set(raw.title, deal.fields.filter((f) => keys.has(f.fieldKey) && f.status !== "missing"));
  }
  const updateClauseFields = updateFieldValues.bind(null, deal.id);
  const commentsByClause = new Map<string, typeof deal.contract.clauseComments>();
  for (const comment of deal.contract.clauseComments) {
    if (!commentsByClause.has(comment.clauseTitle)) commentsByClause.set(comment.clauseTitle, []);
    commentsByClause.get(comment.clauseTitle)!.push(comment);
  }

  return (
    <>
    {/* Back to the person it's for, opened on the call it came from. Older
        documents with no lead, or a lead this viewer can't open, go back to
        their deal page. */}
    <Link
      href={lead ? `/leads/${lead.id}${deal.phoneCallId ? `?call=${deal.phoneCallId}` : ""}` : `/deals/${deal.id}`}
      className="mb-3.5 inline-flex max-w-full items-center gap-1.5 truncate text-[13px] font-medium"
      style={{ color: "var(--ink-muted)" }}
    >
      ← {lead ? lead.name : "Deal"}
    </Link>

    <div className="mb-5">
      <h1 className="text-[25px] font-medium" style={{ letterSpacing: "-0.8px" }}>{isProposal ? "Proposal" : "Contract review"}</h1>
      <div className="mt-1 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        {subtitle}
      </div>
      {!isProposal && deal.sourceDeal && (
        <Link href={`/deals/${deal.sourceDeal.id}`} className="mt-1 inline-block text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
          Made from a proposal →
        </Link>
      )}
    </div>

    {trashed && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className="chip chip-danger whitespace-normal px-4 py-3 text-[13.5px]">
          This {isProposal ? "proposal" : "contract"} is in the trash. Restore it to send it
        </div>
      </div>
    )}
    {!isProposal && deal.contract.status === "signed" && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className="chip chip-success px-4 py-3 text-[13.5px]">
          ✓ Signed by {deal.contract.signerName}{deal.contract.signedAt && <> on <LocalDateTime iso={deal.contract.signedAt.toISOString()} options={{ year: "numeric", month: "numeric", day: "numeric" }} /></>}
        </div>
        {deal.contract.signatureImage && (
          <div className="card px-3 py-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={deal.contract.signatureImage} alt={`${deal.contract.signerName}'s signature`} style={{ height: 40 }} />
          </div>
        )}
      </div>
    )}
    {!isProposal && deal.contract.status === "pending_approval" && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className="chip chip-neutral px-4 py-3 text-[13.5px]">
          Waiting on review before this goes to {deal.client.name}
        </div>
        <Link href={`/deals/${deal.id}`} className="text-[12.5px] font-medium" style={{ color: "var(--accent-blue)" }}>
          See who has it →
        </Link>
      </div>
    )}
    {!isProposal && deal.contract.status === "changes_requested" && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className={`chip ${updated ? "chip-success" : "chip-warn"} px-4 py-3 text-[13.5px]`}>
          {updated
            ? "Contract updated. Click Send again so the client gets this version"
            : voided
              ? `Voided in DocuSign${voided.reason ? `: ${voided.reason}` : ""}. Make any changes, then send it again`
              : "Changes requested. Update the terms below each comment, then send again"}
        </div>
      </div>
    )}
    {!isProposal && deal.contract.status === "partially_signed" && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className="chip chip-warn whitespace-normal px-4 py-3 text-[13.5px]">
          ✓ Signed by {deal.contract.signerName}. Waiting on {waitingOn || "the other signers"}
        </div>
      </div>
    )}
    {expired && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className="chip chip-warn whitespace-normal px-4 py-3 text-[13.5px]">
          Sign link expired{deal.contract.expiresAt && <> on <LocalDateTime iso={deal.contract.expiresAt.toISOString()} options={{ year: "numeric", month: "numeric", day: "numeric" }} /></>}. Send it again so {deal.client.name} can sign
        </div>
      </div>
    )}
    {notSigned && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className="chip chip-danger whitespace-normal px-4 py-3 text-[13.5px]">
          Marked as not signed{markedNotSigned && <> on <LocalDateTime iso={markedNotSigned.createdAt.toISOString()} options={{ year: "numeric", month: "numeric", day: "numeric" }} /></>}. Send it again if {deal.client.name} wants to go ahead
        </div>
      </div>
    )}
    {deal.contract.status === "sent" && !expired && (
      <div className="mb-[18px] flex flex-wrap items-center gap-3">
        <div className={`chip ${isProposal ? "chip-neutral" : "chip-warn"} px-4 py-3 text-[13.5px]`}>
          ✓ Sent to {deal.client.name}{isProposal ? "" : ". Awaiting signature"}
        </div>
        {deal.contract.viewedAt && (
          <span className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            👁 Viewed {timeAgo(deal.contract.viewedAt)}
          </span>
        )}
      </div>
    )}

    <div className="grid grid-cols-1 gap-[18px] lg:grid-cols-[1fr_300px]">
      <div className="card px-5 py-7 md:px-[46px] md:py-[42px]">
        <div className="mb-1.5 text-[21px] font-medium" style={{ letterSpacing: "-0.6px" }}>{agreement.templateName}</div>
        <div className="mb-7 border-b pb-[22px] text-[13.5px]" style={{ color: "var(--ink-muted)", borderColor: "var(--hairline-soft)" }}>
          Between {agreement.agencyName} and {agreement.clientName}
        </div>
        {agreement.clauses.map((clause, i) => (
          <div key={`${i}-${clause.title}`} className="mb-5 max-w-[64ch]">
            <h3 className="mb-1.5 flex gap-2 text-[14px] font-semibold">
              {numbers[i] && <span className="font-mono-tab font-normal" style={{ color: "var(--ink-muted)" }}>{numbers[i]}</span>}
              {clause.title}
            </h3>
            <p className="whitespace-pre-line text-[14px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>{clause.body}</p>
            {commentsByClause.get(clause.title)?.map((comment) => (
              <div key={comment.id} className="mt-2 rounded-[8px] px-3 py-2.5 text-[12.5px]" style={{ background: "var(--warn-soft)", color: "var(--ink)" }}>
                <span className="font-medium">{comment.fromName}:</span> {comment.comment}
              </div>
            ))}
            {canResend && commentsByClause.has(clause.title) && (
              (fieldsByClause.get(clause.title)?.length ?? 0) > 0 ? (
                <form action={updateClauseFields} className="mt-2 flex flex-col gap-2 rounded-[8px] p-3" style={{ border: "1px solid var(--hairline)" }}>
                  <input type="hidden" name="returnTo" value="contract" />
                  {fieldsByClause.get(clause.title)!.map((field) => (
                    <label key={field.id} className="flex flex-col gap-1">
                      <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>{field.label}</span>
                      <input name={field.id} defaultValue={field.value ?? ""} className="input" style={{ fontSize: "13px", padding: "8px 11px" }} />
                    </label>
                  ))}
                  <button type="submit" className="btn btn-primary btn-sm self-start">
                    Update contract
                  </button>
                </form>
              ) : (
                <p className="mt-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>
                  This clause is fixed template wording. Change it in the template, or reply to the client and send again as is.
                </p>
              )
            )}
          </div>
        ))}
      </div>

      <aside className="card">
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Send</h2>
        </div>
        <div className="mx-5 my-3.5 flex items-center justify-between rounded-[10px] px-3 py-2.5 text-[13px] font-medium" style={{ border: "1px solid var(--hairline)", background: "var(--canvas)" }}>
          {agreement.templateName}
        </div>
        <div className="flex flex-col gap-2.5 p-5 pt-2">
          {trashed ? (
            <>
              <div className="rounded-[10px] px-3 py-2.5 text-[12.5px]" style={{ border: "1px solid var(--hairline)", background: "var(--canvas)", color: "var(--ink-muted)" }}>
                In the trash. Restore it to send it.
              </div>
              <RestoreFromTrashButton dealId={deal.id} />
              <DownloadContractButton contractId={deal.contract.id} kind={deal.kind} className="btn btn-secondary w-full justify-center" />
            </>
          ) : isProposal ? (
            <ProposalActions
              compact
              dealId={deal.id}
              contractId={deal.contract.id}
              contractStatus={deal.contract.status}
              ready={deal.status !== "processing" && deal.fields.every((f) => f.status !== "missing")}
              notReadyHint="Fill in the missing details on the deal first."
              viewedAt={deal.contract.viewedAt?.toISOString() ?? null}
              derivedContractId={deal.derivedDeals[0]?.id ?? null}
              contractTemplates={contractTemplates}
              changedSinceSent={changedSinceSent}
              createDisabled={deal.status === "processing"}
            />
          ) : (
          <>
          {canResend ? (
            <Link href={`/deals/${deal.id}/send`} className="btn btn-primary w-full justify-center">
              {deal.contract.status === "changes_requested" || expired || notSigned ? "Send again" : "Send to client"}
            </Link>
          ) : deal.contract.status === "pending_approval" ? (
            <button disabled className="btn btn-primary w-full justify-center">
              Awaiting approval
            </button>
          ) : (
            <>
              <button disabled className="btn btn-primary w-full justify-center">
                {deal.contract.status === "signed" ? "Signed ✓" : deal.contract.status === "partially_signed" ? "Awaiting counter-signer" : "Sent ✓"}
              </button>
              {/* A DocuSign contract is signed on DocuSign's own page, never this
                  link, and one marked not signed can't be signed at all. */}
              {deal.contract.deliveryMethod === "sealme" && !notSigned && (
                <div className="rounded-[10px] px-3 py-2.5 text-[11.5px] break-all" style={{ border: "1px solid var(--hairline)", background: "var(--canvas)", color: "var(--ink-muted)" }}>
                  {`${process.env.NEXT_PUBLIC_APP_URL ?? ""}/sign/${deal.contract.id}`}
                </div>
              )}
            </>
          )}
          {canMarkNotSigned(deal.contract, deal.kind) && <MarkNotSignedButton dealId={deal.id} clientName={deal.client.name} />}
          <DownloadContractButton contractId={deal.contract.id} className="btn btn-secondary w-full justify-center" />
          </>
          )}
          {Boolean(currentUser.role?.canManageWorkspace) && (
            <AuditTrailButton dealId={deal.id} className="btn btn-secondary w-full justify-center" />
          )}
        </div>
      </aside>
    </div>

    {!isProposal && deal.contract.status === "signed" && deal.contract.renewalDate && (
      <div className="card mt-[18px] max-w-[600px]">
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--hairline)" }}>
          <h2 className="text-[15px] font-medium">Renewal</h2>
        </div>
        <div className="flex flex-col gap-3 px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13.5px] font-medium">
                {deal.contract.autoRenews ? "Auto-renews" : "Term ends"} {deal.contract.renewalDate.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
              </div>
              {deal.contract.renewalNote && (
                <div className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>{deal.contract.renewalNote}</div>
              )}
            </div>
            <span className={`chip flex-none ${daysUntil(deal.contract.renewalDate) <= 30 ? "chip-warn" : "chip-neutral"}`} style={{ fontSize: 11 }}>
              {daysUntil(deal.contract.renewalDate) > 0 ? `${daysUntil(deal.contract.renewalDate)}d left` : "Past due"}
            </span>
          </div>
          <form action={startRenewal.bind(null, deal.id)}>
            <button type="submit" className="btn btn-secondary w-full justify-center">
              Start renewal
            </button>
          </form>
        </div>
      </div>
    )}

    </>
  );
}
