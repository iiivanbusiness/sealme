import { createHash } from "crypto";
import ThemeToggle from "@/components/ThemeToggle";
import { prisma } from "@/lib/db";
import BrandLogo from "@/components/BrandLogo";
import { resetPassword } from "./actions";

export default async function ResetPasswordPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; invite?: string }>;
}) {
  const { token } = await params;
  const { error, invite } = await searchParams;
  // The same link, from a teammate invite: they also say their name.
  const joining = invite === "1";
  const workspaceName = joining
    ? ((
        await prisma.passwordResetToken.findUnique({
          where: { tokenHash: createHash("sha256").update(token).digest("hex") },
          select: { user: { select: { workspace: { select: { name: true } } } } },
        })
      )?.user.workspace.name ?? null)
    : null;

  return (
    <div className="sm-theme relative flex min-h-screen items-center justify-center px-4" style={{ background: "var(--canvas)" }}>
      <div className="absolute right-6 top-6">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-[360px]">
        <div className="mb-6">
          <BrandLogo height={24} />
        </div>
        <h1 className="mb-1 text-[24px] font-medium" style={{ letterSpacing: "-0.8px" }}>
          {joining ? `Join ${workspaceName ?? "your team"} on SealMe` : "Set a new password"}
        </h1>
        <p className="mb-6 text-[13.5px]" style={{ color: "var(--ink-muted)" }}>
          {joining ? "Add your name and choose a password, then sign in." : "Choose a new password for your SealMe account. Every device signed in with the old one is signed out."}
        </p>

        {error && (
          <div className="chip chip-warn mb-4 w-full justify-center py-2.5 text-center text-[12.5px]">
            {error}
          </div>
        )}

        <form action={resetPassword.bind(null, token, joining)} className="card flex flex-col gap-3 p-6">
          {joining && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Your name</span>
              <input name="name" type="text" required maxLength={100} placeholder="Jane Doe" autoComplete="name" className="input" />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">{joining ? "Password" : "New password"}</span>
            <input name="password" type="password" required minLength={8} placeholder="At least 8 characters" className="input" />
          </label>
          <button type="submit" className="btn btn-primary mt-2 w-full justify-center">
            {joining ? "Join" : "Reset password"}
          </button>
        </form>
      </div>
    </div>
  );
}
