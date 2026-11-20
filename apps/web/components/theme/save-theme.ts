"use client";

import { clientApi } from "@/lib/client-api";
import { applyTheme, type ThemePreference } from "@/lib/theme";

/** Saves the person's preference on their account and applies it in this browser. */
export async function saveTheme(theme: ThemePreference) {
  const result = await clientApi<{ theme: ThemePreference }>("PATCH", "/v1/me/preferences", {
    theme,
  });
  if (result.ok) applyTheme(result.data.theme);
  return result;
}
