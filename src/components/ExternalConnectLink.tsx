"use client";

import { type ReactNode, type MouseEvent } from "react";
import { useInDesktopApp } from "@/lib/native-shell";

// A plain <a href="/api/..."> works fine in a normal browser, but the
// desktop app's webview is locked to app.sealme.net (see
// desktop-app/src-tauri/tauri.conf.json's remote.urls) — navigating it to
// an external OAuth page (Slack, HubSpot, Google) just goes blank instead
// of following the redirect. Inside Tauri, this opens the same URL in the
// user's actual system browser instead (where their real login session
// lives), via the opener plugin already registered on the Rust side
// (`opener:default` in capabilities/default.json) — no desktop app rebuild
// needed, since it's a thin shell that always loads the live site.
export default function ExternalConnectLink({
  href,
  className,
  style,
  children,
}: {
  href: string;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  const isTauri = useInDesktopApp();

  async function handleClick(e: MouseEvent<HTMLAnchorElement>) {
    if (!isTauri) return; // plain <a> navigates normally in a real browser
    e.preventDefault();
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(new URL(href, window.location.origin).toString());
  }

  return (
    <a href={href} className={className} style={style} onClick={handleClick}>
      {children}
    </a>
  );
}
