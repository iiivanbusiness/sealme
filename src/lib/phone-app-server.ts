import type { Viewport } from "next";
import { headers } from "next/headers";
import { isPhoneAppUserAgent } from "@/lib/phone-app";

// For server components: is this page being opened in the iPhone app?
export async function isPhoneApp(): Promise<boolean> {
  return isPhoneAppUserAgent((await headers()).get("user-agent"));
}

// The iPhone app draws edge to edge, under the status bar (globals.css
// leaves room for it), and doesn't zoom in on form fields. As
// generateViewport on pages rendered per request, so it's right from the
// first frame.
export async function phoneAppViewport(): Promise<Viewport> {
  return (await isPhoneApp()) ? { viewportFit: "cover", maximumScale: 1 } : {};
}
