import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

const plexMono = localFont({
  src: [
    { path: "./fonts/IBMPlexMono-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexMono-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IBMPlexMono-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});

const plexSans = localFont({
  src: [
    { path: "./fonts/IBMPlexSans-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/IBMPlexSans-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/IBMPlexSans-SemiBold.woff2", weight: "600", style: "normal" },
    { path: "./fonts/IBMPlexSans-Bold.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "facility", template: "%s · facility" },
  description:
    "The platform that governs your AI SDLC. Agents build. People decide twice. Everything gets measured.",
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Extensions such as Grammarly inject body attributes before React hydrates.
  return (
    <html lang="en" className={`${plexMono.variable} ${plexSans.variable}`}>
      <body suppressHydrationWarning className="grain min-h-dvh">
        {children}
      </body>
    </html>
  );
}
