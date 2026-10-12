import type { Metadata, Viewport } from "next";
import { Geist, Inter, Baloo_2 } from "next/font/google";
import Script from "next/script";
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

const THEME_INIT_SCRIPT = `
  try {
    var t = localStorage.getItem("sealme-theme");
    if (t === "dark") document.documentElement.setAttribute("data-theme", "dark");
  } catch (e) {}
  if ("__TAURI_INTERNALS__" in window) document.documentElement.setAttribute("data-desktop", "");
  if ("__SEALME_MOBILE__" in window || navigator.userAgent.indexOf("SealMeMobile") !== -1) document.documentElement.setAttribute("data-mobile-app", "");
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geist.variable} ${inter.variable} ${baloo.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        {/* Older iOS (pre-17.4) only recognizes the apple-prefixed tag; Next's
            appleWebApp metadata emits the newer standard one but not this. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <Script id="theme-init" strategy="beforeInteractive">{THEME_INIT_SCRIPT}</Script>
      </head>
      <body className="min-h-full flex flex-col">
        {/* Only shown in the iPhone app, behind the status bar (globals.css). */}
        <div className="status-bar-backdrop sm-theme" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
