import type { ReactNode } from "react";
import { cx } from "./cx";
import type { Semantic } from "./primitives";

const lineColor: Record<Semantic | "plain", string> = {
  agent: "text-(--accent)",
  human: "text-(--human)",
  ok: "text-(--ok)",
  bad: "text-(--bad)",
  info: "text-(--info)",
  machine: "text-(--machine)",
  muted: "text-(--dim)",
  plain: "text-(--code)",
};

export type TerminalLine = {
  text: string;
  tone?: Semantic | "plain";
  /** left gutter tag, e.g. a timestamp or event type */
  tag?: string;
};

/** Code/transcript surface: bg-subtle, mono, status-colored lines. */
export function Terminal({
  title,
  lines,
  footer,
  className,
  children,
  maxHeight = "max-h-[480px]",
}: {
  title: string;
  lines?: TerminalLine[];
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
  maxHeight?: string;
}) {
  return (
    <div className={cx("flex min-h-0 flex-col border border-(--line) bg-(--bg-subtle)", className)}>
      <div className="flex items-center justify-between border-b border-(--line) px-5 py-3">
        <span className="text-[11px] font-medium text-(--mut)">{title}</span>
      </div>
      <div className={cx("overflow-y-auto overflow-x-auto px-5 py-4", maxHeight)}>
        {lines ? (
          <pre className="font-mono text-[12.5px] leading-[2.1]">
            {lines.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only stream
              <div key={i} className="flex gap-4">
                {line.tag ? (
                  <span className="shrink-0 select-none text-(--dim)">{line.tag}</span>
                ) : null}
                <span
                  className={cx("whitespace-pre-wrap break-words", lineColor[line.tone ?? "plain"])}
                >
                  {line.text}
                </span>
              </div>
            ))}
          </pre>
        ) : null}
        {children}
      </div>
      {footer ? <div className="border-t border-(--line) px-5 py-3">{footer}</div> : null}
    </div>
  );
}
