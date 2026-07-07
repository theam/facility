import { Button, Eyebrow, TextInput } from "@facility/ui";
import Link from "next/link";
import { AuditExplorer } from "@/components/audit/audit-explorer";
import { ErrorNotice, Offline } from "@/components/offline";
import { api } from "@/lib/api";

export const metadata = { title: "audit" };

const WINDOWS = [
  { key: "24h", label: "24h", ms: 24 * 3600_000 },
  { key: "7d", label: "7d", ms: 7 * 24 * 3600_000 },
  { key: "30d", label: "30d", ms: 30 * 24 * 3600_000 },
  { key: "all", label: "all", ms: 0 },
] as const;

type Search = {
  actionPrefix?: string;
  actor?: string;
  projectId?: string;
  window?: string;
  cursor?: string;
};

function buildParams(search: Search): string {
  const params = new URLSearchParams();
  params.set("limit", "100");
  if (search.actionPrefix) params.set("actionPrefix", search.actionPrefix);
  if (search.actor) params.set("actor", search.actor);
  if (search.projectId) params.set("projectId", search.projectId);
  if (search.cursor) params.set("cursor", search.cursor);
  const window = WINDOWS.find((w) => w.key === search.window);
  if (window && window.ms > 0) {
    params.set("createdFrom", new Date(Date.now() - window.ms).toISOString());
  }
  return `?${params.toString()}`;
}

function windowHref(search: Search, key: string) {
  const next = new URLSearchParams();
  if (search.actionPrefix) next.set("actionPrefix", search.actionPrefix);
  if (search.actor) next.set("actor", search.actor);
  if (search.projectId) next.set("projectId", search.projectId);
  if (key !== "all") next.set("window", key);
  const qs = next.toString();
  return qs ? `/audit?${qs}` : "/audit";
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  const audit = await api.auditPage(buildParams(search));
  if (!audit.ok) return audit.offline ? <Offline /> : <ErrorNotice message={audit.message} />;

  const { items, nextCursor } = audit.data;
  const activeWindow = WINDOWS.find((w) => w.key === search.window)?.key ?? "all";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Eyebrow>audit</Eyebrow>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Audit log</h1>
        <p className="text-[12.5px] text-(--dim)">
          {items.length} event{items.length === 1 ? "" : "s"}
          {search.actionPrefix ? ` · action ${search.actionPrefix}*` : ""} · append-only ·
          hash-chained
        </p>
      </div>

      <form method="get" action="/audit" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-action" className="text-[11px] font-medium text-(--dim)">
            action prefix
          </label>
          <TextInput
            id="audit-action"
            name="actionPrefix"
            defaultValue={search.actionPrefix ?? ""}
            placeholder="run. / hitl. / key."
            className="w-44"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-actor" className="text-[11px] font-medium text-(--dim)">
            actor
          </label>
          <TextInput
            id="audit-actor"
            name="actor"
            defaultValue={search.actor ?? ""}
            placeholder="type:id or id"
            className="w-44"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="audit-project" className="text-[11px] font-medium text-(--dim)">
            project id
          </label>
          <TextInput
            id="audit-project"
            name="projectId"
            defaultValue={search.projectId ?? ""}
            placeholder="proj_…"
            className="w-52"
          />
        </div>
        {search.window ? <input type="hidden" name="window" value={search.window} /> : null}
        <Button type="submit" size="sm" variant="outline">
          filter
        </Button>
        <div className="ml-auto flex items-center gap-1 text-[11.5px] font-medium">
          {WINDOWS.map((w) => (
            <Link
              key={w.key}
              href={windowHref(search, w.key)}
              className={
                activeWindow === w.key
                  ? "border border-(--line-strong) px-2 py-1 text-(--ink)"
                  : "px-2 py-1 text-(--mut) hover:text-(--ink)"
              }
            >
              {w.label}
            </Link>
          ))}
        </div>
      </form>

      {items.length === 0 ? (
        <p className="text-sm text-(--dim)">No events match this filter.</p>
      ) : (
        <>
          <AuditExplorer events={items} />
          {nextCursor ? (
            <Link
              href={`/audit?${new URLSearchParams({
                ...(search.actionPrefix ? { actionPrefix: search.actionPrefix } : {}),
                ...(search.actor ? { actor: search.actor } : {}),
                ...(search.projectId ? { projectId: search.projectId } : {}),
                ...(search.window ? { window: search.window } : {}),
                cursor: String(nextCursor),
              }).toString()}`}
              className="self-start text-[12px] font-medium text-(--mut) underline-offset-4 hover:text-(--ink) hover:underline"
            >
              older events →
            </Link>
          ) : null}
        </>
      )}
    </div>
  );
}
