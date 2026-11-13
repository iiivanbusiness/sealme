import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUserWithRole } from "@/lib/permissions";
import UploadContract from "./UploadContract";

// Finding the fields means reading the whole contract with Claude, which
// can take a minute or more on a long one.
export const maxDuration = 300;

export default async function UploadTemplatePage() {
  const user = await currentUserWithRole();
  if (!user.role?.canManageTemplates) redirect("/templates");

  return (
    <>
    <Link href="/templates" className="mb-3.5 inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--ink-muted)" }}>
      ← Templates
    </Link>

    <UploadContract />
    </>
  );
}
