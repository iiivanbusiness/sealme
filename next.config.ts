import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The PDF font (src/lib/pdf-fonts.ts) is read from disk by path, which
  // the build can't trace on its own. Every route: a contract PDF is also
  // built for DocuSign from server actions and API routes all over the app.
  outputFileTracingIncludes: {
    "/**": ["src/lib/fonts/*.ttf"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          // Microphone for SealMe itself only: voice corrections and the voice
          // FAQ record in the browser. microphone=() blocked them.
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
