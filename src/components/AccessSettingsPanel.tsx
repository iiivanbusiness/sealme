"use client";

import { useState, useTransition } from "react";

export type DomainVerificationState = {
  // The TXT record to add, once the domain has a token.
  record: { name: string; value: string } | null;
  verified: boolean;
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11.5px] font-medium uppercase tracking-wide" style={{ color: "var(--ink-muted)" }}>{label}</span>
      <span className="flex items-center gap-2">
        <input
          readOnly
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
          className="input min-w-0 flex-1 font-mono-tab"
          style={{ fontSize: "12px", padding: "7px 10px" }}
        />
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="btn btn-secondary btn-sm flex-none"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </label>
  );
}

// Keyed by the domain, so a message about the old one goes when it changes.
function DomainVerificationBox({
  domain,
  verification,
  startVerificationAction,
  verifyDomainAction,
}: {
  domain: string;
  verification: DomainVerificationState;
  startVerificationAction: () => Promise<{ error?: string }>;
  verifyDomainAction: () => Promise<{ error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ error?: string }>) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.error) setError(result.error);
      } catch {
        setError("Something went wrong. Try again");
      }
    });
  }

  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-[12px] border p-3.5" style={{ borderColor: "var(--hairline)" }}>
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 break-all text-[12.5px] font-medium">{domain}</span>
        <span className={`chip flex-none ${verification.verified ? "chip-success" : "chip-neutral"}`}>
          {verification.verified ? "Verified" : "Not verified"}
        </span>
      </div>

      {verification.verified ? (
        <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
          Single sign-on and SCIM can add people with @{domain} addresses to this workspace. Keep the TXT record in place.
        </div>
      ) : verification.record ? (
        <>
          <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Add a <span className="font-mono-tab">TXT</span> record at your DNS provider (where you manage {domain}), then click Verify. Some providers want @ instead of the domain as the name.
          </div>
          <CopyField label="Name" value={verification.record.name} />
          <CopyField label="Value" value={verification.record.value} />
          {error && <div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>}
          <button type="button" disabled={isPending} onClick={() => run(verifyDomainAction)} className="btn btn-primary btn-sm self-start">
            {isPending ? "Checking..." : "Verify"}
          </button>
        </>
      ) : (
        <>
          <div className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Verify you own {domain} with a DNS record before single sign-on and SCIM can use it.
          </div>
          {error && <div className="chip chip-warn max-w-full whitespace-normal break-words px-3 py-2 text-[12.5px]">{error}</div>}
          <button type="button" disabled={isPending} onClick={() => run(startVerificationAction)} className="btn btn-secondary btn-sm self-start">
            Get the DNS record
          </button>
        </>
      )}
    </div>
  );
}

export default function AccessSettingsPanel({
  currentDomain,
  verification,
  ssoEnabled,
  hasScimToken,
  scimBaseUrl,
  updateDomainAction,
  startVerificationAction,
  verifyDomainAction,
  generateTokenAction,
  revokeTokenAction,
}: {
  currentDomain: string | null;
  verification: DomainVerificationState;
  ssoEnabled: boolean;
  hasScimToken: boolean;
  scimBaseUrl: string;
  updateDomainAction: (formData: FormData) => Promise<void>;
  startVerificationAction: () => Promise<{ error?: string }>;
  verifyDomainAction: () => Promise<{ error?: string }>;
  generateTokenAction: () => Promise<string>;
  revokeTokenAction: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleGenerate() {
    setError(null);
    startTransition(async () => {
      try {
        const token = await generateTokenAction();
        setFreshToken(token);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  function handleRevoke() {
    setError(null);
    startTransition(async () => {
      try {
        await revokeTokenAction();
        setFreshToken(null);
        setConfirmingRevoke(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    });
  }

  return (
    <div className="flex flex-col gap-[18px] px-[22px] py-[18px]">
      {error && (
        <div className="rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          {error}
        </div>
      )}

      <div>
        <div className="text-[13.5px] font-medium">Restrict sign-ups to a domain</div>
        <div className="mb-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>
          Only @this-domain email addresses can be invited or provisioned once set. Single sign-on and SCIM also need you to verify you own it.
        </div>
        <form action={updateDomainAction} className="flex gap-2">
          <input name="domain" defaultValue={currentDomain ?? ""} placeholder="yourcompany.com" className="input min-w-0 flex-1" style={{ fontSize: "13px", padding: "8px 11px" }} />
          <button type="submit" className="btn btn-secondary btn-sm">Save</button>
        </form>
        {ssoEnabled && currentDomain && (
          <div className="mt-1.5 text-[11.5px]" style={{ color: "var(--ink-muted)" }}>
            Changing the domain turns single sign-on off until the new one is verified.
          </div>
        )}

        {currentDomain && (
          <DomainVerificationBox
            key={currentDomain}
            domain={currentDomain}
            verification={verification}
            startVerificationAction={startVerificationAction}
            verifyDomainAction={verifyDomainAction}
          />
        )}
      </div>

      <div className="border-t pt-[18px]" style={{ borderColor: "var(--hairline-soft)" }}>
        <div className="text-[13.5px] font-medium">SCIM provisioning</div>
        <div className="mb-2 text-[12px]" style={{ color: "var(--ink-muted)" }}>
          Point your identity provider&apos;s SCIM connector (Okta, Azure AD/Entra) here to auto-create and auto-deactivate teammates.
          {!verification.verified && " Until the domain above is verified, it can update and deactivate teammates already here, but not add new ones."}
        </div>

        <div className="mb-2.5 rounded-[8px] px-3 py-2.5 text-[12px]" style={{ background: "var(--surface-2)", wordBreak: "break-all" }}>
          {scimBaseUrl}
        </div>

        {freshToken ? (
          <div className="mb-2.5 flex flex-col gap-1.5">
            <div className="rounded-[8px] px-3 py-2.5 font-mono-tab text-[12px]" style={{ background: "var(--surface-2)", wordBreak: "break-all" }}>
              {freshToken}
            </div>
            <div className="text-[11.5px]" style={{ color: "var(--warn)" }}>
              ⚠ Copy this now. It won&apos;t be shown again.
            </div>
          </div>
        ) : (
          <div className="mb-2.5 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
            {hasScimToken ? "A token is set (hidden after generation)." : "No token generated yet."}
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" disabled={isPending} onClick={handleGenerate} className="btn btn-secondary btn-sm">
            {hasScimToken ? "Regenerate token" : "Generate token"}
          </button>
          {hasScimToken && (
            confirmingRevoke ? (
              <span className="flex items-center gap-2">
                <button type="button" disabled={isPending} onClick={handleRevoke} className="text-[12px] font-medium" style={{ color: "#c0392b" }}>
                  Confirm revoke
                </button>
                <button type="button" onClick={() => setConfirmingRevoke(false)} className="text-[12px]" style={{ color: "var(--ink-muted)" }}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmingRevoke(true)} className="text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>
                Revoke
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
