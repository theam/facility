"use client";

import { Button, Eyebrow } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StoryCompletion } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { formatTime } from "@/lib/story-presentation";

const actionLabels: Record<StoryCompletion["nextAction"], string> = {
  declare_delivery: "Declare the complete delivery set",
  review: "Review the current delivery",
  merge: "Merge the remaining required pull requests",
  configure_integration: "Configure post-merge integration",
  record_integration: "Record the post-merge integration result",
  wait_integration: "Wait for post-merge integration",
  inspect_integration_failure: "Inspect the integration failure",
  request_completion: "Request source completion",
  wait_completion: "Wait for source completion",
  retry_completion: "Retry source completion",
  completed: "Delivery completed",
};

export function StoryCompletionPanel({
  projectId,
  storyId,
  initial,
  canConfigure,
  canConfigureNotices,
  canRecord,
  canComplete,
}: {
  projectId: string;
  storyId: string;
  initial?: StoryCompletion;
  canConfigure: boolean;
  canConfigureNotices: boolean;
  canRecord: boolean;
  canComplete: boolean;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(initial);
  const [pending, setPending] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [policyMode, setPolicyMode] = useState(initial?.integration.policy.mode ?? "none");
  const [repository, setRepository] = useState(initial?.integration.policy.repository ?? "");
  const [inAppNotices, setInAppNotices] = useState(initial?.notices.in_app ?? true);
  const [summary, setSummary] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const integrationKey = useRef<string | null>(null);
  const completionKey = useRef<string | null>(null);
  useEffect(() => {
    setCurrent(initial);
    setPolicyMode(initial?.integration.policy.mode ?? "none");
    setRepository(initial?.integration.policy.repository ?? "");
    setInAppNotices(initial?.notices.in_app ?? true);
  }, [initial]);
  if (!current) return null;

  const base = `/v1/projects/${encodeURIComponent(projectId)}`;
  const story = `${base}/workspace-stories/${encodeURIComponent(storyId)}`;
  const candidate = current.candidate.revision;

  async function savePolicy() {
    setPending("policy");
    setError(null);
    const result = await clientApi("PATCH", `${base}/delivery-integration`, {
      mode: policyMode,
      repository: policyMode === "repository_dispatch" ? repository.trim() : null,
    });
    setPending("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  async function saveNotices() {
    setPending("notices");
    setError(null);
    const result = await clientApi("PATCH", `${base}/delivery-notices`, {
      in_app: inAppNotices,
    });
    setPending("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.refresh();
  }

  async function recordIntegration(state: "succeeded" | "failed") {
    if (!candidate || !current) return;
    integrationKey.current ??= crypto.randomUUID();
    setPending(`integration:${state}`);
    setError(null);
    const result = await clientApi<StoryCompletion>("POST", `${story}/integration-result`, {
      candidate_revision: candidate,
      event_id: current.integration.eventId,
      state,
      summary: summary.trim(),
      evidence_url: evidenceUrl.trim() || null,
      idempotency_key: integrationKey.current,
    });
    setPending("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    integrationKey.current = null;
    setCurrent(result.data);
    router.refresh();
  }

  async function requestCompletion() {
    if (!candidate) return;
    completionKey.current ??= crypto.randomUUID();
    setPending("completion");
    setError(null);
    const result = await clientApi<StoryCompletion>("POST", `${story}/complete`, {
      candidate_revision: candidate,
      confirm: true,
      idempotency_key: completionKey.current,
    });
    setPending("");
    if (!result.ok) {
      setError(result.message);
      return;
    }
    completionKey.current = null;
    setCurrent(result.data);
    router.refresh();
  }

  const mayRecord =
    canRecord &&
    current.candidate.allRequiredMerged === true &&
    ((current.integration.policy.mode === "manual" && current.integration.state === "pending") ||
      (current.integration.policy.mode === "repository_dispatch" &&
        current.integration.state === "dispatched"));
  const mayComplete =
    canComplete && ["request_completion", "retry_completion"].includes(current.nextAction);

  return (
    <section aria-label="Delivery completion" className="min-w-0 border border-(--line) p-5 lg:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow>delivery completion</Eyebrow>
          <h2 className="mt-2 text-lg font-semibold">{actionLabels[current.nextAction]}</h2>
        </div>
        {mayComplete ? (
          <Button size="sm" disabled={Boolean(pending)} onClick={() => void requestCompletion()}>
            {pending === "completion" ? "Requesting…" : "Complete source issue"}
          </Button>
        ) : null}
      </div>

      <p className="mt-3 text-sm text-(--mut)">
        Review, pull-request merges, integration, source completion, compute suspension and retained
        storage are recorded separately.
      </p>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-(--bad)">
          {error}
        </p>
      ) : null}

      <dl className="mt-4 grid gap-3 text-xs text-(--mut) sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Candidate" value={candidate?.slice(0, 12) ?? "Not recorded"} mono />
        <Fact
          label="Required PRs"
          value={`${current.candidate.mergedCount}/${current.candidate.requiredCount} merged`}
        />
        <Fact label="Integration" value={current.integration.state.replaceAll("_", " ")} />
        <Fact label="Source issue" value={current.source.state} />
        <Fact label="Completion" value={current.completion.state.replaceAll("_", " ")} />
        <Fact
          label="Workspace"
          value={`${current.retention.workspaceState ?? "none"} · ${current.retention.storageRetained ? "storage retained" : "no retained storage"}`}
        />
      </dl>

      {current.integration.summary ? (
        <div className="mt-4 border border-(--line) bg-(--bg-subtle) p-3 text-sm">
          <p>{current.integration.summary}</p>
          <p className="mt-1 text-xs text-(--dim)">
            {current.integration.recordedAt
              ? `Recorded ${formatTime(current.integration.recordedAt)}`
              : null}
            {current.integration.evidenceUrl ? (
              <>
                {" · "}
                <a
                  href={current.integration.evidenceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-(--info) underline"
                >
                  evidence ↗
                </a>
              </>
            ) : null}
          </p>
        </div>
      ) : null}

      {current.integration.errorCode || current.completion.errorCode ? (
        <p className="mt-4 border border-(--bad)/50 bg-(--bg-subtle) p-3 text-sm text-(--bad)">
          {current.integration.errorCode ?? current.completion.errorCode}
        </p>
      ) : null}

      {mayRecord ? (
        <div className="mt-5 grid gap-3 border-t border-(--line) pt-4">
          <label className="grid gap-1 text-xs text-(--mut)">
            Integration summary
            <textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              rows={3}
              maxLength={2_000}
              className="w-full border border-(--line) bg-(--bg) p-2 text-sm text-(--ink)"
            />
          </label>
          <label className="grid gap-1 text-xs text-(--mut)">
            Evidence URL (optional)
            <input
              value={evidenceUrl}
              onChange={(event) => setEvidenceUrl(event.target.value)}
              type="url"
              maxLength={2_000}
              className="w-full border border-(--line) bg-(--bg) px-2 py-1.5 text-sm text-(--ink)"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={Boolean(pending) || summary.trim().length === 0}
              onClick={() => void recordIntegration("succeeded")}
            >
              {pending === "integration:succeeded" ? "Recording…" : "Record success"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(pending) || summary.trim().length === 0}
              onClick={() => void recordIntegration("failed")}
            >
              {pending === "integration:failed" ? "Recording…" : "Record failure"}
            </Button>
          </div>
        </div>
      ) : null}

      {canConfigure ? (
        <details className="mt-5 border-t border-(--line) pt-4 text-sm">
          <summary className="cursor-pointer text-(--mut)">Post-merge integration policy</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)_auto] sm:items-end">
            <label className="grid gap-1 text-xs text-(--mut)">
              Mode
              <select
                value={policyMode}
                onChange={(event) => setPolicyMode(event.target.value as typeof policyMode)}
                className="border border-(--line) bg-(--bg) px-2 py-1.5 text-sm text-(--ink)"
              >
                <option value="none">No integration gate</option>
                <option value="manual">Manual result</option>
                <option value="repository_dispatch">Repository dispatch</option>
              </select>
            </label>
            <label className="grid gap-1 text-xs text-(--mut)">
              Connected repository
              <input
                value={repository}
                onChange={(event) => setRepository(event.target.value)}
                disabled={policyMode !== "repository_dispatch"}
                placeholder="owner/repository"
                className="min-w-0 border border-(--line) bg-(--bg) px-2 py-1.5 text-sm text-(--ink) disabled:opacity-50"
              />
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={
                Boolean(pending) ||
                (policyMode === "repository_dispatch" && repository.trim().length === 0)
              }
              onClick={() => void savePolicy()}
            >
              {pending === "policy" ? "Saving…" : "Save policy"}
            </Button>
          </div>
        </details>
      ) : null}

      {canConfigureNotices ? (
        <details className="mt-4 border-t border-(--line) pt-4 text-sm">
          <summary className="cursor-pointer text-(--mut)">Delivery notice preference</summary>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-(--mut)">
              <input
                type="checkbox"
                checked={inAppNotices}
                onChange={(event) => setInAppNotices(event.target.checked)}
              />
              Show actionable delivery notices in Facility
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(pending)}
              onClick={() => void saveNotices()}
            >
              {pending === "notices" ? "Saving…" : "Save preference"}
            </Button>
          </div>
          <p className="mt-2 text-xs text-(--dim)">
            This controls Facility&apos;s in-app inbox only. No external channel is configured.
          </p>
        </details>
      ) : null}
    </section>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={`mt-1 break-words text-(--ink) ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
