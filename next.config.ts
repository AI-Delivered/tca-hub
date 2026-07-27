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
  // Production only. In dev this directive makes the app untestable on a real
  // phone: the device loads http://<lan-ip>:3000, every subresource is upgraded
  // to https, the dev server does not speak it, and the page arrives as bare
  // unstyled HTML. It never shows up on the desktop because localhost is a
  // trustworthy origin and is exempt from the upgrade.
  ...(process.env.NODE_ENV === 'production' ? ["upgrade-insecure-requests"] : []),
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
  // Hosts allowed to reach the dev server's own resources — the HMR socket
  // above all. Without the LAN address here a phone loads the app fine but
  // never receives an update, so it sits on whatever bundle it happened to
  // fetch: a transient compile error stays on screen as a dead page long
  // after the desktop has recovered. Dev only; ignored in a build.
  allowedDevOrigins: ['192.168.1.37', '*.local'],

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
