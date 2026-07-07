"use client";

import { cx } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/api";

type PaletteProject = Pick<Project, "id" | "slug" | "name">;

type Entry = { id: string; label: string; hint: string; href: string };

/**
 * ⌘K navigation palette. Deliberately dependency-free: jump to any project or
 * section from anywhere. Verbs (trigger, approve, …) join as surfaces land.
 */
export function CommandPalette({
  projects,
  currentProject,
}: {
  projects: PaletteProject[];
  currentProject?: PaletteProject;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const scoped: Entry[] = currentProject
      ? [
          {
            id: "p-overview",
            label: `${currentProject.slug} · overview`,
            hint: "project",
            href: `/projects/${currentProject.id}`,
          },
          {
            id: "p-issues",
            label: `${currentProject.slug} · issues`,
            hint: "project",
            href: `/projects/${currentProject.id}/issues`,
          },
          {
            id: "p-sessions",
            label: `${currentProject.slug} · sessions`,
            hint: "project",
            href: `/projects/${currentProject.id}/sessions`,
          },
          {
            id: "p-settings",
            label: `${currentProject.slug} · settings`,
            hint: "project",
            href: `/projects/${currentProject.id}/settings`,
          },
        ]
      : [];
    const org: Entry[] = [
      { id: "o-projects", label: "projects", hint: "org", href: "/projects" },
      { id: "o-inbox", label: "inbox", hint: "org", href: "/inbox" },
      { id: "o-harness", label: "harness", hint: "org", href: "/harness" },
      { id: "o-audit", label: "audit", hint: "org", href: "/audit" },
      { id: "o-settings", label: "org settings", hint: "org", href: "/settings" },
      { id: "o-kickstart", label: "kickstart a project", hint: "org", href: "/projects/new" },
    ];
    const projectEntries: Entry[] = projects
      .filter((p) => p.id !== currentProject?.id)
      .map((p) => ({
        id: `proj-${p.id}`,
        label: p.slug,
        hint: "switch project",
        href: `/projects/${p.id}`,
      }));
    return [...scoped, ...org, ...projectEntries];
  }, [projects, currentProject]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.label.toLowerCase().includes(q));
  }, [entries, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setCursor(0);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
      }
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setCursor(0);
  }, []);

  if (!open) return null;

  const go = (entry: Entry | undefined) => {
    if (!entry) return;
    close();
    router.push(entry.href);
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 pt-[18vh]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="w-full max-w-lg border border-(--line) bg-(--bg)">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(filtered[cursor]);
            }
          }}
          placeholder="Jump to…"
          aria-label="Jump to"
          className="w-full border-b border-(--line) bg-transparent px-5 py-4 font-mono text-[14px] text-(--ink) outline-none placeholder:text-(--dim)"
        />
        <div className="max-h-80 overflow-y-auto py-1">
          {filtered.map((entry, i) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => go(entry)}
              onPointerMove={() => setCursor(i)}
              className={cx(
                "flex w-full items-baseline gap-3 px-5 py-2.5 text-left",
                i === cursor ? "bg-(--card) text-(--ink)" : "text-(--mut)",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{entry.label}</span>
              <span className="shrink-0 text-[10.5px] font-medium text-(--dim)">{entry.hint}</span>
            </button>
          ))}
          {filtered.length === 0 ? (
            <p className="px-5 py-4 font-mono text-[11.5px] text-(--dim)">nothing matches</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
