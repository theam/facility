import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type Variant = "primary" | "outline" | "ghost" | "textual" | "danger";
type Size = "sm" | "md" | "lg";
type Tone = "agent";

const sizes: Record<Size, string> = {
  sm: "min-h-9 px-3 py-1.5 text-[13px] pointer-coarse:min-h-11",
  md: "min-h-10 px-4 py-2 text-[14px] pointer-coarse:min-h-11",
  lg: "min-h-12 px-6 py-2.5 text-[15px]",
};

/**
 * Buttons always have their own surface and a 6px radius, so they never read as
 * text; links stay plain blue text. Heights follow the pointer: compact with a
 * mouse, 44px on touch screens. One primary action per decision; secondary
 * actions use the filled surface and tertiary actions the ghost style.
 */
function classesFor(variant: Variant, size: Size, tone?: Tone, className?: string) {
  const base =
    "group relative inline-flex max-w-full select-none items-center justify-center gap-2 overflow-hidden rounded-md whitespace-normal text-center font-medium leading-tight transition-colors disabled:pointer-events-none disabled:opacity-50";
  if (variant === "ghost") {
    return cx(
      base,
      sizes[size],
      "border border-transparent text-(--mut) hover:bg-(--card) hover:text-(--ink)",
      className,
    );
  }
  if (variant === "textual") {
    return cx(base, "h-auto rounded-none px-0 text-(--mut) hover:text-(--ink)", className);
  }
  if (variant === "danger") {
    return cx(
      base,
      sizes[size],
      "border border-(--bad)/70 bg-(--bad)/10 text-(--bad) hover:bg-(--bad) hover:text-black",
      className,
    );
  }
  if (variant === "primary") {
    if (tone === "agent") {
      return cx(
        base,
        sizes[size],
        "border border-(--accent)/70 bg-(--accent)/10 text-(--accent)",
        className,
      );
    }
    return cx(
      base,
      sizes[size],
      "border border-transparent bg-(--ink) text-(--bg) hover:bg-white",
      className,
    );
  }
  return cx(
    base,
    sizes[size],
    "border border-(--line) bg-(--card) text-(--ink) hover:border-(--line-strong) hover:bg-[#2a3644]",
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
        "relative z-10 inline-flex min-w-0 items-center gap-2 wrap-anywhere transition-colors",
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

/** The same surface for a navigation link that must look like a button, such as pagination. */
export function buttonClassName({
  variant = "outline",
  size = "sm",
  className,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}) {
  return classesFor(variant, size, undefined, className);
}
