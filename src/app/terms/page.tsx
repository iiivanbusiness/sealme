import Link from "next/link";

export const metadata = {
  title: "Terms of Service - SealMe",
};

const LAST_UPDATED = "October 7, 2026";

export default function TermsPage() {
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
        <h1 className="mb-2 text-[36px] font-medium" style={{ letterSpacing: "-0.8px", color: "var(--primary)" }}>Terms of Service</h1>
        <p className="mb-12 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>Last updated: {LAST_UPDATED}</p>

        <div className="flex flex-col gap-10 text-[14.5px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>
          <Section title="1. Agreement to Terms">
            <p>
              These Terms of Service (&quot;Terms&quot;) govern your access to and use of SealMe (&quot;SealMe,&quot; &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;), including our
              website, AI call companion, contract generation tools, e-signature features, and related services (collectively, the &quot;Service&quot;). By creating an
              account or using the Service, you agree to be bound by these Terms. If you are using the Service on behalf of an organization, you represent that
              you have the authority to bind that organization.
            </p>
          </Section>

          <Section title="2. Description of Service">
            <p>
              SealMe provides a companion tool that joins alongside your sales calls (via Zoom, Google Meet, or similar platforms), listens to the conversation,
              extracts deal terms in real time, drafts a contract from your templates, and routes the finished document for electronic signature. SealMe does not
              participate in calls as a visible attendee; it operates as a background overlay or connected integration.
            </p>
          </Section>

          <Section title="3. Call Recording and Consent">
            <p>
              SealMe processes live audio from sales calls in order to capture deal terms. <strong style={{ color: "var(--ink)" }}>You are solely responsible for
              obtaining any consent required by law before recording or processing a call</strong>. Including two-party/all-party consent requirements in
              certain jurisdictions (e.g., several U.S. states) and equivalent requirements under EU, UK, or other applicable law. We recommend notifying every
              participant at the start of a call that it is being processed by SealMe. SealMe is not liable for your failure to obtain required consent.
            </p>
          </Section>

          <Section title="4. Accounts and Workspaces">
            <p>
              You must provide accurate information when creating an account and are responsible for maintaining the confidentiality of your login credentials
              and for all activity under your account. A workspace administrator may invite, manage, and remove other users within their organization&apos;s
              workspace.
            </p>
          </Section>

          <Section title="5. Acceptable Use">
            <p>You agree not to use the Service to:</p>
            <ul className="ml-5 mt-2 flex list-disc flex-col gap-1.5">
              <li>Record or process a call without a lawful basis or required consent;</li>
              <li>Upload or generate content that is unlawful, fraudulent, or infringes on the rights of others;</li>
              <li>Reverse-engineer, resell, or white-label the Service without written permission;</li>
              <li>Interfere with or disrupt the integrity or performance of the Service;</li>
              <li>Use the Service to draft or send contracts you do not have authority to issue.</li>
            </ul>
          </Section>

          <Section title="6. Your Content and Data Ownership">
            <p>
              You retain ownership of the call data, deal terms, templates, and contracts you submit to or generate through the Service (&quot;Customer Content&quot;).
              You grant SealMe a limited license to process, store, and transmit Customer Content solely to provide and improve the Service. We do not sell
              Customer Content to third parties.
            </p>
          </Section>

          <Section title="7. Third-Party Services">
            <p>
              The Service integrates with third-party platforms (including Zoom, Google Meet, and Google Calendar) and may use third-party AI model providers
              to process call audio and transcripts. Your use of those integrations is also subject to the applicable third party&apos;s own terms. SealMe is not
              responsible for the availability or behavior of third-party services.
            </p>
          </Section>

          <Section title="8. Fees">
            <p>
              The Service is currently provided free of charge. If we introduce paid plans or features, we will give you notice in advance, and you will not be
              charged unless you choose to sign up for them.
            </p>
          </Section>

          <Section title="9. Term and Termination">
            <p>
              These Terms remain in effect while you use the Service. You may cancel your account at any time. We may suspend or terminate access if you
              materially breach these Terms, misuse the Service, or fail to pay applicable fees. Upon termination, your right to use the Service ends, though
              certain provisions (ownership, liability, governing law) survive.
            </p>
          </Section>

          <Section title="10. Disclaimers">
            <p>
              The Service is provided &quot;as is&quot; without warranties of any kind, express or implied. AI-generated field extraction and contract drafts may
              contain errors. You are responsible for reviewing any contract before it is sent for signature. SealMe does not provide legal advice, and
              generated contracts do not constitute legal advice.
            </p>
          </Section>

          <Section title="11. Limitation of Liability">
            <p>
              To the maximum extent permitted by law, SealMe will not be liable for indirect, incidental, special, consequential, or punitive damages, or for
              any loss of profits, data, or business arising from your use of the Service. Our total liability for any claim will not exceed the amount you
              paid us in the twelve months preceding the claim.
            </p>
          </Section>

          <Section title="12. Governing Law">
            <p>
              These Terms are governed by the laws of the jurisdiction in which SealMe is incorporated, without regard to conflict-of-law principles.
            </p>
          </Section>

          <Section title="13. Changes to These Terms">
            <p>
              We may update these Terms from time to time. If we make material changes, we will notify workspace administrators by email or in-app notice.
              Continued use of the Service after changes take effect constitutes acceptance of the revised Terms.
            </p>
          </Section>

          <Section title="14. Contact">
            <p>Questions about these Terms can be sent to <span style={{ color: "var(--ink)" }}>ivan@sealme.net</span>.</p>
          </Section>
        </div>
      </main>

      <footer style={{ borderTop: "1px solid var(--hairline)" }}>
        <div className="mx-auto flex max-w-[820px] items-center justify-between px-6 py-8 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          <span>© {new Date().getFullYear()} SealMe.</span>
          <Link href="/privacy">Privacy Policy</Link>
        </div>
      </footer>
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
