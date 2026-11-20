import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { cookies } from "next/headers";
import { api, SESSION_COOKIE } from "@/lib/api";
import { THEME_COOKIE, themeAttribute } from "@/lib/theme";
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

const THEME_COLORS = { light: "#f5f6f8", dark: "#0a0c10" } as const;

/** An explicit choice on this browser, else the account's when signed in: the theme the
 * server renders on the first paint. Undefined follows the operating system. */
async function renderedTheme() {
  const jar = await cookies();
  if (jar.has(THEME_COOKIE)) return themeAttribute(jar.get(THEME_COOKIE)?.value);
  if (!jar.has(SESSION_COOKIE)) return undefined;
  // A new device: the session's own /v1/me read, shared with the app layout.
  const me = await api.me();
  return me.ok ? themeAttribute(me.data.preferences?.theme) : undefined;
}

export async function generateViewport(): Promise<Viewport> {
  const theme = await renderedTheme();
  return {
    themeColor: theme
      ? THEME_COLORS[theme]
      : [
          { media: "(prefers-color-scheme: light)", color: THEME_COLORS.light },
          { media: "(prefers-color-scheme: dark)", color: THEME_COLORS.dark },
        ],
    width: "device-width",
    initialScale: 1,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // An explicit choice renders on the first paint; otherwise CSS follows the system.
  const theme = await renderedTheme();
  // Extensions such as Grammarly inject body attributes before React hydrates.
  return (
    <html lang="en" data-theme={theme} className={`${plexMono.variable} ${plexSans.variable}`}>
      <body suppressHydrationWarning className="min-h-dvh">
        {children}
      </body>
    </html>
  );
}
