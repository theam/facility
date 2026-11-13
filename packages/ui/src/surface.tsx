import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** A white surface on the canvas: hairline, 12px radius and a faint shadow. */
export const cardClassName =
  "rounded-xl border border-(--line) bg-(--bg-subtle) shadow-(--shadow-card)";

/**
 * One card per topic. An optional header carries the title and a quiet aside
 * (a count, a hint or a link); the body keeps its own spacing.
 */
export function Card({
  title,
  aside,
  children,
  className,
  bodyClassName,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & {
  title?: ReactNode;
  aside?: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <section className={cx(cardClassName, "min-w-0", className)} {...props}>
      {title || aside ? (
        <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-5 pt-4 sm:px-6">
          {title ? <h2 className="text-[15px] font-semibold text-(--ink)">{title}</h2> : null}
          {aside ? <div className="text-[13px] text-(--dim)">{aside}</div> : null}
        </header>
      ) : null}
      <div className={cx("px-5 py-4 sm:px-6", bodyClassName)}>{children}</div>
    </section>
  );
}

const kpiTones = {
  human: "text-(--human)",
  ok: "text-(--ok)",
  bad: "text-(--bad)",
  info: "text-(--info)",
} as const;

/** A headline number with its label and one line of context. */
export function KpiCard({
  label,
  value,
  hint,
  tone,
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "human" | "ok" | "bad" | "info";
  className?: string;
}) {
  return (
    <div className={cx(cardClassName, "flex min-w-0 flex-col gap-1.5 px-5 py-4", className)}>
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-(--dim)">
        {label}
      </span>
      <span
        className={cx(
          "tabular text-[28px] font-semibold leading-tight tracking-tight",
          tone ? kpiTones[tone] : "text-(--ink)",
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-[13px] text-(--mut)">{hint}</span> : null}
    </div>
  );
}

const pillTones = {
  ok: "bg-[#ecfdf3] text-(--ok)",
  bad: "bg-[#fef3f2] text-(--bad)",
  human: "bg-[#fffaeb] text-(--human)",
  info: "bg-[#eff6ff] text-(--info)",
  agent: "bg-[#fff8d6] text-(--accent-ink)",
  neutral: "bg-(--card) text-(--mut)",
} as const;

/** A rounded status label with a dot, readable without its color. */
export function StatusPill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof pillTones;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[12px] font-medium",
        pillTones[tone],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {children}
    </span>
  );
}
