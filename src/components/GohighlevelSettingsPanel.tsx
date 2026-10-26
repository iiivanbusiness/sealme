"use client";

import { useState, useTransition } from "react";
import type { GhlPipeline } from "@/lib/gohighlevel";

type Result = Promise<{ error?: string }>;

export default function GohighlevelSettingsPanel({
  connected,
  locationId,
  enabled,
  pipelines,
  pipelinesError,
  selected,
  connectAction,
  setPipelineAction,
  toggleAction,
  disconnectAction,
}: {
  connected: boolean;
  locationId: string | null;
  enabled: boolean;
  pipelines: GhlPipeline[];
  pipelinesError: string | null;
  // "pipelineId:stageId", or "" for none.
  selected: string;
  connectAction: (formData: FormData) => Result;
  setPipelineAction: (formData: FormData) => Result;
  toggleAction: () => Result;
  disconnectAction: () => Result;
}) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Result, after?: () => void) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
      else after?.();
    });
  }

  const errorBox = error && (
    <div className="rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
      {error}
    </div>
  );

  if (!connected) {
    return (
      <div className="flex flex-col gap-2.5 px-[22px] py-[18px]">
        {errorBox}
        <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          In the GoHighLevel sub-account: <strong>Settings → Private Integrations → Create new integration</strong>. Give it the contacts
          (view and edit) and opportunities (view and edit) scopes and paste the token here. The <strong>Location ID</strong> is in Settings →
          Business Profile, and in the browser address after <span className="font-mono-tab">/location/</span>.
        </div>
        <form action={(formData) => run(() => connectAction(formData))} className="flex flex-col gap-2">
          <input name="token" type="password" required placeholder="pit-..." className="input font-mono-tab" style={{ fontSize: "12.5px", padding: "7px 10px" }} />
          <div className="flex items-center gap-2">
            <input name="locationId" required placeholder="Location ID" className="input flex-1 font-mono-tab" style={{ fontSize: "12.5px", padding: "7px 10px" }} />
            <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm flex-none">
              {isPending ? "Checking…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-[22px] py-[18px]">
      {errorBox}

      <div className="flex items-center justify-between gap-4">
        <div className="text-[12.5px]">
          Connected to sub-account <span className="font-mono-tab font-medium">{locationId}</span>
        </div>
        <button type="button" disabled={isPending} onClick={() => run(toggleAction)} className={`btn btn-sm flex-none ${enabled ? "btn-secondary" : "btn-primary"}`}>
          {enabled ? "Pause" : "Resume"}
        </button>
      </div>

      <form action={(formData) => run(() => setPipelineAction(formData), () => setSaved(true))} className="flex flex-col gap-1.5">
        <label className="text-[12px]" style={{ color: "var(--ink-muted)" }} htmlFor="ghl-stage">
          Open an opportunity for each new lead in
        </label>
        <div className="flex items-center gap-2">
          <select id="ghl-stage" name="stage" defaultValue={selected} className="input min-w-0 flex-1" style={{ fontSize: "12.5px", padding: "7px 10px" }}>
            <option value="">No opportunities, just notes and tasks</option>
            {pipelines.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.stages.map((s) => (
                  <option key={s.id} value={`${p.id}:${s.id}`}>
                    {p.name}: {s.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm flex-none">
            Save
          </button>
        </div>
        {pipelinesError && <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>{pipelinesError}</span>}
        {saved && <span className="text-[11.5px]" style={{ color: "var(--success)" }}>Saved</span>}
      </form>

      <div className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
        After each call, the contact gets the call notes as a note and the next step as a task.
      </div>

      <button type="button" disabled={isPending} onClick={() => run(disconnectAction)} className="self-start text-[11.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
        Disconnect GoHighLevel
      </button>
    </div>
  );
}
