import { AuthError } from "next-auth";
import Link from "next/link";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";
import ThemeToggle from "@/components/ThemeToggle";
import BrandLogo from "@/components/BrandLogo";
import GoogleIcon from "@/components/GoogleIcon";
import { phoneAppViewport } from "@/lib/phone-app-server";

const ERROR_MESSAGE: Record<string, string> = {
  CredentialsSignin: "Wrong email, password, or 2FA code.",
};
const DEFAULT_ERROR_MESSAGE = "Something went wrong signing you in. Please try again.";

// The iPhone app opens here when signed out.
export const generateViewport = phoneAppViewport;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string; reset?: string; joined?: string }>;
}) {
  const { callbackUrl, error, reset, joined } = await searchParams;

  async function authenticate(formData: FormData) {
    "use server";
    try {
      await signIn("credentials", {
        email: formData.get("email"),
        password: formData.get("password"),
        code: formData.get("code"),
        redirectTo: callbackUrl || "/",
      });
    } catch (err) {
      if (err instanceof AuthError) {
        redirect(`/login?error=${err.type}${callbackUrl ? `&callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`);
      }
      throw err;
    }
  }

  async function continueWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: callbackUrl || "/" });
  }

  return (
    <div className="sm-theme relative flex min-h-screen items-center justify-center px-4" style={{ background: "var(--canvas)" }}>
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[360px]">
        <div className="mb-6">
          <BrandLogo height={24} />
        </div>
        <h1 className="mb-1 text-[24px] font-medium" style={{ letterSpacing: "-0.8px" }}>Sign in to SealMe</h1>
        <p className="mb-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
          New here?{" "}
          <Link href="/onboarding" className="font-medium" style={{ color: "var(--accent-blue)" }}>
            Create a workspace
          </Link>
        </p>

        {error && (
          <div className="chip chip-warn mb-4 w-full justify-center py-2.5 text-[12.5px]">
            {ERROR_MESSAGE[error] ?? DEFAULT_ERROR_MESSAGE}
          </div>
        )}
        {(reset || joined) && (
          <div className="chip chip-success mb-4 w-full justify-center py-2.5 text-[12.5px]">
            {joined ? "You're in. Sign in with your email and new password." : "Password updated. Sign in below."}
          </div>
        )}

        <div className="card flex flex-col gap-3 p-6">
          <div className="web-only contents">
            <form action={continueWithGoogle}>
              <button type="submit" className="btn btn-secondary w-full justify-center gap-2.5">
                <GoogleIcon />
                Continue with Google
              </button>
            </form>

            <div className="my-1 flex items-center gap-3">
              <div className="h-px flex-1" style={{ background: "var(--hairline)" }} />
              <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>or</span>
              <div className="h-px flex-1" style={{ background: "var(--hairline)" }} />
            </div>
          </div>

          <form action={authenticate} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Email</span>
              <input name="email" type="email" required placeholder="you@company.com" className="input" />
            </label>
            <label className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[13px] font-medium">Password</span>
                <Link href="/forgot-password" className="text-[12px] font-medium" style={{ color: "var(--accent-blue)" }}>
                  Forgot?
                </Link>
              </div>
              <input name="password" type="password" required placeholder="••••••••" className="input" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">2FA code <span style={{ color: "var(--ink-muted)", fontWeight: 400 }}>(if enabled)</span></span>
              <input name="code" inputMode="numeric" placeholder="123456 or backup code" className="input" />
            </label>
            <button type="submit" className="btn btn-primary mt-2 w-full justify-center">
              Sign in
            </button>
          </form>

          <div className="my-1 flex items-center gap-3">
            <div className="h-px flex-1" style={{ background: "var(--hairline)" }} />
            <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>or</span>
            <div className="h-px flex-1" style={{ background: "var(--hairline)" }} />
          </div>

          <form action="/api/sso/start" method="get" className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Company SSO</span>
              <input name="email" type="email" required placeholder="you@company.com" className="input" />
            </label>
            <button type="submit" className="btn btn-secondary w-full justify-center">
              Continue with SSO
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
