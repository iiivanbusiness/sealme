"use client";

import { useState } from "react";
import {
  startTwoFactorSetup,
  confirmTwoFactorSetup,
  disableTwoFactor,
  regenerateBackupCodes,
} from "@/app/(app)/settings/two-factor-actions";

type Mode = "idle" | "setup" | "backup-codes" | "disable" | "regenerate";

export default function TwoFactorSettings({ enabled }: { enabled: boolean }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [qr, setQr] = useState<{ qrCodeDataUrl: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [isEnabled, setIsEnabled] = useState(enabled);

  async function handleStart() {
    setBusy(true);
    setError(null);
    try {
      const result = await startTwoFactorSetup();
      setQr(result);
      setMode("setup");
    } catch {
      setError("Couldn't start setup. Try again");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirm(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await confirmTwoFactorSetup(formData);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.backupCodes) {
      setBackupCodes(result.backupCodes);
      setIsEnabled(true);
      setMode("backup-codes");
    }
  }

  async function handleDisable(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await disableTwoFactor(formData);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    setIsEnabled(false);
    setMode("idle");
    setQr(null);
  }

  async function handleRegenerate(formData: FormData) {
    setBusy(true);
    setError(null);
    const result = await regenerateBackupCodes(formData);
    setBusy(false);
    if (result.error) {
      setError(result.error);
      return;
    }
    if (result.backupCodes) {
      setBackupCodes(result.backupCodes);
      setMode("backup-codes");
    }
  }

  if (mode === "backup-codes" && backupCodes) {
    return (
      <div className="flex flex-col gap-3">
        <div className="chip chip-success w-fit px-4 py-2.5 text-[13px]">✓ Two-factor authentication is on</div>
        <div className="text-[13px] font-medium">Save these backup codes</div>
        <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          Each one works once, if you ever lose access to your authenticator app. Store them somewhere safe. This is the only time they&apos;re shown.
        </p>
        <div className="font-mono-tab grid grid-cols-2 gap-2 rounded-[10px] p-4 text-[13px]" style={{ background: "var(--surface-2)" }}>
          {backupCodes.map((code) => (
            <div key={code}>{code}</div>
          ))}
        </div>
        <button
          type="button"
          className="btn btn-primary btn-sm w-fit"
          onClick={() => {
            setMode("idle");
            setBackupCodes(null);
          }}
        >
          I&apos;ve saved these
        </button>
      </div>
    );
  }

  if (mode === "setup" && qr) {
    return (
      <form
        action={handleConfirm}
        className="flex flex-col gap-3"
      >
        <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          Scan this with Google Authenticator, 1Password, or any TOTP app, then enter the 6-digit code it shows and your password. Once it&apos;s on, you stay signed in here and every other device is signed out.
        </p>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={qr.qrCodeDataUrl} alt="2FA setup QR code" width={180} height={180} className="rounded-[10px]" style={{ border: "1px solid var(--hairline)" }} />
        <div className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
          Can&apos;t scan? Enter this key manually: <span className="font-mono-tab">{qr.secret}</span>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">6-digit code</span>
          <input name="code" required inputMode="numeric" maxLength={6} placeholder="123456" className="input" style={{ maxWidth: 160 }} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium">Current password</span>
          <input name="password" type="password" required autoComplete="current-password" className="input" style={{ maxWidth: 260 }} />
        </label>
        {error &&<div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="btn btn-primary btn-sm">
            {busy ? "Confirming…" : "Confirm & enable"}
          </button>
          <button
            type="button"
            className="text-[12.5px] font-medium"
            style={{ color: "var(--ink-muted)" }}
            onClick={() => {
              setMode("idle");
              setQr(null);
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (mode === "disable") {
    return (
      <form action={handleDisable} className="flex flex-col gap-3">
        <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          Confirm your password to turn off two-factor authentication. You stay signed in here, and every other device is signed out.
        </p>
        <input name="password" type="password" required placeholder="Current password" className="input" style={{ maxWidth: 260 }} />
        {error && <div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
            {busy ? "Disabling…" : "Disable 2FA"}
          </button>
          <button
            type="button"
            className="text-[12.5px] font-medium"
            style={{ color: "var(--ink-muted)" }}
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (mode === "regenerate") {
    return (
      <form action={handleRegenerate} className="flex flex-col gap-3">
        <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          Confirm your password to generate a fresh set of backup codes. Your old ones stop working.
        </p>
        <input name="password" type="password" required placeholder="Current password" className="input" style={{ maxWidth: 260 }} />
        {error && <div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>}
        <div className="flex gap-2">
          <button type="submit" disabled={busy} className="btn btn-secondary btn-sm">
            {busy ? "Generating…" : "Generate new codes"}
          </button>
          <button
            type="button"
            className="text-[12.5px] font-medium"
            style={{ color: "var(--ink-muted)" }}
            onClick={() => {
              setMode("idle");
              setError(null);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {isEnabled ? (
        <>
          <div className="chip chip-success w-fit px-4 py-2.5 text-[13px]">✓ Two-factor authentication is on</div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode("regenerate")}>
              New backup codes
            </button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMode("disable")}>
              Disable
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            Require a code from an authenticator app in addition to your password when signing in.
          </p>
          <button type="button" disabled={busy} onClick={handleStart} className="btn btn-primary btn-sm w-fit">
            {busy ? "Starting…" : "Enable 2FA"}
          </button>
        </>
      )}
      {error && mode === "idle" && <div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>}
    </div>
  );
}
