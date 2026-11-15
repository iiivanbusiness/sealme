import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUserWithRole } from "@/lib/permissions";
import UploadContract from "./UploadContract";

// Finding the fields means reading the whole contract with Claude, which
// can take a minute or more on a long one.
export const maxDuration = 300;

// ?kind comes from the Templates tab the upload started on, so the
// template lands in that list.
export default async function UploadTemplatePage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind: asked } = await searchParams;
  const kind = asked === "proposal" ? "proposal" : "contract";
  const user = await currentUserWithRole();
  if (!user.role?.canManageTemplates) redirect(`/templates?kind=${kind}`);

  return (
    <>
    <Link href={`/templates?kind=${kind}`} className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
      ← Templates
    </Link>

    <UploadContract kind={kind} />
    </>
  );
}
