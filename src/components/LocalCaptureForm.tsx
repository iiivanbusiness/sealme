"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { startLocalCapture } from "@/app/(app)/deals/new/actions";
import { useInDesktopApp } from "@/lib/native-shell";

type Template = { id: string; name: string };

export const LOCAL_CAPTURE_STORAGE_KEY = "sealme:local-capture";
// AppShell (and the banner inside it) is a persistent layout — it doesn't
// remount on client-side navigation, so a plain mount-time localStorage read
// in the banner would never notice a session that starts after the app's
// first page load. This event tells it to re-check right away instead.
export const LOCAL_CAPTURE_EVENT = "sealme:local-capture-changed";

export default function LocalCaptureForm({ templates }: { templates: Template[] }) {
  const router = useRouter();
  const isTauri = useInDesktopApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);


  async function handleSubmit(formData: FormData) {
    setBusy(true);
    setError(null);

    const { invoke } = await import("@tauri-apps/api/core");

    try {
      await invoke("start_local_capture");
    } catch (err) {
      setError(typeof err === "string" ? err : "Couldn't start capture. Check your microphone and screen-recording permissions");
      setBusy(false);
      return;
    }

    try {
      const result = await startLocalCapture(formData);
      if ("error" in result) {
        await invoke("discard_local_capture").catch(() => {});
        setError(result.error);
        setBusy(false);
        return;
      }
      // Deal terms fill in live while the call is still going, same as the
      // Recall bot flow — starts a background loop that uploads a chunk of
      // the recording every minute or so.
      await invoke("begin_live_updates", { token: result.token });

      localStorage.setItem(
        LOCAL_CAPTURE_STORAGE_KEY,
        JSON.stringify({ dealId: result.dealId, token: result.token, startedAt: Date.now() })
      );
      window.dispatchEvent(new Event(LOCAL_CAPTURE_EVENT));
      router.push(`/deals/${result.dealId}`);
    } catch (err) {
      await invoke("discard_local_capture").catch(() => {});
      setError(err instanceof Error ? err.message : "Couldn't start recording");
      setBusy(false);
    }
  }

  if (isTauri === null) return null;

  if (!isTauri) {
    return (
      <div className="card max-w-[560px] p-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
        Recording locally only works inside the SealMe desktop app.{" "}
        <Link href="/deals/new" className="font-medium" style={{ color: "var(--accent-blue)" }}>
          Paste a transcript
        </Link>{" "}
        here instead.
      </div>
    );
  }

  return (
    <form action={handleSubmit} className="card flex max-w-[560px] flex-col gap-4 p-6">
      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Who are you meeting with?</span>
        <input name="clientName" placeholder="Northgate Fitness" required className="input" />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Client email <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(optional)</span></span>
        <input name="clientEmail" type="email" placeholder="hello@client.com" className="input" />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Template</span>
        <select name="templateId" required className="input">
          <option value="" style={{ background: "var(--surface-1)" }}>
            Choose a template
          </option>
          {templates.map((t) => (
            <option key={t.id} value={t.id} style={{ background: "var(--surface-1)" }}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      {error && <div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>}

      <button type="submit" disabled={busy} className="btn btn-primary mt-2 w-full justify-center">
        {busy ? "Starting…" : "Start recording"}
      </button>
      <span className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
        SealMe records your system audio for this call. Nothing joins the meeting. Stop the recording from the banner
        at the top once the call ends.
      </span>
    </form>
  );
}
