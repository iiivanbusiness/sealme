"use client";

import { useState } from "react";
import { deleteMyAccount } from "@/app/(app)/settings/account-actions";

// onlyTeamManager: nobody else on the workspace can manage the team, so
// deleteMyAccount refuses until someone can. Said up front here.
export default function DeleteAccountSettings({ hasPassword, onlyTeamManager = false }: { hasPassword: boolean; onlyTeamManager?: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDelete(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await deleteMyAccount(formData);
    setBusy(false);
    if (result?.error) setError(result.error);
    // On success the action redirects via signOut() — nothing left to do here.
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          Permanently deletes your name, email, and password from your account. Deals, contracts, and other workspace
          records you created stay in place for your team, the same as when a teammate leaves.
        </p>
        {onlyTeamManager && (
          <div className="chip chip-warn max-w-full break-words px-3 py-2 text-[12.5px]" style={{ whiteSpace: "normal" }}>
            You&apos;re the only one who can manage this team. Give a teammate that access before you delete your account.
          </div>
        )}
        <button type="button" disabled={onlyTeamManager} className="btn btn-secondary btn-sm w-fit" onClick={() => setConfirming(true)}>
          Delete my account
        </button>
      </div>
    );
  }

  return (
    <form action={handleDelete} className="flex flex-col gap-3">
      <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
        This can&apos;t be undone. Type <span className="font-mono-tab">delete</span> to confirm
        {hasPassword ? " and enter your password." : "."}
      </p>
      <input name="confirmation" required placeholder='Type "delete"' className="input" style={{ maxWidth: 260 }} />
      {hasPassword && <input name="password" type="password" required placeholder="Current password" className="input" style={{ maxWidth: 260 }} />}
      {error && <div className="chip chip-warn max-w-full break-words px-3 py-2 text-[12.5px]" style={{ whiteSpace: "normal" }}>{error}</div>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
          {busy ? "Deleting…" : "Permanently delete my account"}
        </button>
        <button
          type="button"
          className="text-[12.5px] font-medium"
          style={{ color: "var(--ink-muted)" }}
          onClick={() => {
            setConfirming(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
