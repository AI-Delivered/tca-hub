import type { NextConfig } from "next";

// Content Security Policy.
//
// The app renders text written by a model whose entire context is scraped from
// a third-party website, so the clause that matters is `script-src`: even if
// something got past the markdown sanitizer in src/lib/markdown.ts, an injected
// <script> or event handler has nowhere to load from and no remote host to talk
// to. `'unsafe-inline'` on styles is unavoidable — components style themselves
// inline — but a style cannot execute. It stays off `connect-src`, so nothing
// injected can exfiltrate to another origin either.
//
// Scripts still need 'unsafe-inline' for the App Router's bootstrap; the
// narrowing that counts is that no third-party script host is allowed at all.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // Staff headshots live at tcatitans.org/uploaded/staff_photos/.
  "img-src 'self' data: https://www.tcatitans.org https://tcatitans.org",
  "font-src 'self' data:",
  // Same-origin API only — Supabase and Anthropic are called server-side.
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
].join('; ')

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
]

const nextConfig: NextConfig = {
  // Stops advertising the framework version to anyone scanning for known CVEs.
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // A parent's answer, and the analytics behind the dashboard, must never
      // be held by a shared cache on the way back to somebody else.
      {
        source: '/api/(search|track-visit|admin/:path*)',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ]
  },
};

export default nextConfig;
