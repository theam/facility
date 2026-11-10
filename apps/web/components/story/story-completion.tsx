"use client";

import { Button, Eyebrow } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { StoryCompletion } from "@/lib/api";
import { clientApi } from "@/lib/client-api";
import { completionStepTitle } from "@/lib/story-focus";
import { formatTime, safeExternalUrl } from "@/lib/story-presentation";

type RequestKey = { signature: string; key: string };

function requestKey(ref: { current: RequestKey | null }, path: string, request: object) {
  const signature = JSON.stringify([path, request]);
  if (ref.current?.signature !== signature) {
    ref.current = { signature, key: crypto.randomUUID() };
  }
  return ref.current.key;
}

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
  const [policy, setPolicy] = useState({
    mode: initial?.integration.policy.mode ?? "none",
    repository: initial?.integration.policy.repository ?? "",
  });
  const { mode: policyMode, repository } = policy;
  const [inAppNotices, setInAppNotices] = useState(initial?.notices.in_app ?? true);
  const [summary, setSummary] = useState("");
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const integrationKey = useRef<RequestKey | null>(null);
  const completionKey = useRef<RequestKey | null>(null);
  const previousInitial = useRef(initial);
  useEffect(() => {
    const previous = previousInitial.current;
    previousInitial.current = initial;
    setCurrent(initial);
    // Live observations update untouched forms, but cannot replace an unsaved edit.
    setPolicy((draft) =>
      draft.mode === (previous?.integration.policy.mode ?? "none") &&
      draft.repository === (previous?.integration.policy.repository ?? "")
        ? {
            mode: initial?.integration.policy.mode ?? "none",
            repository: initial?.integration.policy.repository ?? "",
          }
        : draft,
    );
    setInAppNotices((draft) =>
      draft === (previous?.notices.in_app ?? true) ? (initial?.notices.in_app ?? true) : draft,
    );
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
    const path = `${story}/integration-result`;
    const request = {
      candidate_revision: candidate,
      event_id: current.integration.eventId,
      state,
      summary: summary.trim(),
      evidence_url: evidenceUrl.trim() || null,
    };
    setPending(`integration:${state}`);
    setError(null);
    const result = await clientApi<StoryCompletion>("POST", path, {
      ...request,
      idempotency_key: requestKey(integrationKey, path, request),
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
    const path = `${story}/complete`;
    const request = { candidate_revision: candidate, confirm: true };
    setPending("completion");
    setError(null);
    const result = await clientApi<StoryCompletion>("POST", path, {
      ...request,
      idempotency_key: requestKey(completionKey, path, request),
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
    canComplete &&
    current.source.kind === "github_issue" &&
    current.source.state !== "unavailable" &&
    ["request_completion", "retry_completion"].includes(current.nextAction);

  return (
    <section id="story-completion" aria-label="Delivery completion" className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Eyebrow>delivery completion</Eyebrow>
          <h2 className="mt-2 text-lg font-semibold">{completionStepTitle(current)}</h2>
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

      <section
        aria-label="Completion source"
        className="mt-4 border-l-2 border-(--human) pl-3 text-sm"
      >
        {current.source.kind === "other" ? (
          <p>
            No source GitHub issue is linked to this story. Closing another issue or merging these
            PRs does not complete this source. The source-completion action is unavailable.
          </p>
        ) : (
          <>
            {safeExternalUrl(current.source.url) ? (
              <a
                href={safeExternalUrl(current.source.url) ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center text-(--info) underline"
              >
                Open the exact source issue
              </a>
            ) : (
              <p>Source issue link unavailable.</p>
            )}
            <p>Observed source: {current.source.state}.</p>
            {current.source.state === "unavailable" ? (
              <p className="mt-2 text-(--human)">
                Current source evidence is needed before completion can be requested.
              </p>
            ) : null}
          </>
        )}
        {mayComplete ? (
          <p className="mt-2 text-(--mut)">
            This action closes the linked issue and then suspends workspace compute after the
            completion checks pass. It does not delete retained storage or the conversation.
          </p>
        ) : null}
      </section>

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
        <Fact
          label="Compute"
          value={
            current.retention.computeSuspended
              ? "Suspended"
              : current.retention.workspaceState
                ? "Suspension not recorded"
                : "No workspace recorded"
          }
        />
        <Fact label="Archive" value={current.retention.archived ? "Archived" : "Not archived"} />
      </dl>

      {current.completion.requestedAt || current.completion.completedAt ? (
        <details className="mt-4 text-xs text-(--mut)">
          <summary className="min-h-11 cursor-pointer py-3">Completion record</summary>
          <dl className="grid gap-3 sm:grid-cols-2">
            <Fact label="Requested" value={formatTime(current.completion.requestedAt)} />
            <Fact label="Completed" value={formatTime(current.completion.completedAt)} />
            <Fact
              label="Recorded candidate"
              value={current.completion.candidateRevision ?? "Not recorded"}
              mono
            />
          </dl>
        </details>
      ) : null}

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
                onChange={(event) =>
                  setPolicy({ ...policy, mode: event.target.value as typeof policyMode })
                }
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
                onChange={(event) => setPolicy({ ...policy, repository: event.target.value })}
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
