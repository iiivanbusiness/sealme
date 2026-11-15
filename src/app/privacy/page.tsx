import Link from "next/link";

export const metadata = {
  title: "Privacy Policy - SealMe",
};

const LAST_UPDATED = "November 14, 2026";

export default function PrivacyPage() {
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
        <h1 className="mb-2 text-[36px] font-medium" style={{ letterSpacing: "-0.8px", color: "var(--primary)" }}>Privacy Policy</h1>
        <p className="mb-12 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>Last updated: {LAST_UPDATED}</p>

        <div className="flex flex-col gap-10 text-[14.5px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>
          <Section title="1. Overview">
            <p>
              This Privacy Policy explains how SealMe (&quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) collects, uses, and shares information when you use our website and
              service (the &quot;Service&quot;). It applies to workspace administrators, team members, and (where relevant) the sales prospects whose calls are
              processed through the Service.
            </p>
          </Section>

          <Section title="2. Information We Collect">
            <p>We collect the following categories of information:</p>
            <ul className="ml-5 mt-2 flex list-disc flex-col gap-1.5">
              <li><strong style={{ color: "var(--ink)" }}>Account data</strong>. Name, work email, password hash, and workspace details.</li>
              <li><strong style={{ color: "var(--ink)" }}>Call data</strong>. Audio captured during calls you connect to SealMe, and the transcripts and deal
                terms extracted from it.</li>
              <li><strong style={{ color: "var(--ink)" }}>Lead data</strong>. Names, job titles, companies, phone numbers, email addresses, and notes about
                sales leads that you add by hand, import from a file, or bring in from HubSpot or Salesforce.</li>
              <li><strong style={{ color: "var(--ink)" }}>Phone call data</strong>. If you place calls through SealMe: the phone numbers involved, when the call
                happened and how long it lasted, the US state we infer from the area code and the recording rule we applied, and, where recording is
                allowed, the call audio, its transcript, and the notes we extract from it. We also keep your own phone number and the fact that you
                verified it with a text message code.</li>
              <li><strong style={{ color: "var(--ink)" }}>Deal and contract data</strong>. Client names, pricing, contract templates, clauses, and signature
                records you create in the Service.</li>
              <li><strong style={{ color: "var(--ink)" }}>Calendar data</strong>. If you connect Google Calendar, we read your upcoming events and the email
                address of the connected Google account. Section 5 explains exactly what we keep and how.</li>
              <li><strong style={{ color: "var(--ink)" }}>Usage and device data</strong>. Log data, browser type, and product usage analytics.</li>
            </ul>
          </Section>

          <Section title="3. How We Use Information">
            <ul className="ml-5 flex list-disc flex-col gap-1.5">
              <li>To operate the Service: capturing deal terms, drafting contracts, and routing them for signature;</li>
              <li>To connect the phone calls you start, apply the recording rule for the called party&apos;s state, and write up calls as lead notes,
                summaries, and draft contracts;</li>
              <li>To maintain and secure workspace accounts;</li>
              <li>To provide customer support and respond to requests;</li>
              <li>To improve accuracy of AI-driven field extraction and contract drafting;</li>
              <li>To comply with legal obligations.</li>
            </ul>
          </Section>

          <Section title="4. AI and Third-Party Processing">
            <p>
              Call audio and transcripts are processed by Anthropic (Claude) under contract with SealMe in order to extract deal terms, generate contract
              language, and summarize call notes. Audio you record locally is first transcribed by Deepgram before reaching Anthropic. If you connect Google Calendar, Google processes your calendar data under its own terms to
              sync events. Phone calls you place through SealMe are carried, and where allowed recorded, by Telnyx, our telephony provider, which also
              sends the text message code used to verify your phone number; those recordings are transcribed by Deepgram and summarized by Anthropic.
              If you connect HubSpot or Salesforce, we read the contacts or leads you choose to import and write call summaries and lead status back to
              your account. These providers are bound by confidentiality and data-processing terms and are not permitted to use your data to train their own
              general-purpose models unless you explicitly opt in.
            </p>
          </Section>

          <Section title="5. Google User Data">
            <p>
              If you connect Google Calendar, SealMe asks Google for read-only access to your calendar and for the email address of the Google account you
              connect. We never ask for permission to change or delete anything in your calendar.
            </p>
            <ul className="ml-5 mt-2 flex list-disc flex-col gap-1.5">
              <li><strong style={{ color: "var(--ink)" }}>What we access</strong>. Upcoming events on your primary calendar: title, start time, length, meeting
                link, and attendee names and email addresses. We store the event title, time, length, meeting link, and the name and email address of one
                outside attendee, plus the email of the connected account. All-day events and meetings you declined are not stored.</li>
              <li><strong style={{ color: "var(--ink)" }}>How we use it</strong>. Only to show your upcoming meetings inside SealMe and, when you click Start
                call on one, to fill in who the call is with and find or add them as a lead. Nothing is recorded automatically and SealMe never joins a meeting:
                a call is only recorded when you start it yourself. We do not use Google user data for advertising, we do not sell it, and we do not use it
                to train AI models.</li>
              <li><strong style={{ color: "var(--ink)" }}>Sharing</strong>. We do not share Google user data with third parties, except the hosting and
                database providers that run the Service, or where required by law. Calendar data is not sent to AI providers.</li>
              <li><strong style={{ color: "var(--ink)" }}>Deletion</strong>. Click Disconnect on the Calendar page and we revoke SealMe&apos;s access with
                Google and delete every event synced from your calendar. You can also remove access at any time
                at <a href="https://myaccount.google.com/permissions" className="underline" style={{ color: "var(--ink)" }}>myaccount.google.com/permissions</a>.</li>
            </ul>
            <p className="mt-3">
              SealMe&apos;s use and transfer to any other app of information received from Google APIs will adhere to
              the <a href="https://developers.google.com/terms/api-services-user-data-policy" className="underline" style={{ color: "var(--ink)" }}>Google
              API Services User Data Policy</a>, including the Limited Use requirements.
            </p>
          </Section>

          <Section title="6. Phone Call Recording">
            <p>
              SealMe decides whether a call may be recorded from the called party&apos;s US area code. Where one party&apos;s consent is enough, the call is
              recorded. In states that require the consent of everyone on the call, and when the state cannot be determined, calls are not recorded.
              Calls to numbers outside the United States, to toll-free numbers, and to leads without a phone number are not recorded. Every call keeps a
              record of the area code, the state, the rule applied, whether it was recorded, and when.
            </p>
          </Section>

          <Section title="7. Sharing of Information">
            <p>We do not sell your personal information. We share information only with:</p>
            <ul className="ml-5 mt-2 flex list-disc flex-col gap-1.5">
              <li>Sub-processors who host, transcribe, or process data on our behalf (e.g., cloud hosting, AI model providers, telephony, e-signature delivery);</li>
              <li>Integrated platforms you connect, such as Slack, DocuSign, HubSpot, or Salesforce, to the extent needed for the integration to function;</li>
              <li>Law enforcement or regulators where required by law;</li>
              <li>A successor entity in the event of a merger, acquisition, or asset sale, subject to the same privacy commitments.</li>
            </ul>
          </Section>

          <Section title="8. Data Retention">
            <p>
              We retain account, deal, and contract data for as long as your workspace is active, and for a reasonable period afterward to comply with legal,
              accounting, or dispute-resolution requirements. Raw call audio is retained only as long as needed to complete transcription and field extraction,
              after which it is deleted or reduced to a text transcript, unless you configure a longer retention period. Phone call recordings are deleted
              from our telephony provider once the call is written up or discarded, and calls nobody processes are deleted after 24 hours. Transcripts
              and call notes stay with the lead or deal for as long as the workspace keeps them.
            </p>
          </Section>

          <Section title="9. Data Security">
            <p>
              We use industry-standard technical and organizational measures (including encryption in transit and access controls) to protect information
              against unauthorized access, alteration, or loss. No method of transmission or storage is completely secure, and we cannot guarantee absolute
              security.
            </p>
          </Section>

          <Section title="10. Your Rights">
            <p>
              Depending on your location, you may have the right to access, correct, export, or delete your personal information, and to object to or restrict
              certain processing. Workspace administrators can manage most of this directly in account settings; you can also contact us using the details
              below. Prospects whose calls are processed through SealMe may direct data requests to the workspace that initiated the call.
            </p>
          </Section>

          <Section title="11. Cookies">
            <p>
              We use essential cookies to keep you signed in and remember basic preferences. We do not use third-party advertising cookies on the Service.
            </p>
          </Section>

          <Section title="12. International Data Transfers">
            <p>
              Information may be processed in countries other than your own. Where required, we rely on appropriate safeguards (such as standard contractual
              clauses) for cross-border transfers of personal data.
            </p>
          </Section>

          <Section title="13. Children&apos;s Privacy">
            <p>The Service is intended for business use and is not directed at individuals under 16. We do not knowingly collect data from children.</p>
          </Section>

          <Section title="14. Changes to This Policy">
            <p>
              We may update this Privacy Policy from time to time. Material changes will be communicated to workspace administrators by email or in-app
              notice before they take effect.
            </p>
          </Section>

          <Section title="15. Contact">
            <p>
              For privacy questions or data requests, contact <span style={{ color: "var(--ink)" }}>ivan@sealme.net</span>.
            </p>
          </Section>
        </div>
      </main>

      <footer style={{ borderTop: "1px solid var(--hairline)" }}>
        <div className="mx-auto flex max-w-[820px] items-center justify-between px-6 py-8 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          <span>© {new Date().getFullYear()} SealMe.</span>
          <Link href="/terms">Terms of Service</Link>
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
