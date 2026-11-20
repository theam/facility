"use client";

import { useState } from "react";
import type { ThemePreference } from "@/lib/theme";
import { saveTheme } from "./save-theme";
import { ThemeChoice } from "./theme-choice";

/** The profile's appearance: each change is saved to the account right away. */
export function AppearanceSetting({ initial }: { initial: ThemePreference | null }) {
  const [theme, setTheme] = useState<ThemePreference>(initial ?? "system");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  async function choose(value: ThemePreference) {
    const previous = theme;
    setTheme(value);
    setBusy(true);
    setStatus(null);
    const result = await saveTheme(value);
    setBusy(false);
    if (!result.ok) {
      setTheme(previous);
      setStatus({ ok: false, message: result.message });
      return;
    }
    setStatus({ ok: true, message: "Appearance saved for your account." });
  }
  return (
    <div className="flex flex-col gap-3">
      <ThemeChoice value={theme} disabled={busy} onChange={(value) => void choose(value)} />
      {status ? (
        <p
          role={status.ok ? "status" : "alert"}
          className={status.ok ? "text-sm text-(--mut)" : "text-sm text-(--bad)"}
        >
          {status.message}
        </p>
      ) : null}
    </div>
  );
}
