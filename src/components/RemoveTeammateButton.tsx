"use client";

import { useState, useTransition } from "react";

// Calls removeAction from a click handler rather than a plain
// `<form action>`, so a refusal like "the only teammate who can manage the
// team" shows up here instead of as a generic error page. Same reasoning as
// InviteTeammateForm.
export default function RemoveTeammateButton({
  userId,
  removeAction,
}: {
  userId: string;
  removeAction: (userId: string) => Promise<{ error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await removeAction(userId);
        if (result.error) setError(result.error);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" disabled={isPending} onClick={handleClick} className="text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>
        {isPending ? "Removing…" : "Remove"}
      </button>
      {error && (
        <span className="max-w-[220px] text-right text-[11px]" style={{ color: "#c0392b" }}>
          {error}
        </span>
      )}
    </div>
  );
}
