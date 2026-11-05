import { requireWorkspace } from "@/lib/workspace";
import { domainVerificationRecord } from "@/lib/domain-verification";
import { startDomainVerification, verifyAllowedDomain } from "@/app/(app)/settings/actions";
import AccessSettingsPanel from "@/components/AccessSettingsPanel";

// Reads the domain and its verification state itself (requireWorkspace is
// cached per request), so the settings page only passes what it always
// has; currentDomain is the same value. Shown to workspace admins only, so
// the token in the TXT record never reaches anyone else.
export default async function ScimSettingsPanel({
  hasScimToken,
  scimBaseUrl,
  updateDomainAction,
  generateTokenAction,
  revokeTokenAction,
}: {
  currentDomain: string | null;
  hasScimToken: boolean;
  scimBaseUrl: string;
  updateDomainAction: (formData: FormData) => Promise<void>;
  generateTokenAction: () => Promise<string>;
  revokeTokenAction: () => Promise<void>;
}) {
  const workspace = await requireWorkspace();
  const domain = workspace.allowedEmailDomain;
  const token = workspace.domainVerificationToken;

  return (
    <AccessSettingsPanel
      currentDomain={domain}
      verification={{
        verified: Boolean(domain && workspace.allowedEmailDomainVerifiedAt),
        record: domain && token ? { name: domain, value: domainVerificationRecord(token) } : null,
      }}
      ssoEnabled={workspace.ssoEnabled}
      hasScimToken={hasScimToken}
      scimBaseUrl={scimBaseUrl}
      updateDomainAction={updateDomainAction}
      startVerificationAction={startDomainVerification}
      verifyDomainAction={verifyAllowedDomain}
      generateTokenAction={generateTokenAction}
      revokeTokenAction={revokeTokenAction}
    />
  );
}
