"use client";

import { cx } from "@facility/ui";
import { can } from "@/lib/permissions";

type Props = {
  value: string[];
  onChange: (next: string[]) => void;
  /** The caller's own grants — boxes they can't grant render disabled. */
  grantable: string[];
  resources: string[];
  special: string[];
};

/**
 * Grouped permission editing — resource × read/write plus the special verbs.
 * The API re-validates grantability on save; disabling here is guidance only.
 */
export function PermissionMatrix({ value, onChange, grantable, resources, special }: Props) {
  const selected = new Set(value);
  const modeled = new Set([...resources.flatMap((r) => [`${r}:read`, `${r}:write`]), ...special]);
  const extras = value.filter((p) => !modeled.has(p));

  function toggle(perm: string) {
    const next = new Set(selected);
    if (next.has(perm)) next.delete(perm);
    else next.add(perm);
    onChange([...next].sort());
  }

  function box(perm: string, label: string) {
    const checked = selected.has(perm);
    const allowed = can(grantable, perm);
    return (
      <button
        key={perm}
        type="button"
        disabled={!allowed}
        onClick={() => toggle(perm)}
        title={allowed ? perm : `${perm} — you don't hold this, so you can't grant it`}
        className={cx(
          "inline-flex h-7 items-center border px-2 text-[11px] font-medium transition-colors",
          checked
            ? "border-(--line-strong) bg-(--card) text-(--ink)"
            : "border-(--line) text-(--dim)",
          allowed
            ? "hover:border-(--line-strong) hover:text-(--ink)"
            : "cursor-not-allowed opacity-40",
        )}
        aria-pressed={checked}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {resources.map((resource) => (
          <div key={resource} className="flex items-center justify-between gap-3 py-0.5">
            <span className="font-mono text-[11.5px] text-(--mut)">{resource}</span>
            <span className="flex gap-1.5">
              {box(`${resource}:read`, "read")}
              {box(`${resource}:write`, "write")}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium text-(--dim)">special verbs</span>
        <div className="flex flex-wrap gap-1.5">{special.map((perm) => box(perm, perm))}</div>
      </div>
      {extras.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-(--dim)">other grants</span>
          {extras.map((perm) => (
            <button
              key={perm}
              type="button"
              onClick={() => toggle(perm)}
              className="inline-flex h-7 items-center border border-(--line-strong) bg-(--card) px-2 font-mono text-[10px] text-(--ink)"
              title="click to remove"
            >
              {perm} ×
            </button>
          ))}
        </div>
      ) : null}
      <p className="text-[11.5px] leading-relaxed text-(--dim)">
        Empty means the Harness floor (read-only KB/Harness context). At session time grants are
        clamped to the safe set regardless — an agent can never carry tenant-admin or gate
        decisions.
      </p>
    </div>
  );
}
