"use client";

import { PillTag } from "@facility/ui";
import { useMemo, useState } from "react";
import { type GhIssue, IssueRow } from "./issue-row";

/** Issue mirror as a workspace: search + label facet over the loaded page. */
export function IssueList({
  projectId,
  items,
  canTrigger,
}: {
  projectId: string;
  items: GhIssue[];
  canTrigger: boolean;
}) {
  const [q, setQ] = useState("");
  const [label, setLabel] = useState("");

  const labels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const issue of items) {
      for (const l of issue.labels) counts.set(l, (counts.get(l) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [items]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((issue) => {
      if (label && !issue.labels.includes(label)) return false;
      if (!needle) return true;
      return [`#${issue.number}`, issue.title, issue.author ?? "", issue.labels.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, q, label]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search issues…"
          className="h-8 w-56 border border-(--line) bg-transparent px-3 font-mono text-[12px] text-(--ink) outline-none placeholder:text-(--dim) focus:border-(--line-strong)"
          aria-label="search issues"
        />
        {labels.map(([name, count]) => (
          <button key={name} type="button" onClick={() => setLabel(label === name ? "" : name)}>
            <PillTag active={label === name}>
              {name} · {count}
            </PillTag>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="border border-(--line) px-5 py-6 text-sm text-(--dim)">
          Nothing matches this filter.
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {filtered.map((issue) => (
            <IssueRow key={issue.id} projectId={projectId} issue={issue} canTrigger={canTrigger} />
          ))}
        </div>
      )}
    </div>
  );
}
