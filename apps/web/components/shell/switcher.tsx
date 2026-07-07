"use client";

import { cx } from "@facility/ui";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Project } from "@/lib/api";

type SwitcherProject = Pick<Project, "id" | "slug" | "name">;

/**
 * Vercel-style project switcher: the current project is the topbar's anchor,
 * every other project is one click away. Falls back to a "pick a project"
 * affordance on org-level pages.
 */
export function ProjectSwitcher({
  projects,
  current,
}: {
  projects: SwitcherProject[];
  current?: SwitcherProject;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const filtered = query.trim()
    ? projects.filter((p) =>
        `${p.slug} ${p.name}`.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : projects;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex min-w-0 items-center gap-2 font-mono text-[13px] text-(--ink) hover:text-(--accent)"
      >
        <span className="truncate">{current ? current.slug : "select project"}</span>
        <span aria-hidden className="text-[9px] text-(--dim)">
          ▾
        </span>
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 border border-(--line) bg-(--bg) shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="find project…"
            aria-label="Find project"
            className="w-full border-b border-(--line) bg-transparent px-4 py-2.5 font-mono text-[12px] text-(--ink) outline-none placeholder:text-(--dim)"
          />
          <div className="max-h-72 overflow-y-auto" role="listbox">
            {filtered.map((project) => (
              <Link
                key={project.id}
                href={`/projects/${project.id}`}
                onClick={() => setOpen(false)}
                className={cx(
                  "flex items-baseline gap-3 px-4 py-2.5 transition-colors hover:bg-(--card)",
                  project.id === current?.id && "bg-(--card)",
                )}
              >
                <span className="min-w-0 truncate font-mono text-[12.5px] text-(--ink)">
                  {project.slug}
                </span>
                <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-(--dim)">
                  {project.name}
                </span>
              </Link>
            ))}
            {filtered.length === 0 ? (
              <p className="px-4 py-3 font-mono text-[11px] text-(--dim)">no match</p>
            ) : null}
          </div>
          <Link
            href="/projects"
            onClick={() => setOpen(false)}
            className="block border-t border-(--line) px-4 py-2.5 text-[12px] font-medium text-(--mut) hover:text-(--ink)"
          >
            all projects →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
