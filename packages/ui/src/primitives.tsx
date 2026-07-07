import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** Calm sans section label. Mono stays reserved for technical tokens. */
export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cx("eyebrow", className)} {...props} />;
}

/** Zero-padded numeral anchor (01, 02, …). Alternative to Eyebrow, never both. */
export function NumeralAnchor({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cx("font-mono text-[11px] tracking-[0.24em]", className ?? "text-(--dim)")}>
      {String(n).padStart(2, "0")}
    </span>
  );
}

/** The only pill-shaped element in the system. Category or toggle chips. */
export function PillTag({
  children,
  active = false,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { active?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex h-7 items-center rounded-full border px-3 text-[12px] font-medium",
        active ? "border-(--line-strong) bg-(--card) text-(--ink)" : "border-(--line) text-(--mut)",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export type Semantic = "agent" | "human" | "ok" | "bad" | "info" | "machine" | "muted";

const semanticVar: Record<Semantic, string> = {
  agent: "var(--accent)",
  human: "var(--human)",
  ok: "var(--ok)",
  bad: "var(--bad)",
  info: "var(--info)",
  machine: "var(--machine)",
  muted: "var(--dim)",
};

/** Small square status marker. `pulse` reserves motion for live agent work. */
export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Semantic;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cx("relative inline-flex h-2 w-2", className)} aria-hidden>
      <span className="absolute inset-0" style={{ background: semanticVar[tone] }} />
      {pulse ? (
        <span
          className="absolute inset-0 animate-ping"
          style={{ background: semanticVar[tone], opacity: 0.6 }}
        />
      ) : null}
    </span>
  );
}

/** Rectangular legend chip (AI / HUMAN / CODE) — black text on semantic color. */
export function LegendChip({ tone, children }: { tone: Semantic; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-[0.12em] text-black"
      style={{ background: semanticVar[tone] }}
    >
      {children}
    </span>
  );
}

export function toneFor(status: string): Semantic {
  switch (status) {
    case "running":
    case "provisioning":
      return "agent";
    case "awaiting_human":
    case "open":
      return "human";
    case "succeeded":
    case "approved":
    case "merged":
    case "ok":
      return "ok";
    case "failed":
    case "rejected":
    case "corrupted":
    case "error":
      return "bad";
    case "queued":
    case "draft":
      return "info";
    default:
      return "machine";
  }
}

/** Section separator — hairline, generous air. */
export function Divider({ className }: { className?: string }) {
  return <div className={cx("border-t border-(--line)", className)} />;
}

/** Callout: pad 48, gap 24, radius 4, surface tint, one CTA max. */
export function Callout({
  eyebrow,
  heading,
  children,
  action,
  className,
}: {
  eyebrow?: string;
  heading: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-6 rounded-[4px] bg-(--card) p-8 sm:p-12", className)}>
      {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
      <h3 className="text-xl font-semibold leading-snug text-(--ink)">{heading}</h3>
      {children ? <div className="text-sm leading-relaxed text-(--mut)">{children}</div> : null}
      {action ? <div>{action}</div> : null}
    </div>
  );
}
