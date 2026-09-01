import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-plex-mono",
  display: "swap",
});

const plexSans = IBM_Plex_Sans({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
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
