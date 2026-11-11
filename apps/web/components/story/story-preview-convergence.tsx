"use client";

import { Button, Eyebrow } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StoryPreviewConvergence } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { formatTime } from "@/lib/story-presentation";

type PreviewConvergence = NonNullable<StoryPreviewConvergence>;

const labels: Record<PreviewConvergence["state"], string> = {
  pending: "Queued for update",
  waiting: "Waiting for the story writer",
  applying: "Applying exact PR revisions",
  blocked: "Needs attention",
  failed: "Update failed",
  ready: "Current delivery is ready",
  suspended: "Suspended with the workspace",
};

export function StoryPreviewConvergencePanel({
  projectId,
  storyId,
  initial,
  canExecute,
}: {
  projectId: string;
  storyId: string;
  initial?: PreviewConvergence | null;
  canExecute: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(initial ?? null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryKey = useRef<string | null>(null);
  useEffect(() => setCurrent(initial ?? null), [initial]);
  if (!current) return null;
  const path = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/preview-convergence/retry`;
  const canRetry = ["waiting", "blocked", "failed"].includes(current.state);

  async function retry() {
    if (!canExecute || retrying) return;
    retryKey.current ??= crypto.randomUUID();
    setRetrying(true);
    setError(null);
    const result = await clientApi<PreviewConvergence>("POST", path, {
      idempotency_key: retryKey.current,
    });
    setRetrying(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    retryKey.current = null;
    setCurrent(result.data);
    router.refresh();
  }

  return (
    <section aria-label="Preview delivery" className="min-w-0 border border-(--line) p-5 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow>preview delivery</Eyebrow>
          <h2 className="mt-2 text-lg font-semibold">{labels[current.state]}</h2>
        </div>
        {canExecute && canRetry ? (
          <Button size="sm" disabled={retrying} onClick={() => void retry()}>
            {retrying ? "Retrying…" : "Retry latest generation"}
          </Button>
        ) : null}
      </div>
      <p className="mt-3 text-sm text-(--mut)">
        {current.state === "ready"
          ? `${current.desired.repositories.length} required PR revision${current.desired.repositories.length === 1 ? " is" : "s are"} running in the retained workspace.`
          : "Facility keeps one desired generation and publishes it only after repository checks, rebuild, and readiness succeed."}
      </p>
      {current.error ? (
        <div className="mt-3 border border-(--bad)/50 bg-(--bg-subtle) p-3 text-sm">
          <p className="font-medium">{current.error.message}</p>
          <p className="mt-1 text-xs text-(--dim)">
            {current.error.code}
            {current.error.retryAt ? ` · retry after ${formatTime(current.error.retryAt)}` : ""}
          </p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
      <dl className="mt-4 grid gap-2 text-xs text-(--mut) sm:grid-cols-2">
        <div>
          <dt>Desired generation</dt>
          <dd className="mt-1 break-all font-mono text-(--ink)">
            {current.desired.generation.slice(0, 12)}
          </dd>
        </div>
        <div>
          <dt>Last good generation</dt>
          <dd className="mt-1 break-all font-mono text-(--ink)">
            {current.lastGoodGeneration?.slice(0, 12) ?? "None yet"}
          </dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd className="mt-1 text-(--ink)">{formatTime(current.desired.observedAt)}</dd>
        </div>
        <div>
          <dt>Latest attempt</dt>
          <dd className="mt-1 text-(--ink)">
            {current.attempt
              ? `#${current.attempt.number} · ${current.attempt.state}`
              : "Not started"}
          </dd>
        </div>
      </dl>
      <details className="mt-4 text-xs text-(--mut)">
        <summary className="cursor-pointer">Exact required revisions</summary>
        <ul className="mt-2 space-y-2">
          {current.desired.repositories.map((repository) => (
            <li key={`${repository.repositoryId}:${repository.pullNumber}`}>
              <span className="break-all text-(--ink)">
                {repository.repository} #{repository.pullNumber}
              </span>{" "}
              · <span className="font-mono">{repository.headSha.slice(0, 12)}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
