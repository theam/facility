"use client";

import { cx } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef } from "react";
import type { ProjectBacklog } from "@/lib/api";
import {
  activeFilterCount,
  personLabel,
  type StoriesSearch,
  storiesHref,
} from "@/lib/backlog-presentation";

/**
 * Filters are a plain GET form: every choice becomes a URL parameter, so a
 * view can be shared, reloaded, and read back by the server without client
 * state. Menus submit as soon as a choice changes; the search box submits on
 * Enter or with the button.
 */
export function BacklogFilters({
  projectId,
  search,
  facets,
  viewer,
}: {
  projectId: string;
  search: StoriesSearch;
  facets: ProjectBacklog["facets"];
  viewer: { userId: string | null; githubLogin: string | null };
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const searchId = useId();
  const submit = () => form.current?.requestSubmit();
  const active = activeFilterCount(search);
  const assigneeOptions = facets.assignees.filter(
    (person) =>
      person.key !== `user:${viewer.userId}` &&
      (person.login === null || person.login !== viewer.githubLogin),
  );

  return (
    <form
      ref={form}
      method="get"
      action={`/projects/${encodeURIComponent(projectId)}/stories`}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const params = new URLSearchParams();
        for (const [key, value] of data.entries()) {
          if (typeof value === "string" && value) params.append(key, value);
        }
        router.push(
          `/projects/${encodeURIComponent(projectId)}/stories${params.size ? `?${params}` : ""}`,
        );
      }}
      className="flex flex-col gap-3"
      aria-label="Filter the backlog"
    >
      {search.phase.map((phase) => (
        <input key={phase} type="hidden" name="phase" value={phase} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={searchId} className="sr-only">
          Search by ticket number or words
        </label>
        <input
          id={searchId}
          type="search"
          name="q"
          defaultValue={search.q}
          placeholder="Search #123 or words"
          className="h-9 w-full min-w-0 border border-(--line) bg-(--bg-subtle) px-3 text-[13px] text-(--ink) placeholder:text-(--dim) hover:border-(--line-strong) sm:w-64"
        />
        <Menu label="Labels" count={search.label.length}>
          {facets.labels.length === 0 ? (
            <Empty>No labels on open work.</Empty>
          ) : (
            facets.labels.map((label) => (
              <Option
                key={label.name}
                name="label"
                value={label.name}
                checked={search.label.some(
                  (selected) => selected.toLowerCase() === label.name.toLowerCase(),
                )}
                onChange={submit}
                hint={String(label.count)}
              >
                {label.name}
              </Option>
            ))
          )}
        </Menu>
        <Menu label="Assignees" count={search.assignee.length}>
          <Option
            name="assignee"
            value="me"
            checked={search.assignee.includes("me")}
            onChange={submit}
          >
            Assigned to me
          </Option>
          <Option
            name="assignee"
            value="unassigned"
            checked={search.assignee.includes("unassigned")}
            onChange={submit}
            hint={String(facets.unassigned)}
          >
            Unassigned
          </Option>
          {assigneeOptions.map((person) => (
            <Option
              key={person.key}
              name="assignee"
              value={person.key}
              checked={search.assignee.includes(person.key)}
              onChange={submit}
              hint={String(person.count)}
            >
              {personLabel(person)}
              {person.sources.includes("github") && person.sources.includes("facility")
                ? ""
                : person.sources.includes("github")
                  ? " · GitHub"
                  : " · Facility"}
            </Option>
          ))}
        </Menu>
        {facets.repositories.length > 1 ? (
          <Menu label="Repository" count={search.repository.length}>
            {facets.repositories.map((repository) => (
              <Option
                key={repository.id}
                name="repository"
                value={repository.id}
                checked={search.repository.includes(repository.id)}
                onChange={submit}
                hint={String(repository.count)}
              >
                {repository.name}
              </Option>
            ))}
          </Menu>
        ) : null}
        <label className="flex h-9 items-center gap-2 border border-(--line) px-3 text-[12.5px] text-(--mut)">
          <span className="text-(--dim)">Sort</span>
          <select
            name="sort"
            defaultValue={search.sort}
            onChange={submit}
            className="bg-transparent text-(--ink) outline-none"
          >
            <option value="priority">Needs action first</option>
            <option value="updated">Recently active</option>
            <option value="created">Recently added</option>
          </select>
        </label>
        <button
          type="submit"
          className="h-9 border border-(--line) px-3 text-[12.5px] text-(--mut) hover:border-(--line-strong) hover:text-(--ink)"
        >
          Apply
        </button>
        {active > 0 ? (
          <Link
            href={storiesHref(projectId, search, {
              q: "",
              label: [],
              assignee: [],
              repository: [],
              sort: "priority",
              page: 1,
            })}
            className="text-[12px] text-(--dim) underline-offset-4 hover:text-(--ink) hover:underline"
          >
            Clear {active === 1 ? "filter" : `${active} filters`}
          </Link>
        ) : null}
      </div>
    </form>
  );
}

function Menu({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <details className="relative">
      <summary
        className={cx(
          "flex h-9 cursor-pointer list-none items-center gap-2 border px-3 text-[12.5px] hover:border-(--line-strong) hover:text-(--ink) [&::-webkit-details-marker]:hidden",
          count > 0 ? "border-(--line-strong) text-(--ink)" : "border-(--line) text-(--mut)",
        )}
      >
        {label}
        {count > 0 ? <span className="font-mono text-[11px] text-(--accent)">{count}</span> : null}
        <span aria-hidden className="text-(--dim)">
          ▾
        </span>
      </summary>
      <div className="absolute left-0 z-20 mt-1 flex max-h-72 w-64 flex-col overflow-y-auto border border-(--line) bg-(--bg) p-1 shadow-(--shadow-lift)">
        {children}
      </div>
    </details>
  );
}

function Option({
  name,
  value,
  checked,
  onChange,
  hint,
  children,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[12.5px] text-(--mut) hover:bg-(--bg-subtle) hover:text-(--ink)">
      <input
        type="checkbox"
        name={name}
        value={value}
        defaultChecked={checked}
        onChange={onChange}
        className="accent-(--accent)"
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="font-mono text-[10.5px] text-(--dim)">{hint}</span> : null}
    </label>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-2 py-2 text-[12px] text-(--dim)">{children}</p>;
}
