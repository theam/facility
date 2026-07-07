import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Variant = "primary" | "outline" | "textual" | "danger";
type Size = "sm" | "md" | "lg";
type Tone = "agent";

const sizes: Record<Size, string> = {
  sm: "h-8 px-3.5 text-[12.5px]",
  md: "h-10 px-6 text-[13px]",
  lg: "h-[52px] px-10 text-[13.5px]",
};

function classesFor(variant: Variant, size: Size, tone?: Tone, className?: string) {
  const base =
    "group relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors disabled:pointer-events-none disabled:opacity-50";
  if (variant === "textual") {
    return cx(base, "h-auto px-0 text-(--mut) hover:text-(--ink)", className);
  }
  if (variant === "danger") {
    return cx(
      base,
      sizes[size],
      "border border-(--bad) text-(--bad) hover:bg-(--bad) hover:text-black",
      className,
    );
  }
  if (variant === "primary") {
    if (tone === "agent") {
      return cx(base, sizes[size], "border border-(--accent) text-(--accent)", className);
    }
    return cx(
      base,
      sizes[size],
      "border border-(--line-strong) bg-(--ink) text-(--bg) hover:bg-(--card) hover:text-(--ink)",
      className,
    );
  }
  return cx(
    base,
    sizes[size],
    "border border-(--line) text-(--mut) hover:border-(--line-strong) hover:text-(--ink)",
    className,
  );
}

/** Agent buttons carry the sliding accent fill — text flips to black on hover. */
function Fill({ variant, tone }: { variant: Variant; tone?: Tone }) {
  if (variant !== "primary" || tone !== "agent") return null;
  return (
    <span
      aria-hidden
      className="absolute inset-0 origin-left scale-x-0 bg-(--accent) transition-transform duration-300 group-hover:scale-x-100"
    />
  );
}

function Label({
  variant,
  tone,
  children,
}: {
  variant: Variant;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "relative z-10 inline-flex items-center gap-2 transition-colors",
        variant === "primary" && tone === "agent" && "group-hover:text-black",
      )}
    >
      {children}
      {variant === "textual" ? <span aria-hidden>→</span> : null}
    </span>
  );
}

export function Button({
  variant = "outline",
  size = "md",
  tone,
  className,
  children,
  type,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; tone?: Tone }) {
  return (
    <button
      type={type ?? "button"}
      className={classesFor(variant, size, tone, className)}
      {...props}
    >
      <Fill variant={variant} tone={tone} />
      <Label variant={variant} tone={tone}>
        {children}
      </Label>
    </button>
  );
}

export function ButtonLink({
  variant = "outline",
  size = "md",
  tone,
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: Size; tone?: Tone }) {
  return (
    <a className={classesFor(variant, size, tone, className)} {...props}>
      <Fill variant={variant} tone={tone} />
      <Label variant={variant} tone={tone}>
        {children}
      </Label>
    </a>
  );
}
