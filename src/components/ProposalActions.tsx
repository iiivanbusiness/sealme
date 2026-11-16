"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DownloadContractButton from "./DownloadContractButton";
import { clientDocumentUrl } from "@/lib/document-links";
import { useVisibleInterval } from "@/lib/use-visible-interval";
import { shareProposalLink } from "@/app/(app)/deals/[id]/share-actions";
import { createContractFromProposalAction } from "@/app/(app)/deals/[id]/proposal-actions";
import { documentViewState } from "@/app/(app)/deals/[id]/view-actions";

// Opening a proposal is the client's move, so it's checked now and then
// rather than every few seconds.
const VIEW_POLL_MS = 20_000;
const COPIED_MS = 1500;

type TemplateOption = { id: string; name: string };

// Everything a rep does with a proposal, in the order they do it: send it
// (by email or as a link), keep a PDF, and make the contract once the client
// wants to go ahead. Nothing here goes out on its own: every send is a click.
// Used on the deal page (in its own card) and in the document screen's
// sidebar (compact, inside that card).
export default function ProposalActions({
  dealId,
  contractId,
  contractStatus,
  ready,
  notReadyHint,
  viewedAt,
  derivedContractId,
  contractTemplates,
  createDisabled = false,
  compact = false,
  changedSinceSent = false,
  showSend = true,
  makeDraftAction,
}: {
  dealId: string;
  // The proposal's Contract row, which holds the document. null until the
  // proposal is made.
  contractId: string | null;
  contractStatus: string | null;
  // Nothing is missing and the document exists (or makeDraftAction can
  // make it), so it can go out.
  ready: boolean;
  // Why it can't go out yet, shown under the disabled buttons.
  notReadyHint?: string;
  viewedAt: string | null;
  // The contract already made from this proposal, if any.
  derivedContractId: string | null;
  contractTemplates: TemplateOption[];
  // Still reading the call: the terms aren't settled enough to copy.
  createDisabled?: boolean;
  compact?: boolean;
  // Sent, then its terms changed: the client still sees the version they
  // got until it's sent again or the link is copied again.
  changedSinceSent?: boolean;
  // False where the screen already has its own Send button (the deal
  // page's bar under the paper), so the card doesn't offer it twice.
  showSend?: boolean;
  // Makes the document when there's none yet (contractId null), so Copy
  // link and Download PDF work on a proposal whose blanks were filled in on
  // the contract screen. Without it they wait for the document.
  makeDraftAction?: () => Promise<{ error?: string; contractId?: string }>;
}) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  // The document made here, until the page renders again with it.
  const [madeId, setMadeId] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // Set when the browser wouldn't write to the clipboard, so the rep can
  // copy the link by hand.
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // What the page showed when the last poll asked for a refresh, so it
  // doesn't keep asking while that refresh is on its way.
  const [refreshedFor, setRefreshedFor] = useState<string | null>(null);

  const sent = contractStatus === "sent";
  const shownState = `${contractStatus}|${viewedAt}`;

  // A sent proposal nobody has opened yet: watch for the first open, so
  // "Viewed" shows up without a reload. Stops once it's opened, and while
  // the page is hidden.
  useVisibleInterval(
    () => {
      documentViewState(dealId)
        .then((state) => {
          if (!state) return;
          if (state.viewedAt || state.contractStatus !== contractStatus) {
            setRefreshedFor(shownState);
            router.refresh();
          }
        })
        .catch(() => {});
    },
    VIEW_POLL_MS,
    sent && !viewedAt && refreshedFor !== shownState
  );

  const docId = contractId ?? madeId;
  const canMake = !docId && !!makeDraftAction;

  // The document's id, made first when there's none yet.
  async function ensureDocument(): Promise<{ contractId?: string; error?: string }> {
    if (docId) return { contractId: docId };
    if (!makeDraftAction) return { error: "Fill in the missing details to make the proposal first" };
    try {
      const result = await makeDraftAction();
      if (result.error || !result.contractId) return { error: result.error ?? "Couldn't make the proposal. Try again." };
      setMadeId(result.contractId);
      return { contractId: result.contractId };
    } catch {
      return { error: "Couldn't make the proposal. Try again." };
    }
  }

  async function handleCopy() {
    if (!ready || copying || (!docId && !canMake)) return;
    setCopyError(null);
    setManualLink(null);
    setCopying(true);
    try {
      await copyAndShare();
    } finally {
      setCopying(false);
    }
  }

  async function copyAndShare() {
    let url: string;
    let write: Promise<void>;
    if (docId) {
      url = clientDocumentUrl(docId, "proposal");
      // The clipboard write starts before any await: browsers only allow it
      // inside the click itself.
      write = navigator.clipboard?.writeText(url) ?? Promise.reject(new Error("No clipboard"));
    } else {
      // No document yet: it's made first. A browser that only takes a
      // clipboard write inside the click refuses the one after, and the
      // link is shown to copy by hand instead.
      const made = await ensureDocument();
      if (!made.contractId) {
        setCopyError(made.error ?? "Couldn't make the proposal. Try again.");
        return;
      }
      url = clientDocumentUrl(made.contractId, "proposal");
      write = navigator.clipboard?.writeText(url) ?? Promise.reject(new Error("No clipboard"));
    }
    try {
      await write;
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      setManualLink(url);
    }
    // Sharing the link is sending it, so a draft is marked sent the same
    // way an email send would. One that already went out stays as it is,
    // unless it was changed since: then the link now shows the new version.
    if (sent && !changedSinceSent) return;
    try {
      const result = await shareProposalLink(dealId);
      // Until it's marked sent, the link only says the proposal is being
      // updated, so it shouldn't read as copied and ready to share.
      if (result.error) {
        setCopied(false);
        setCopyError(result.error);
        return;
      }
      router.refresh();
    } catch {
      setCopied(false);
      setCopyError("Couldn't mark it as sent. Try again.");
    }
  }

  async function handleCreate() {
    if (creating) return;
    setCreateError(null);
    setCreating(true);
    try {
      const result = await createContractFromProposalAction(dealId, templateId || undefined);
      if (result.error || !result.dealId) {
        setCreateError(result.error ?? "Couldn't make the contract. Try again.");
        setCreating(false);
        return;
      }
      // The new contract's screen, where any gaps are filled in on the paper.
      router.push(`/deals/${result.dealId}`);
    } catch {
      setCreateError("Couldn't make the contract. Try again.");
      setCreating(false);
    }
  }

  const body = (
    <>
      {showSend &&
        (ready ? (
          <Link href={`/deals/${dealId}/send`} className={`btn ${sent ? "btn-secondary" : "btn-primary"} w-full justify-center`}>
            {sent ? "Send again" : "Send by email"}
          </Link>
        ) : (
          <button type="button" disabled className="btn btn-primary w-full justify-center">
            Send by email
          </button>
        ))}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={handleCopy} disabled={!ready || copying || (!docId && !canMake)} aria-busy={copying || undefined} className="btn btn-secondary min-w-[120px] flex-1 justify-center">
          {copied ? "Copied" : "Copy link"}
        </button>
        {(docId || (canMake && ready)) && (
          <div className="min-w-[120px] flex-1">
            <DownloadContractButton
              contractId={docId}
              prepare={async () => {
                const made = await ensureDocument();
                if (made.contractId) router.refresh();
                return made;
              }}
              kind="proposal"
              className="btn btn-secondary w-full justify-center"
            />
          </div>
        )}
      </div>

      {sent && changedSinceSent && ready && (
        <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          You changed it after sending. They still see the version they got. Send it again, or copy the link to update what they see.
        </span>
      )}
      {!ready && notReadyHint && (
        <span className="text-center text-[12px]" style={{ color: "var(--ink-muted)" }}>
          {notReadyHint}
        </span>
      )}
      {manualLink && (
        <label className="flex flex-col gap-1">
          <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>Copy the link from here:</span>
          <input readOnly value={manualLink} onFocus={(e) => e.currentTarget.select()} className="input w-full min-w-0" style={{ fontSize: "12.5px", padding: "7px 10px" }} />
        </label>
      )}
      {copyError && (
        <span className="text-[11.5px]" style={{ color: "#c0392b" }}>{copyError}</span>
      )}

      <div className="mt-1 flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--hairline-soft)" }}>
        {derivedContractId ? (
          <Link href={`/deals/${derivedContractId}`} className="btn btn-secondary w-full justify-center">
            Open contract
          </Link>
        ) : contractTemplates.length === 0 ? (
          <Link href="/templates?kind=contract" className="btn btn-secondary w-full justify-center">
            Add a contract template first
          </Link>
        ) : (
          <>
            {contractTemplates.length > 1 && (
              <select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={creating}
                className="input w-full min-w-0"
                style={{ fontSize: "12.5px", padding: "7px 10px" }}
                aria-label="Contract template"
              >
                <option value="">Let SealMe pick the template</option>
                {contractTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            )}
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || createDisabled}
              className={`btn ${sent ? "btn-primary" : "btn-secondary"} w-full justify-center`}
            >
              {creating ? "Making the contract…" : "Create contract"}
            </button>
          </>
        )}
        {createError && (
          <span className="text-[11.5px]" style={{ color: "#c0392b" }}>{createError}</span>
        )}
      </div>
    </>
  );

  if (compact) return <div className="flex flex-col gap-2.5">{body}</div>;
  return (
    <div className="card flex flex-col gap-2.5 p-5">
      <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>
        Proposal
      </h2>
      {body}
    </div>
  );
}
