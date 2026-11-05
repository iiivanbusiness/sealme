import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import BrandLogo from "@/components/BrandLogo";
import GoogleIcon from "@/components/GoogleIcon";
import SubmitButton from "@/components/SubmitButton";
import { signIn } from "@/lib/auth";
import { signup } from "./actions";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function continueWithGoogle() {
    "use server";
    await signIn("google", { redirectTo: "/dashboard" });
  }

  return (
    <div className="sm-theme relative flex min-h-screen items-center justify-center px-4" style={{ background: "var(--canvas)" }}>
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[380px]">
        <div className="mb-6">
          <BrandLogo height={24} />
        </div>
        <h1 className="mb-1 text-[24px] font-medium" style={{ letterSpacing: "-0.8px" }}>Create your workspace</h1>
        <p className="mb-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
          Already have one?{" "}
          <Link href="/login" className="font-medium" style={{ color: "var(--accent-blue)" }}>
            Sign in
          </Link>
        </p>

        {error && (
          <div className="chip chip-warn mb-4 w-full justify-center py-2.5 text-center text-[12.5px]">
            {error}
          </div>
        )}

        <div className="card flex flex-col gap-3 p-6">
          <div className="web-only contents">
            <form action={continueWithGoogle}>
              <SubmitButton pendingText="Opening Google…" className="btn btn-secondary w-full justify-center gap-2.5">
                <GoogleIcon />
                Continue with Google
              </SubmitButton>
            </form>

            <div className="my-1 flex items-center gap-3">
              <div className="h-px flex-1" style={{ background: "var(--hairline)" }} />
              <span className="text-[11.5px]" style={{ color: "var(--ink-muted)" }}>or</span>
              <div className="h-px flex-1" style={{ background: "var(--hairline)" }} />
            </div>
          </div>

          <form action={signup} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Company name</span>
              <input name="companyName" required placeholder="Horizon Media" className="input" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Your name</span>
              <input name="name" required placeholder="Jane Doe" className="input" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Email</span>
              <input name="email" type="email" required placeholder="you@company.com" className="input" />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Password</span>
              <input name="password" type="password" required minLength={8} placeholder="At least 8 characters" className="input" />
            </label>
            <SubmitButton pendingText="Creating your workspace…" className="btn btn-primary mt-2 w-full justify-center">
              Create workspace
            </SubmitButton>
          </form>
        </div>
      </div>
    </div>
  );
}
