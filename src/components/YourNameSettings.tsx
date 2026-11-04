"use client";

import { useState, useTransition } from "react";
import { updateMyName } from "@/app/(app)/settings/account-actions";

export default function YourNameSettings({ name }: { name: string }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateMyName(formData);
      if (result.error) setError(result.error);
      else setSaved(true);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input name="name" defaultValue={name} required maxLength={100} className="input min-w-0 flex-1" style={{ fontSize: "13px", padding: "8px 11px" }} />
        <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm flex-none">
          {isPending ? "Saving…" : "Save"}
        </button>
      </div>
      {error && <div className="chip chip-warn max-w-full break-words px-3 py-2 text-[12.5px]" style={{ whiteSpace: "normal" }}>{error}</div>}
      {saved && !error && (
        <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          Saved. Teammates see this name on deals, tasks and leads.
        </div>
      )}
    </form>
  );
}
