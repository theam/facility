"use client";

import { cx } from "@facility/ui";
import { useId } from "react";
import type { ThemePreference } from "@/lib/theme";

const OPTIONS: Array<{ value: ThemePreference; label: string; hint: string }> = [
  { value: "system", label: "Match system", hint: "Follows your device's setting." },
  { value: "light", label: "Light", hint: "Always light." },
  { value: "dark", label: "Dark", hint: "Always dark." },
];

/** Each preview depicts its theme, so it keeps that theme's colors on either canvas. */
function Preview({ value }: { value: ThemePreference }) {
  const light = "linear-gradient(#f5f6f8, #f5f6f8)";
  const dark = "linear-gradient(#0a0c10, #0a0c10)";
  const background =
    value === "system"
      ? "linear-gradient(135deg, #f5f6f8 0 50%, #0a0c10 50% 100%)"
      : value === "dark"
        ? dark
        : light;
  return (
    <span
      aria-hidden
      className="relative block h-12 w-full overflow-hidden rounded-md border border-(--line-strong)"
      style={{ background }}
    >
      <span
        className="absolute left-2 top-2 h-3 w-10 rounded-sm"
        style={{ background: value === "dark" ? "#161b22" : "#ffffff" }}
      />
      <span
        className="absolute bottom-2 left-2 h-1.5 w-14 rounded-full"
        style={{
          background: value === "light" ? "#d0d5dd" : value === "dark" ? "#353d48" : "#8b949e",
        }}
      />
    </span>
  );
}

/** Match system, light or dark: native radios, so keyboards and screen readers just work. */
export function ThemeChoice({
  value,
  onChange,
  busy,
  legend = "Theme",
}: {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
  /** Saving stays interactive: arrow keys keep moving while a save is pending. */
  busy?: boolean;
  legend?: string;
}) {
  // Two choosers can be on one page (the first-visit dialog over the profile).
  const name = useId();
  return (
    <fieldset aria-busy={busy || undefined} className="@container flex min-w-0 flex-col gap-3">
      <legend className="sr-only">{legend}</legend>
      <div className="grid min-w-0 gap-3 @md:grid-cols-3">
        {OPTIONS.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cx(
                "flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border bg-(--bg-subtle) p-3",
                checked ? "border-(--ink)" : "border-(--line-strong) hover:border-(--mut)",
              )}
            >
              <Preview value={option.value} />
              <span className="flex items-start gap-2">
                <input
                  type="radio"
                  name={name}
                  value={option.value}
                  checked={checked}
                  onChange={() => onChange(option.value)}
                  className="mt-1 accent-(--ink)"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-(--ink)">{option.label}</span>
                  <span className="text-[12.5px] text-(--mut)">{option.hint}</span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
