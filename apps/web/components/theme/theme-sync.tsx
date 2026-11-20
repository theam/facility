"use client";

import { useEffect } from "react";
import { applyTheme, browserTheme, type ThemePreference } from "@/lib/theme";

/** Brings this browser in line with the person's saved preference, for example on a
 * new device, or after someone else signed out of this browser. */
export function ThemeSync({ theme }: { theme: ThemePreference | null }) {
  useEffect(() => {
    if (browserTheme() !== theme) applyTheme(theme);
  }, [theme]);
  return null;
}
