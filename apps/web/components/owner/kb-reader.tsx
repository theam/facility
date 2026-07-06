"use client";

import { cx, PillTag } from "@facility/ui";
import { useMemo, useState } from "react";

export type KbEntry = {
  id: string;
  type: string;
  number: number;
  slug: string;
  frontmatter: Record<string, unknown>;
  bodyMd: string;
  status: string | null;
  supersedes: string | null;
};

export type KbSpace = {
  charterMd: string;
  activeMd: string;
};

const TYPE_LABELS: Record<string, string> = {
  S: "signals",
  D: "decisions",
  T: "tasks",
  V: "verifications",
  H: "hypotheses",
  E: "experiments",
  F: "findings",
  L: "learnings",
  CR: "change requests",
  SR: "status reports",
};

type Doc = { kind: "charter" } | { kind: "active" } | { kind: "entry"; entry: KbEntry };

/**
 * The Owner's knowledge base, readable like a wiki: charter + active pinned,
 * the typed artifact chain grouped and ordered, every entry one click away.
 */
export function KbReader({ space, entries }: { space: KbSpace; entries: KbEntry[] }) {
  const [doc, setDoc] = useState<Doc>({ kind: "active" });

  const groups = useMemo(() => {
    const byType = new Map<string, KbEntry[]>();
    for (const entry of entries) {
      byType.set(entry.type, [...(byType.get(entry.type) ?? []), entry]);
    }
    for (const list of byType.values()) list.sort((a, b) => b.number - a.number);
    return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  const selectedEntry = doc.kind === "entry" ? doc.entry : null;
  const body =
    doc.kind === "charter"
      ? space.charterMd
      : doc.kind === "active"
        ? space.activeMd
        : (selectedEntry?.bodyMd ?? "");

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
      <nav aria-label="Knowledge base" className="flex flex-col gap-4">
        <div className="flex flex-col border border-(--line)">
          {(
            [
              { key: "charter", label: "charter" },
              { key: "active", label: "active" },
            ] as const
          ).map((pin) => (
            <button
              key={pin.key}
              type="button"
              onClick={() => setDoc({ kind: pin.key })}
              className={cx(
                "border-b border-(--line) px-4 py-2.5 text-left font-mono text-[12px] uppercase tracking-[0.16em] last:border-b-0 hover:bg-(--card)",
                doc.kind === pin.key ? "bg-(--card) text-(--ink)" : "text-(--mut)",
              )}
            >
              {pin.label}
            </button>
          ))}
        </div>
        {groups.map(([type, list]) => (
          <div key={type} className="flex flex-col gap-1">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.22em] text-(--dim)">
              {TYPE_LABELS[type] ?? type} · {list.length}
            </span>
            <div className="flex flex-col">
              {list.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => setDoc({ kind: "entry", entry })}
                  className={cx(
                    "flex items-baseline gap-2 px-2 py-1.5 text-left font-mono text-[11.5px] hover:text-(--ink)",
                    selectedEntry?.id === entry.id ? "text-(--ink)" : "text-(--mut)",
                  )}
                >
                  <span className="shrink-0 text-(--dim)">
                    {entry.type}-{entry.number}
                  </span>
                  <span className="min-w-0 truncate">{entry.slug}</span>
                  {entry.status === "superseded" ? (
                    <span className="text-[9px] uppercase text-(--dim)">old</span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))}
        {entries.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-(--dim)">
            No entries yet — the Owner writes them as it works.
          </p>
        ) : null}
      </nav>

      <article className="flex min-w-0 flex-col gap-3">
        {selectedEntry ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[12px] text-(--ink)">
              {selectedEntry.type}-{selectedEntry.number} · {selectedEntry.slug}
            </span>
            {selectedEntry.status ? <PillTag>{selectedEntry.status}</PillTag> : null}
            {selectedEntry.supersedes ? (
              <span className="font-mono text-[10px] text-(--dim)">
                supersedes {selectedEntry.supersedes}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="font-mono text-[12px] uppercase tracking-[0.16em] text-(--dim)">
            {doc.kind}
          </span>
        )}
        <pre className="max-h-[68vh] overflow-auto whitespace-pre-wrap border border-(--line) bg-(--bg-subtle) p-5 font-mono text-[12.5px] leading-relaxed text-(--mut)">
          {body || "(empty)"}
        </pre>
      </article>
    </div>
  );
}
