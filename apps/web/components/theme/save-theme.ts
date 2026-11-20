"use client";

import { clientApi } from "@/lib/client-api";
import type { ThemePreference } from "@/lib/theme";

/** Saves the person's preference on their account. Callers apply it once it is saved. */
export function saveTheme(theme: ThemePreference) {
  return clientApi<{ theme: ThemePreference }>("PATCH", "/v1/me/preferences", { theme });
}
