import { Eyebrow, PillTag } from "@facility/ui";
import Link from "next/link";
import { type GhIssue, IssueRow } from "@/components/issues/issue-row";
import { SyncIssuesButton } from "@/components/issues/sync-button";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { api, untypedApi } from "@/lib/api";

export const metadata = { title: "issues" };

// TODO(sdk): migrate to the typed client once the issue-mirror routes are in
// the regenerated SDK route map.
type IssueList = { items: GhIssue[]; nextCursor?: string | null };

function hasPermission(permissions: string[], permission: string) {
  const [resource] = permission.split(":");
  return permissions.some((p) => p === "*" || p === permission || p === `${resource}:*`);
}

export default async function ProjectIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ state?: string }>;
}) {
  const [{ projectId }, { state }] = await Promise.all([params, searchParams]);
  const activeState = state === "closed" || state === "all" ? state : "open";
  const [issues, me] = await Promise.all([
    untypedApi<IssueList>("GET", `/v1/projects/${projectId}/issues?state=${activeState}`),
    api.me(),
  ]);

  if (!issues.ok && issues.offline) return <Offline />;

  const permissions = me.ok ? me.data.permissions : [];
  const canTrigger = hasPermission(permissions, "runs:trigger");
  const canSync = hasPermission(permissions, "repos:write");
  const items = issues.ok ? issues.data.items : [];

  return (
    <div className="flex flex-col gap-8">
      <LiveRefresh seconds={30} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>issues</Eyebrow>
          <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">Issues</h1>
          <p className="font-mono text-[11.5px] uppercase tracking-[0.14em] text-(--dim)">
            {issues.ok ? `${items.length} ${activeState}` : "mirror unavailable"} · read-mirror of
            GitHub — authoring stays there
          </p>
        </div>
        {canSync ? <SyncIssuesButton projectId={projectId} /> : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {(["open", "closed", "all"] as const).map((s) => (
          <Link key={s} href={`/projects/${projectId}/issues${s === "open" ? "" : `?state=${s}`}`}>
            <PillTag active={activeState === s}>{s}</PillTag>
          </Link>
        ))}
      </div>

      {!issues.ok ? (
        <ErrorNotice
          message={
            issues.status === 404
              ? "The issue mirror isn't available on this control plane yet."
              : `Couldn't load issues — ${issues.message}`
          }
        />
      ) : items.length === 0 ? (
        <p className="max-w-lg text-sm leading-relaxed text-(--dim)">
          Nothing {activeState === "all" ? "mirrored" : activeState} yet. Issues sync from the
          connected repository automatically; use sync to backfill.
        </p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {items.map((issue) => (
            <IssueRow key={issue.id} projectId={projectId} issue={issue} canTrigger={canTrigger} />
          ))}
        </div>
      )}
    </div>
  );
}
