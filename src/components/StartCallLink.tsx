"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useInDesktopApp } from "@/lib/native-shell";
import { startCallHref } from "@/lib/start-call";

// Start call, opened with the person filled in. In the desktop app it opens
// on recording live, in a browser on upload or paste. The server can't tell
// the two apart, so it's decided here, with the plain link until the page
// knows.
export default function StartCallLink({ leadId, who, name, className, children }: { leadId?: string; who?: string; name?: string; className?: string; children: ReactNode }) {
  const desktop = useInDesktopApp();
  return (
    <Link href={startCallHref({ leadId, who, name }, desktop === true)} className={className}>
      {children}
    </Link>
  );
}
