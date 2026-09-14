"use client";

import { useId, useState } from "react";
import { Markdown } from "@/components/markdown";

const PREVIEW_CHARS = 900;
const EXPAND_THRESHOLD = 1_600;

/**
 * Renders a long message once: the preview or the full text, never both, so
 * expanding does not duplicate content in the document.
 */
export function ExpandableMarkdown({ source, label }: { source: string; label: string }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const long = source.length > EXPAND_THRESHOLD;
  const shown = long && !expanded ? `${source.slice(0, PREVIEW_CHARS).trimEnd()}…` : source;
  return (
    <div id={id} className="flex min-w-0 flex-col gap-3">
      <Markdown source={shown} />
      {long ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="w-fit text-[12.5px] text-(--info) underline-offset-4 hover:underline"
        >
          {expanded ? `Show less of ${label}` : `Read the full ${label}`}
        </button>
      ) : null}
    </div>
  );
}
