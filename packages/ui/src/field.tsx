import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cx } from "./cx";

/** Boxed register: quiet sans label, 1px border, surface tint. */
export function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and wrapped by this label (valid implicit association).
    <label className={cx("flex flex-col gap-2", className)}>
      <span className="text-[11.5px] font-medium text-(--mut)">{label}</span>
      {children}
      {error ? (
        <span className="text-[12px] text-(--bad)">{error}</span>
      ) : hint ? (
        <span className="text-[12px] text-(--dim)">{hint}</span>
      ) : null}
    </label>
  );
}

const inputClasses =
  "h-10 w-full border border-(--line) bg-(--bg-subtle) px-3 text-[14px] text-(--ink) placeholder:text-(--dim) hover:border-(--line-strong)";

export function TextInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(inputClasses, className)} {...props} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(inputClasses, "h-auto min-h-[96px] py-2 leading-relaxed", className)}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputClasses, "appearance-none pr-8", className)} {...props}>
      {children}
    </select>
  );
}
