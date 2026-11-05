"use client";

import { useState, useTransition } from "react";

export default function SsoSettingsForm({
  ssoEnabled,
  domain,
  domainVerified,
  currentIssuer,
  currentClientId,
  hasClientSecret,
  redirectUri,
  updateConfigAction,
  toggleAction,
}: {
  ssoEnabled: boolean;
  domain: string | null;
  domainVerified: boolean;
  currentIssuer: string | null;
  currentClientId: string | null;
  hasClientSecret: boolean;
  redirectUri: string;
  updateConfigAction: (formData: FormData) => Promise<void>;
  toggleAction: () => Promise<{ error?: string }>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleToggle() {
    setError(null);
    startTransition(async () => {
      const result = await toggleAction();
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-[18px] px-[22px] py-[18px]">
      {error && (
        <div className="rounded-[8px] px-3 py-2 text-[12.5px]" style={{ background: "var(--surface-2)", color: "#c0392b" }}>
          {error}
        </div>
      )}

      {ssoEnabled && !domainVerified && (
        <div className="rounded-[8px] px-3 py-2.5 text-[12.5px]" style={{ background: "var(--warn-soft)", color: "var(--warn)" }} role="status">
          Verify {domain ?? "your email domain"} under Access &amp; provisioning above. Until you do, only teammates already on this workspace can sign in with SSO, and new people at your company can&apos;t join through it.
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[13.5px] font-medium">Single sign-on (OIDC)</div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--ink-muted)" }}>
            Let teammates sign in through your identity provider (Okta, Azure AD/Entra, Google Workspace) instead of a password.
            {domainVerified
              ? ` People at @${domain} that your provider lets in get an account the first time they sign in.`
              : !ssoEnabled && " Verify your email domain above to turn it on."}
          </div>
        </div>
        <button
          type="button"
          disabled={isPending || (!ssoEnabled && !domainVerified)}
          title={!ssoEnabled && !domainVerified ? "Verify your email domain first" : undefined}
          onClick={handleToggle}
          className={`btn btn-sm flex-none ${ssoEnabled ? "btn-secondary" : "btn-primary"}`}
        >
          {ssoEnabled ? "Disable" : "Enable"}
        </button>
      </div>

      <div>
        <div className="mb-1.5 text-[12px] font-medium" style={{ color: "var(--ink-muted)" }}>
          Redirect URI. Give this to your identity provider
        </div>
        <div className="rounded-[8px] px-3 py-2.5 font-mono-tab text-[12px]" style={{ background: "var(--surface-2)", wordBreak: "break-all" }}>
          {redirectUri}
        </div>
      </div>

      <form action={updateConfigAction} className="flex flex-col gap-3 border-t pt-[18px]" style={{ borderColor: "var(--hairline-soft)" }}>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium">Issuer URL</span>
          <input
            name="issuer"
            defaultValue={currentIssuer ?? ""}
            placeholder="https://mycompany.okta.com"
            className="input"
            style={{ fontSize: "13px", padding: "8px 11px" }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium">Client ID</span>
          <input
            name="clientId"
            defaultValue={currentClientId ?? ""}
            placeholder="0oa1b2c3d4e5f6g7h8i9"
            className="input"
            style={{ fontSize: "13px", padding: "8px 11px" }}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-medium">
            Client secret {hasClientSecret && <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(set. Leave blank to keep it)</span>}
          </span>
          <input
            name="clientSecret"
            type="password"
            placeholder={hasClientSecret ? "••••••••••••••••" : "paste client secret"}
            className="input"
            style={{ fontSize: "13px", padding: "8px 11px" }}
          />
        </label>
        <button type="submit" className="btn btn-secondary btn-sm self-start">Save</button>
      </form>
    </div>
  );
}
