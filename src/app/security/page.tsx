import Link from "next/link";

export const metadata = {
  title: "Security - SealMe",
  description: "How SealMe stores, protects and processes your data.",
};

const LAST_UPDATED = "October 16, 2026";

export default function SecurityPage() {
  return (
    <div style={{ background: "var(--canvas)", color: "var(--ink)" }} className="min-h-screen">
      <header className="sticky top-0 z-10" style={{ background: "rgba(9,9,9,0.8)", backdropFilter: "blur(10px)", borderBottom: "1px solid var(--hairline)" }}>
        <div className="mx-auto flex max-w-[820px] items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center">
            <img src="/logo-dark.png" alt="SealMe" className="h-[18px] w-auto" />
          </Link>
          <Link href="/" className="text-[13px]" style={{ color: "var(--ink-muted)" }}>← Back to home</Link>
        </div>
      </header>

      <main className="mx-auto max-w-[820px] px-6 py-16">
        <h1 className="mb-2 text-[36px] font-medium" style={{ letterSpacing: "-0.8px", color: "var(--primary)" }}>Security</h1>
        <p className="mb-12 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>Last updated: {LAST_UPDATED}</p>

        <div className="flex flex-col gap-10 text-[14.5px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>
          <Section title="Where your data lives">
            <p>
              SealMe runs on Vercel. Its database is Postgres on Neon, in AWS&apos;s us-east-1 region in the United States. Each company is its own workspace, and every request is checked against the workspace it belongs to.
            </p>
          </Section>

          <Section title="Encryption">
            <ul className="ml-5 flex list-disc flex-col gap-1.5">
              <li>All traffic is HTTPS, with HSTS so browsers never fall back to plain HTTP.</li>
              <li>The database is encrypted at rest by Neon.</li>
              <li>
                On top of that, SealMe encrypts the most sensitive values itself with AES-256-GCM before they reach the database: access tokens for HubSpot, Salesforce, DocuSign, Google and Slack, single sign-on client secrets, two-factor secrets and webhook signing secrets.
              </li>
              <li>Passwords are stored as scrypt hashes, and API keys and 2FA backup codes only as SHA-256 hashes, so none of them can be read back.</li>
            </ul>
          </Section>

          <Section title="Who can see what">
            <ul className="ml-5 flex list-disc flex-col gap-1.5">
              <li>Roles decide what each teammate can do; reps see their own deals and leads unless their role allows more.</li>
              <li>Single sign-on (OIDC) with Okta, Microsoft Entra ID or Google Workspace, and SCIM to add and remove people automatically.</li>
              <li>Two-factor authentication with an authenticator app, plus one-time backup codes.</li>
              <li>Sign-ups can be limited to your company&apos;s email domain.</li>
              <li>An audit log records sign-ins, sends, signatures, permission changes and integration changes, with who did it and when.</li>
            </ul>
          </Section>

          <Section title="Calls and AI">
            <p>
              To turn a sales call into a contract, call transcripts are sent to Anthropic (Claude), and recordings you upload or capture are transcribed by Deepgram. Both process the data under contract with SealMe and may not use it to train their models. Raw audio is kept only as long as transcription takes. See the <Link href="/privacy" style={{ color: "var(--accent-blue)" }}>Privacy Policy</Link> for the full detail.
            </p>
          </Section>

          <Section title="API, webhooks and integrations">
            <ul className="ml-5 flex list-disc flex-col gap-1.5">
              <li>API keys belong to one workspace, can be read-only, are rate-limited, and can be revoked one at a time.</li>
              <li>Webhooks are signed with HMAC-SHA256 and only sent to public https addresses; redirects aren&apos;t followed.</li>
              <li>A separate sandbox workspace lets you build an integration without touching real deals or clients.</li>
              <li>HubSpot, Salesforce, DocuSign, Google Calendar and Slack receive data only after an admin connects them, and only what that integration needs.</li>
            </ul>
            <p>
              Details are in the <Link href="/developers" style={{ color: "var(--accent-blue)" }}>API docs</Link>.
            </p>
          </Section>

          <Section title="Reliability">
            <p>
              Hosting and the database are managed services. Errors in production alert the team immediately, failed webhooks are retried for about a day, and the database can be restored to an earlier point in time. Uptime monitors can watch <code className="font-mono-tab">/api/health</code>.
            </p>
          </Section>

          <Section title="Service providers">
            <ul className="ml-5 flex list-disc flex-col gap-1.5">
              <li><strong style={{ color: "var(--ink)" }}>Vercel</strong>: hosting.</li>
              <li><strong style={{ color: "var(--ink)" }}>Neon</strong>: database.</li>
              <li><strong style={{ color: "var(--ink)" }}>Anthropic</strong>: reading deal terms and notes from calls.</li>
              <li><strong style={{ color: "var(--ink)" }}>Deepgram</strong>: transcribing recordings.</li>
              <li><strong style={{ color: "var(--ink)" }}>Resend</strong>: sending email, such as contracts to sign.</li>
              <li><strong style={{ color: "var(--ink)" }}>Telnyx</strong>: phone calls placed through SealMe, and their recordings until they&apos;re transcribed.</li>
              <li><strong style={{ color: "var(--ink)" }}>Recall.ai</strong>: the notetaker that joins Zoom and Google Meet calls when you invite it.</li>
              <li>Integrations you connect (Google, Slack, HubSpot, Salesforce, DocuSign) act on your instructions.</li>
            </ul>
          </Section>

          <Section title="Reporting a security issue">
            <p>
              Found something? Email <a href="mailto:ivan@sealme.net" style={{ color: "var(--accent-blue)" }}>ivan@sealme.net</a> with the details. We&apos;ll confirm we got it and keep you posted while we fix it.
            </p>
          </Section>
        </div>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[19px] font-medium" style={{ letterSpacing: "-0.3px", color: "var(--ink)" }}>{title}</h2>
      {children}
    </section>
  );
}
