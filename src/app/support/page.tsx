import Link from "next/link";

export const metadata = {
  title: "Support - SealMe",
};

const SUPPORT_EMAIL = "ivan@sealme.net";

export default function SupportPage() {
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
        <h1 className="mb-2 text-[36px] font-medium" style={{ letterSpacing: "-0.8px", color: "var(--primary)" }}>Support</h1>
        <p className="mb-12 text-[14.5px]" style={{ color: "var(--ink-muted)" }}>
          Questions, problems, or feedback about SealMe? We&apos;re here to help.
        </p>

        <section className="card mb-12 flex flex-col gap-2 p-6">
          <h2 className="text-[17px] font-medium" style={{ color: "var(--ink)" }}>Contact us</h2>
          <p className="text-[14.5px]" style={{ color: "var(--ink-muted)" }}>
            Email{" "}
            <a href={`mailto:${SUPPORT_EMAIL}`} className="font-medium" style={{ color: "var(--accent-blue)" }}>
              {SUPPORT_EMAIL}
            </a>{" "}
            and include the email address you use to sign in, plus a short description of what happened. Signed-in users can also reach us from the
            support chat inside the app.
          </p>
        </section>

        <div className="flex flex-col gap-10 text-[14.5px] leading-relaxed" style={{ color: "var(--ink-muted)" }}>
          <Faq question="I can't sign in">
            Use{" "}
            <Link href="/forgot-password" style={{ color: "var(--accent-blue)" }}>
              Forgot password
            </Link>{" "}
            on the sign-in page to set a new password. If you created your account with Google and are signing in to the SealMe desktop app, use Forgot
            password once to add a password to your account. If your company uses single sign-on, choose Continue with SSO and enter your work email.
          </Faq>

          <Faq question="How do I record a call?">
            In the SealMe desktop app for Mac, click Start a call on the Dashboard (or Start call on a meeting), then Start recording. The first time, macOS asks for Microphone and
            Screen Recording permission. SealMe needs both to hear you and the other side of the call. If you declined earlier, turn them back on in System
            Settings under Privacy &amp; Security, then restart SealMe. You can also paste in a transcript from any call instead of recording.
          </Faq>

          <Faq question="The other side of my call didn't come through">
            SealMe records the other participants through your Mac&apos;s system audio. If only your own voice was captured, check that Screen Recording
            permission is on for SealMe, and try playing the call through your Mac&apos;s built-in speakers or wired headphones.
          </Faq>

          <Faq question="How do I delete my account?">
            Go to Settings and choose Delete account. This removes your personal data (name, email, password) and signs you out. Deals and contracts your
            team created stay in your team&apos;s workspace.
          </Faq>

          <Faq question="How is my data handled?">
            See our{" "}
            <Link href="/privacy" style={{ color: "var(--accent-blue)" }}>
              Privacy Policy
            </Link>{" "}
            for what we collect, which providers process call data, and how to request access to or deletion of your data.
          </Faq>
        </div>
      </main>

      <footer style={{ borderTop: "1px solid var(--hairline)" }}>
        <div className="mx-auto flex max-w-[820px] items-center justify-between px-6 py-8 text-[12.5px]" style={{ color: "var(--ink-muted)" }}>
          <span>© {new Date().getFullYear()} SealMe.</span>
          <div className="flex gap-5">
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/terms">Terms of Service</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Faq({ question, children }: { question: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[19px] font-medium" style={{ letterSpacing: "-0.3px", color: "var(--ink)" }}>{question}</h2>
      <p>{children}</p>
    </section>
  );
}
