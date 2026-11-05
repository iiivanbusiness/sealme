"use client";

import { useState, useTransition } from "react";
import type { HubspotStagesState } from "@/app/(app)/settings/hubspot-stage-actions";

type Result = Promise<{ error?: string }>;

const errorStyle = { background: "var(--surface-2)", color: "#c0392b" };
const selectStyle = { fontSize: "12.5px", padding: "7px 10px" };

export default function HubspotSettingsPanel({
  connected,
  portalId,
  enabled,
  connectAction,
  toggleAction,
  disconnectAction,
  stagesOn = false,
  loadStagesAction,
  saveStagesAction,
}: {
  connected: boolean;
  portalId: string | null;
  enabled: boolean;
  connectAction: (formData: FormData) => Result;
  toggleAction: () => Result;
  disconnectAction: () => Result;
  // Whether deals are moved between stages (a pipeline is saved), and the
  // actions that read the portal's pipelines and save the choice.
  stagesOn?: boolean;
  loadStagesAction?: () => Promise<HubspotStagesState | { error: string }>;
  saveStagesAction?: (formData: FormData) => Result;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(fn: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.error) setError(result.error);
    });
  }

  if (!connected) {
    return (
      <div className="flex flex-col gap-2.5 px-[22px] py-[18px]">
        {error && (
          <div className="rounded-[8px] px-3 py-2 text-[12.5px]" style={errorStyle}>
            {error}
          </div>
        )}
        <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          In HubSpot: <strong>Development → Legacy Apps → Create legacy app (private)</strong>. Give it the contacts and deals
          read and write scopes, plus owners read and contacts schema read for bringing leads in, then paste its access token
          from the <strong>Auth</strong> tab here.
        </div>
        <form action={(formData) => run(() => connectAction(formData))} className="flex items-center gap-2">
          <input
            name="token"
            type="password"
            required
            placeholder="pat-..."
            className="input flex-1 font-mono-tab"
            style={{ fontSize: "12.5px", padding: "7px 10px" }}
          />
          <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm flex-none">Connect</button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-[22px] py-[18px]">
      {error && (
        <div className="rounded-[8px] px-3 py-2 text-[12.5px]" style={errorStyle}>
          {error}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div className="text-[12.5px]">
          Connected to portal <span className="font-medium">{portalId}</span>
        </div>
        <button type="button" disabled={isPending} onClick={() => run(toggleAction)} className={`btn btn-sm flex-none ${enabled ? "btn-secondary" : "btn-primary"}`}>
          {enabled ? "Pause" : "Resume"}
        </button>
      </div>

      {loadStagesAction && saveStagesAction && <DealStages on={stagesOn} loadAction={loadStagesAction} saveAction={saveStagesAction} />}

      <button type="button" disabled={isPending} onClick={() => run(disconnectAction)} className="self-start text-[11.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
        Disconnect HubSpot
      </button>
    </div>
  );
}

// Off by default: deals go to HubSpot without a stage. The pipelines are
// only read from HubSpot when the admin opens the picker, and picking a
// pipeline pre-selects its usual "Contract sent" and "Closed won" stages.
function DealStages({
  on,
  loadAction,
  saveAction,
}: {
  on: boolean;
  loadAction: () => Promise<HubspotStagesState | { error: string }>;
  saveAction: (formData: FormData) => Result;
}) {
  const [state, setState] = useState<HubspotStagesState | null>(null);
  const [open, setOpen] = useState(false);
  const [pipelineId, setPipelineId] = useState("");
  const [sentStageId, setSentStageId] = useState("");
  const [signedStageId, setSignedStageId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function openPicker() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await loadAction();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // A pipeline or stage deleted in HubSpot since it was saved starts
      // out unpicked rather than as an option that isn't there.
      const pipeline = result.pipelines.find((p) => p.id === result.pipelineId);
      const known = (id: string) => (pipeline?.stages.some((s) => s.id === id) ? id : "");
      setState(result);
      setPipelineId(pipeline?.id ?? "");
      setSentStageId(known(result.sentStageId));
      setSignedStageId(known(result.signedStageId));
      setOpen(true);
    });
  }

  function choosePipeline(id: string) {
    const pipeline = state?.pipelines.find((p) => p.id === id);
    setPipelineId(id);
    setSentStageId(pipeline?.suggestedSent ?? "");
    setSignedStageId(pipeline?.suggestedSigned ?? "");
  }

  function save(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await saveAction(formData);
      if (result.error) setError(result.error);
      else {
        setOpen(false);
        setSaved(true);
      }
    });
  }

  const stages = state?.pipelines.find((p) => p.id === pipelineId)?.stages ?? [];

  return (
    <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--hairline)" }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium">Deal stages</div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            {on ? "Each deal moves to the stages you picked when its contract is sent and when it's signed." : "Deals keep whatever stage HubSpot gives them."}
          </div>
        </div>
        {!open && (
          <button type="button" disabled={isPending} onClick={openPicker} className="btn btn-secondary btn-sm flex-none">
            {isPending ? "Loading…" : on ? "Change" : "Choose stages"}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-[8px] px-3 py-2 text-[12.5px]" style={errorStyle}>
          {error}
        </div>
      )}
      {saved && !open && <span className="text-[11.5px]" style={{ color: "var(--success)" }}>Saved</span>}

      {open && state && (
        <form action={save} className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Pipeline
            <select name="pipeline" value={pipelineId} onChange={(e) => choosePipeline(e.target.value)} className="input min-w-0" style={selectStyle}>
              <option value="">Don&apos;t move deals between stages</option>
              {state.pipelines.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {pipelineId && (
            <>
              <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--ink-muted)" }}>
                When the contract is sent
                <select name="sentStage" value={sentStageId} onChange={(e) => setSentStageId(e.target.value)} className="input min-w-0" style={selectStyle}>
                  <option value="">Leave the stage as it is</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--ink-muted)" }}>
                When it&apos;s signed
                <select name="signedStage" value={signedStageId} onChange={(e) => setSignedStageId(e.target.value)} className="input min-w-0" style={selectStyle}>
                  <option value="">Leave the stage as it is</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <div className="flex items-center gap-2">
            <button type="submit" disabled={isPending} className="btn btn-secondary btn-sm flex-none">
              {isPending ? "Saving…" : "Save"}
            </button>
            <button type="button" disabled={isPending} onClick={() => setOpen(false)} className="text-[11.5px] font-medium" style={{ color: "var(--ink-muted)" }}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
