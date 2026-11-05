import { requireWorkspace } from "@/lib/workspace";
import SsoSettingsForm from "@/components/SsoSettingsForm";

// Reads whether the workspace has verified its email domain itself
// (requireWorkspace is cached per request), so the settings page only
// passes what it always has. SSO can only be turned on for a verified
// domain; a workspace that turned it on before that was required sees a
// banner asking it to verify.
export default async function SsoSettingsPanel(props: {
  ssoEnabled: boolean;
  currentIssuer: string | null;
  currentClientId: string | null;
  hasClientSecret: boolean;
  redirectUri: string;
  updateConfigAction: (formData: FormData) => Promise<void>;
  toggleAction: () => Promise<{ error?: string }>;
}) {
  const workspace = await requireWorkspace();
  return (
    <SsoSettingsForm
      {...props}
      domain={workspace.allowedEmailDomain}
      domainVerified={Boolean(workspace.allowedEmailDomain && workspace.allowedEmailDomainVerifiedAt)}
    />
  );
}
