import type { Metadata, Viewport } from "next";
import { Geist, Inter, Baloo_2 } from "next/font/google";
import { PHONE_APP_MARKER } from "@/lib/phone-app";
import "./globals.css";

const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
  weight: ["500", "600"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

// The actual "SealMe" wordmark typeface — bold, rounded, geometric —
// distinct from --font-display (Geist, used for regular headings). Only
// used for the brand wordmark itself (BrandLogo, the footer watermark),
// so a narrow weight range is enough.
const baloo = Baloo_2({
  variable: "--font-baloo",
  subsets: ["latin"],
  weight: ["700", "800"],
});

export const metadata: Metadata = {
  title: "SealMe",
  description: "Turn sales calls into signed contracts.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "SealMe",
  },
};

export const viewport: Viewport = {
  themeColor: "#f5f5f7",
};

// Puts the saved theme and which app this is (desktop or iPhone) on <html>
// while the browser reads <head>, so the very first paint already has them:
// no light flash for dark mode, and no browser-only text showing in the apps
// (globals.css). A plain inline script on purpose: next/script's
// beforeInteractive only queues it in the App Router, to run once the main
// JS bundle has downloaded, which is after the page is on screen. It only
// sets attributes, so running it twice is harmless, and suppressHydrationWarning
// on <html> keeps React from flagging the ones it didn't render.
const THEME_INIT_SCRIPT = `(function () {
  var root = document.documentElement;
  try {
    if (localStorage.getItem("sealme-theme") === "dark") root.setAttribute("data-theme", "dark");
  } catch (e) {}
  if ("__TAURI_INTERNALS__" in window) root.setAttribute("data-desktop", "");
  if ("__SEALME_MOBILE__" in window || navigator.userAgent.indexOf("${PHONE_APP_MARKER}") !== -1) root.setAttribute("data-mobile-app", "");
})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} ${inter.variable} ${baloo.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Older iOS (pre-17.4) only recognizes the apple-prefixed tag; Next's
            appleWebApp metadata emits the newer standard one but not this. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Only shown in the iPhone app, behind the status bar (globals.css). */}
        <div className="status-bar-backdrop sm-theme" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
