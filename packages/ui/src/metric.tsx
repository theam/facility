import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Proof-figure treatment: number + unit as one atomic unit, always mono,
 * always tabular. Numbers are live, never curated — pass real data only.
 */
export function Metric({
  label,
  value,
  unit,
  hint,
  tone,
  size = "md",
  className,
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: ReactNode;
  tone?: "ok" | "bad" | "agent" | "human";
  size?: "md" | "lg";
  className?: string;
}) {
  const toneClass =
    tone === "ok"
      ? "text-(--ok)"
      : tone === "bad"
        ? "text-(--bad)"
        : tone === "agent"
          ? "text-(--accent-ink)"
          : tone === "human"
            ? "text-(--human)"
            : "text-(--ink)";
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      <span className="eyebrow">{label}</span>
      <span
        className={cx(
          "tabular font-mono font-semibold leading-none",
          size === "lg" ? "text-[clamp(34px,4vw,52px)]" : "text-[clamp(24px,3vw,34px)]",
          toneClass,
        )}
      >
        {value}
        {unit ? <span className="ml-1 text-[0.55em] font-medium text-(--mut)">{unit}</span> : null}
      </span>
      {hint ? <span className="text-[12px] leading-relaxed text-(--dim)">{hint}</span> : null}
    </div>
  );
}
