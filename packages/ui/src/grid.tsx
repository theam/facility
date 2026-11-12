import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * A grid of cards. Each cell is its own white card, so an incomplete last row
 * leaves canvas, not an empty tile.
 */
export function HairlineGrid({
  className,
  cols = "sm:grid-cols-2 lg:grid-cols-3",
  ...props
}: HTMLAttributes<HTMLDivElement> & { cols?: string }) {
  return (
    <div
      className={cx("grid gap-3", cols, className)}
      {...props}
    />
  );
}

export function Cell({
  className,
  interactive = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cx(
        "group relative overflow-hidden rounded-xl border border-(--line) bg-(--bg-subtle) p-6 shadow-(--shadow-card) sm:p-8",
        interactive && "transition-colors hover:border-(--line-strong)",
        className,
      )}
      {...props}
    />
  );
}

/** Accent top bar that slides in on hover — marks agent-related cells only. */
export function CellAccent() {
  return (
    <span
      aria-hidden
      className="absolute inset-x-0 top-0 h-[2px] origin-left scale-x-0 bg-(--accent) transition-transform duration-300 group-hover:scale-x-100"
    />
  );
}
