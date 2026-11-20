"use client";

import { Button } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { applyTheme, type ThemePreference } from "@/lib/theme";
import { saveTheme } from "./save-theme";
import { ThemeChoice } from "./theme-choice";

/** Shown once, until the person chooses. Each option previews live; closing the dialog
 * keeps following the system. The choice can be changed later in the profile. */
export function FirstThemeChoice() {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal?.();
  }, []);
  async function save(choice: ThemePreference) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await saveTheme(choice);
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    dialog.current?.close?.();
    setDone(true);
    router.refresh();
  }
  if (done) return null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="first-theme-title"
      onCancel={(event) => {
        event.preventDefault();
        setTheme("system");
        applyTheme("system");
        void save("system");
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-(--line-strong) bg-(--bg-subtle) p-6 text-(--ink) shadow-(--shadow-lift) backdrop:bg-(--overlay)"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="first-theme-title" className="text-lg font-semibold">
            Choose your appearance
          </h2>
          <p className="text-sm text-(--mut)">
            Facility follows your device's setting unless you choose otherwise. You can change this
            later in your profile.
          </p>
        </div>
        <ThemeChoice
          value={theme}
          disabled={busy}
          onChange={(value) => {
            setTheme(value);
            applyTheme(value);
          }}
        />
        {error ? (
          <p role="alert" className="text-sm text-(--bad)">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button variant="primary" disabled={busy} onClick={() => void save(theme)}>
            {busy ? "Saving…" : "Save appearance"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
