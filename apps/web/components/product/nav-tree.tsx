"use client";

import { cx } from "@facility/ui";
import { useMemo, useState } from "react";
import {
  artifactIdFor,
  type KbChainId,
  type KbDecision,
  type KbEntry,
  type KbSection,
} from "@/lib/kb";

/**
 * The left page tree: pinned context docs, then Decisions / Documentation /
 * Signals as first-class sections, pipeline + research artifacts tucked
 * behind a collapsed group. Filter narrows by slug or artifact id.
 */
const EMPTY_HINTS: Record<string, string> = {
  D: "no decisions recorded yet — capture the first ADR",
  R: "no documentation pages yet",
  S: "no signals yet — paste a transcript into the chat",
};

function emptyHintFor(sectionKey: string, chain: KbChainId): string {
  if (sectionKey === "L") {
    return chain === "product"
      ? "no learnings yet — the learning agent files them after runs"
      : "no literature notes yet";
  }
  return EMPTY_HINTS[sectionKey] ?? "nothing here yet";
}

export function NavTree({
  sections,
  decisions,
  selected,
  canWrite,
  chain,
  onSelect,
  onNew,
}: {
  sections: KbSection[];
  decisions: KbDecision[];
  selected: string;
  canWrite: boolean;
  chain: KbChainId;
  onSelect: (doc: string) => void;
  onNew: (type: "R" | "D") => void;
}) {
  const [filter, setFilter] = useState("");

  const decisionRows = useMemo(() => {
    const active = decisions.filter((d) => d.active);
    const retired = decisions.filter((d) => !d.active);
    const byNumber = (a: KbDecision, b: KbDecision) => b.number - a.number;
    return [...active.sort(byNumber), ...retired.sort(byNumber)];
  }, [decisions]);

  const needle = filter.trim().toLowerCase();
  const matches = (entry: KbEntry) =>
    !needle ||
    entry.slug.toLowerCase().includes(needle) ||
    artifactIdFor(entry).toLowerCase().includes(needle);

  return (
    <nav aria-label="Knowledge base" className="flex flex-col gap-4">
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter pages"
        aria-label="Filter pages"
        className="border border-(--line) bg-(--bg-subtle) px-3 py-1.5 text-[12px] text-(--ink) outline-none placeholder:text-(--dim) focus:border-(--line-strong)"
      />

      {sections
        .filter((s) => !s.secondary)
        .map((section) => {
          const rows =
            section.key === "D" ? decisionRows.filter(matches) : section.entries.filter(matches);
          return (
            <SectionBlock
              key={section.key}
              label={section.label}
              count={rows.length}
              onNew={
                canWrite && (section.key === "D" || section.key === "R")
                  ? () => onNew(section.key as "R" | "D")
                  : undefined
              }
            >
              {rows.length === 0 ? (
                <p className="px-2 py-1.5 text-[11.5px] italic text-(--dim)">
                  {emptyHintFor(section.key, chain)}
                </p>
              ) : (
                rows.map((entry) => (
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    selected={selected}
                    onSelect={onSelect}
                    supersededBy={
                      section.key === "D" ? ((entry as KbDecision).supersededBy ?? null) : null
                    }
                  />
                ))
              )}
            </SectionBlock>
          );
        })}

      {sections
        .filter((s) => s.secondary)
        .map((section) => {
          const rows = section.entries.filter(matches);
          return (
            <SectionBlock key={section.key} label={section.label} count={rows.length + 2}>
              {/* The freeform home: the context docs live here alongside any
                  page outside the four structured sections. */}
              {(
                [
                  { key: "charter", id: "CHARTER", label: "charter" },
                  { key: "active", id: "ACTIVE", label: "active" },
                ] as const
              ).map((pin) => (
                <button
                  key={pin.key}
                  type="button"
                  onClick={() => onSelect(pin.key)}
                  className={cx(
                    "flex items-baseline gap-2 px-2 py-1.5 text-left text-[12.5px] hover:text-(--ink)",
                    selected === pin.key ? "font-medium text-(--ink)" : "text-(--mut)",
                  )}
                >
                  <span className="shrink-0 font-mono text-[10.5px] text-(--dim)">{pin.id}</span>
                  <span className="min-w-0 truncate">{pin.label}</span>
                </button>
              ))}
              {rows.map((entry) => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  selected={selected}
                  onSelect={onSelect}
                  supersededBy={null}
                />
              ))}
            </SectionBlock>
          );
        })}
    </nav>
  );
}

function SectionBlock({
  label,
  count,
  onNew,
  children,
}: {
  label: string;
  count: number;
  onNew?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between">
        <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-(--dim)">
          {label} · {count}
        </span>
        {onNew ? (
          <button
            type="button"
            onClick={onNew}
            className="font-mono text-[11px] text-(--dim) hover:text-(--ink)"
            title={`new ${label} page`}
          >
            + new
          </button>
        ) : null}
      </div>
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

function EntryRow({
  entry,
  selected,
  supersededBy,
  onSelect,
}: {
  entry: KbEntry;
  selected: string;
  supersededBy: string | null;
  onSelect: (doc: string) => void;
}) {
  const id = artifactIdFor(entry);
  const retired = entry.status === "superseded";
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      title={entry.slug}
      className={cx(
        "flex items-baseline gap-2 px-2 py-1.5 text-left text-[12.5px] hover:text-(--ink)",
        selected === id ? "font-medium text-(--ink)" : retired ? "text-(--dim)" : "text-(--mut)",
      )}
    >
      <span className="shrink-0 font-mono text-[10.5px] text-(--dim)">{id}</span>
      <span
        className={cx("min-w-0 truncate", retired && "line-through decoration-(--line-strong)")}
      >
        {entry.slug.replaceAll("-", " ")}
      </span>
      {retired && supersededBy ? (
        <span className="shrink-0 font-mono text-[9.5px] text-(--dim)">→ {supersededBy}</span>
      ) : retired ? (
        <span className="shrink-0 text-[9.5px] font-medium text-(--dim)">old</span>
      ) : null}
    </button>
  );
}
