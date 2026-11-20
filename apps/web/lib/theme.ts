/** A person's appearance: follow the operating system, or always light or dark. */
export type ThemePreference = "system" | "light" | "dark";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

/** Mirrors the saved preference so the server renders the right theme on first paint. */
export const THEME_COOKIE = "facility_theme";

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** The `data-theme` attribute for <html>: only explicit choices set one. */
export function themeAttribute(value: unknown): "light" | "dark" | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

/** Applies a preference in this browser, now and on the next page load. */
export function applyTheme(theme: ThemePreference | null) {
  const root = document.documentElement;
  const attribute = themeAttribute(theme);
  if (attribute) root.dataset.theme = attribute;
  else delete root.dataset.theme;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  // biome-ignore lint/suspicious/noDocumentCookie: a synchronous write must land before the next navigation renders on the server
  document.cookie = theme
    ? `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
    : `${THEME_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

/** The preference this browser last applied, from its cookie. */
export function browserTheme(): ThemePreference | null {
  const value = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${THEME_COOKIE}=`))
    ?.slice(THEME_COOKIE.length + 1);
  return isThemePreference(value) ? value : null;
}
