"use client";

import { Button, Field, PillTag, Select, TextArea, TextInput } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { Project, RegistryItem, RegistryItemWithVersions } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { fmtAgo } from "@/lib/run-format";

const KINDS = [
  "skill",
  "rule",
  "agent_contract",
  "harness",
  "guard",
  "module",
  "template_set",
  "standard_section",
] as const;

/**
 * The harness as a workspace (L3): text search + kind/scope facets over the
 * governed content, and in-product item creation (draft → publish on the
 * item page). Published versions stay immutable.
 */
export function HarnessList({
  items,
  projects,
  activeKind,
}: {
  items: RegistryItem[];
  projects: Array<Pick<Project, "id" | "slug">>;
  activeKind?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "org" | "project" | "bundled">("all");
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((item) => {
      if (scope !== "all" && item.scope !== scope) return false;
      if (!needle) return true;
      return [item.name, item.kind, item.description ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [items, q, scope]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="search the harness…"
          className="h-8 w-56 border border-(--line) bg-transparent px-3 font-mono text-[12px] text-(--ink) outline-none placeholder:text-(--dim) focus:border-(--line-strong)"
          aria-label="search harness items"
        />
        {(["all", "bundled", "org", "project"] as const).map((s) => (
          <button key={s} type="button" onClick={() => setScope(s)}>
            <PillTag active={scope === s}>{s === "all" ? "any scope" : s}</PillTag>
          </button>
        ))}
        <span className="ml-auto">
          <Button size="sm" variant="primary" tone="agent" onClick={() => setCreating((v) => !v)}>
            {creating ? "close" : "new item"}
          </Button>
        </span>
      </div>

      {creating ? (
        <CreateItemPanel
          projects={projects}
          defaultKind={activeKind}
          onDone={(id) => {
            setCreating(false);
            if (id) router.push(`/harness/${id}`);
            else router.refresh();
          }}
        />
      ) : null}

      {filtered.length === 0 ? (
        <p className="border border-(--line) px-5 py-6 text-sm text-(--dim)">
          {items.length === 0
            ? "Nothing published under this filter yet."
            : "Nothing matches this search."}
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {filtered.map((item) => {
            // Bundled items are named by repo path — show the leaf, keep the
            // directory as quiet context instead of a filesystem dump.
            const slash = item.name.lastIndexOf("/");
            const base = slash >= 0 ? item.name.slice(slash + 1) : item.name;
            const dir = slash >= 0 ? item.name.slice(0, slash + 1) : null;
            const pathyDescription =
              item.description && !item.description.includes(" ") && item.description.includes("/");
            return (
              <Link
                key={item.id}
                href={`/harness/${item.id}`}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-(--line) px-5 py-3.5 transition-colors last:border-b-0 hover:bg-(--card)"
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {dir ? <span className="font-mono text-[10.5px] text-(--dim)">{dir}</span> : null}
                  <span className="truncate font-mono text-[13px] text-(--ink)">{base}</span>
                </span>
                <span className="text-[11px] font-medium text-(--dim)">
                  {item.kind.replace("_", " ")} · {item.scope} · v{item.latestVersion}
                </span>
                {item.description && !pathyDescription ? (
                  <span className="min-w-0 flex-1 truncate text-[12.5px] leading-relaxed text-(--mut)">
                    {item.description}
                  </span>
                ) : null}
                <span className="ml-auto font-mono text-[10.5px] text-(--dim)">
                  {fmtAgo(item.updatedAt)}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateItemPanel({
  projects,
  defaultKind,
  onDone,
}: {
  projects: Array<Pick<Project, "id" | "slug">>;
  defaultKind?: string;
  onDone: (itemId: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState(defaultKind && defaultKind !== "" ? defaultKind : "skill");
  const [projectId, setProjectId] = useState("");
  const [description, setDescription] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    const res = await clientApi<RegistryItemWithVersions>("POST", "/v1/registry/items", {
      scope: projectId ? "project" : "org",
      ...(projectId ? { projectId } : {}),
      kind,
      name: name.trim(),
      description: description.trim() || undefined,
      content,
    });
    setBusy(false);
    if (!res.ok) return setError(res.message);
    onDone(res.data.id);
  }

  return (
    <div className="flex flex-col gap-4 border border-(--line) bg-(--bg-subtle) p-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="scope">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">org — shared baseline</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                project · {p.slug}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="description — one line people will scan">
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="content (markdown)">
        <TextArea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={10}
          className="min-h-[200px] font-mono text-[12.5px] leading-relaxed"
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          tone="agent"
          disabled={busy || name.trim() === "" || content.trim() === ""}
          onClick={() => void create()}
        >
          {busy ? "creating…" : "create draft v1"}
        </Button>
        <span className="text-[11.5px] text-(--dim)">
          lands as a draft — review and publish on the item page
        </span>
        {error ? <span className="font-mono text-[11.5px] text-(--bad)">{error}</span> : null}
      </div>
    </div>
  );
}
