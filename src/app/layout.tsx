import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

// Geist Mono was loaded for two labels — the word "ANSWER" above each card and
// the source numbers — and cost every visitor a second font download. Those now
// use the system monospace stack, which is already on the device.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tca-hub.vercel.app";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Deliberately NOT "cover". Under cover, iOS runs the page behind its toolbar
  // and paints a scrim there for legibility — and that scrim's top edge is a
  // hard line across the page, which nothing in CSS can reach. Without cover the
  // content stops above the bar instead, and the bar carries themeColor below:
  // the same value as --bg, which the glow already fades to at the edges, so the
  // two meet in one colour and there is no edge to see. The cost is that the
  // background no longer runs under the notch — a seam is worse than not having
  // the bleed.
  viewportFit: "auto",
  // Matches the page background in each theme, so the iOS status bar and the
  // Android chrome don't sit in a different colour to the app.
  //
  // The raw tokens, deliberately. .tca-bg-glow now fades out across the safe
  // areas, so the page's top and bottom edges are flat --bg — and a bar painted
  // in anything else would be the mismatch rather than the cure. These two
  // values and that mask have to agree; changing one means changing the other.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fc" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0e1a" },
  ],
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "TCA Hub — Ask anything about The Classical Academy",
    template: "%s · TCA Hub",
  },
  description:
    "Schedules, staff, calendars, dress code and supply lists for The Classical Academy in Colorado Springs — ask a question, get a straight answer with sources.",
  applicationName: "TCA Hub",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "TCA Hub",
    statusBarStyle: "default",
  },
  icons: {
    apple: "/apple-touch-icon.png",
  },
  // Shared between parents constantly — in texts, in class group chats — so the
  // link needs to render as something other than a bare URL.
  openGraph: {
    type: "website",
    siteName: "TCA Hub",
    title: "TCA Hub — Ask anything about The Classical Academy",
    description:
      "Schedules, staff, calendars, dress code and supply lists for TCA — ask a question, get a straight answer with sources.",
    url: SITE_URL,
    images: [{ url: "/apple-touch-icon.png", width: 180, height: 180, alt: "TCA Hub" }],
  },
  twitter: {
    card: "summary",
    title: "TCA Hub — Ask anything about The Classical Academy",
    description: "Schedules, staff, calendars and policies for TCA, answered with sources.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={geistSans.variable}>
      <head>
        {/* Staff headshots are the only cross-origin request the page makes, and
            they appear as soon as an answer names somebody. */}
        <link rel="preconnect" href="https://www.tcatitans.org" crossOrigin="" />
        <link rel="dns-prefetch" href="https://www.tcatitans.org" />
      </head>
      <body>{children}</body>
    </html>
  );
}
