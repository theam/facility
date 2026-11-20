"use client";

import { useEffect, useRef, useState } from "react";
import { applyTheme, previewTheme, type ThemePreference } from "@/lib/theme";
import { saveTheme } from "./save-theme";
import { ThemeChoice } from "./theme-choice";

/** The profile's appearance. Each option previews at once; the last one chosen is saved
 * to the account shortly after, so moving through the options with the arrow keys saves
 * only where the person stops. */
export function AppearanceSetting({
  initial,
  saveDelayMs = 400,
}: {
  initial: ThemePreference | null;
  saveDelayMs?: number;
}) {
  const [theme, setTheme] = useState<ThemePreference>(initial ?? "system");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const saved = useRef<ThemePreference>(initial ?? "system");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function persist(value: ThemePreference, request: number) {
    setBusy(true);
    const result = await saveTheme(value);
    // A newer choice supersedes this one; it reports its own outcome.
    if (request !== latest.current) return;
    setBusy(false);
    if (!result.ok) {
      setTheme(saved.current);
      previewTheme(saved.current);
      setError(result.message);
      return;
    }
    saved.current = result.data.theme;
    applyTheme(result.data.theme);
    setStatus("Appearance saved for your account.");
  }

  function choose(value: ThemePreference) {
    setTheme(value);
    previewTheme(value);
    setError(null);
    setStatus("");
    clearTimeout(timer.current);
    const request = ++latest.current;
    timer.current = setTimeout(() => void persist(value, request), saveDelayMs);
  }

  return (
    <div className="flex flex-col gap-3">
      <ThemeChoice value={theme} busy={busy} onChange={choose} />
      <p role="status" className="min-h-5 text-sm text-(--mut)">
        {status}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
    </div>
  );
}
