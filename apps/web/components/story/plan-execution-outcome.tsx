"use client";

import type { StoryPlans, StoryWorkflowStatus } from "@facility/sdk";
import { Button } from "@facility/ui";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clientApi } from "@/lib/client-api";
import { formatTime } from "@/lib/story-presentation";

type Decision = NonNullable<StoryPlans["decision"]>;
type Props = {
  decision: Decision;
  workflow?: StoryWorkflowStatus;
  retainedTurnIds?: string[];
  storyPath: string;
  loading?: boolean;
  error?: string;
};
const stateLabel = {
  queued: "Waiting to run",
  running: "Preparing or running",
  succeeded: "Turn succeeded",
  failed: "Turn failed",
  canceled: "Turn canceled",
} as const;

function currentApproval(workflow: StoryWorkflowStatus, decision: Decision) {
  return (
    workflow.plan.status === "approved" &&
    workflow.plan.revision === decision.planRevision &&
    workflow.plan.decisionRevision === decision.decisionRevision
  );
}

/** Approval and observed execution remain separate facts, including after a failed read. */
export function PlanExecutionOutcome({
  decision,
  workflow,
  retainedTurnIds = [],
  storyPath,
  loading,
  error,
}: Props) {
  if (decision.intent !== "approve") return null;
  const execution = workflow?.execution;
  if (error || !workflow || !execution)
    return (
      <div role="status" className="text-sm text-(--mut)">
        {loading
          ? "Approval recorded. Checking what happened to the work…"
          : error
            ? `Approval remains recorded. Execution status could not be checked: ${error}`
            : "Approval is recorded; linked execution status is unavailable. Inspect the story before assuming that work started."}
      </div>
    );
  if (
    !currentApproval(workflow, decision) ||
    execution.decision?.id !== decision.id ||
    execution.decision.planDigest !== decision.planDigest
  )
    return (
      <p role="status" className="text-sm text-(--human)">
        This approval is historical. The current plan is r{workflow.plan.revision} (
        {workflow.plan.status}).{" "}
        <Link href={`${storyPath}#story-plan`} className="underline">
          Inspect the current decision
        </Link>
        .
      </p>
    );
  const queued = workflow.executionScope?.queuedWork ?? [];
  const primary =
    execution.turns.find((turn) => retainedTurnIds.includes(turn.turnId)) ?? execution.turns[0];
  const others = execution.turns.filter((turn) => turn.turnId !== primary?.turnId);
  function turnRow(turn: NonNullable<StoryWorkflowStatus["execution"]>["turns"][number]) {
    return (
      <div key={turn.turnId} className="flex min-w-0 flex-col gap-2 text-sm">
        <p className="break-words font-medium">
          {turn.agentName} · {stateLabel[turn.state]}
        </p>
        {retainedTurnIds.includes(turn.turnId) ? (
          <p className="text-(--mut)">This is the same turn inspected before approval.</p>
        ) : null}
        {turn.state === "succeeded" ? (
          <p className="text-(--mut)">
            The turn finished successfully. Delivery acceptance is a separate decision.
          </p>
        ) : null}
        <details className="text-xs text-(--dim)">
          <summary className="cursor-pointer">Execution evidence</summary>
          <dl className="mt-2 flex flex-col gap-2 break-all">
            <div>
              <dt>Turn</dt>
              <dd className="font-mono">{turn.turnId}</dd>
            </div>
            <div>
              <dt>Authorized under this approval</dt>
              <dd>{formatTime(turn.authorizedAt)}</dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>{turn.startedAt ? formatTime(turn.startedAt) : "No start time recorded"}</dd>
            </div>
            <div>
              <dt>Finished</dt>
              <dd>{turn.endedAt ? formatTime(turn.endedAt) : "No finish time recorded"}</dd>
            </div>
            <div>
              <dt>Agent version</dt>
              <dd>
                {turn.engine} · {turn.model} ·{" "}
                <span className="font-mono">{turn.manifestHash}</span>
              </dd>
            </div>
          </dl>
        </details>
      </div>
    );
  }
  return (
    <section
      aria-label="Execution after approval"
      className="flex min-w-0 flex-col gap-3 border-t border-(--line) pt-4"
    >
      <div>
        <h3 className="text-sm font-medium">After approval</h3>
        <p className="mt-1 text-xs text-(--dim)">
          Observed {formatTime(execution.observedAt)}
          {loading ? " · refreshing…" : ""}
        </p>
      </div>
      {queued.length ? (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">
            {workflow.blockedReason
              ? "Approved · work is still held"
              : "Approved · waiting to start"}
          </p>
          <p className="break-words text-(--mut)">
            {[...new Set(queued.map((turn) => turn.agentName))].join(", ")} remains queued.
            {workflow.blockedReason
              ? ` ${workflow.blockedReason}`
              : " Current execution checks and capacity still apply."}
          </p>
        </div>
      ) : null}
      {execution.unavailable ? (
        <p role="status" className="text-sm text-(--human)">
          Some execution evidence could not be verified. Open the story to inspect it; this is not
          proof that no work ran.
        </p>
      ) : null}
      {primary ? (
        turnRow(primary)
      ) : !queued.length && !execution.unavailable ? (
        <p className="text-sm text-(--mut)">
          No execution linked to this approval was recorded in this observation. Approval does not
          create a new request.
        </p>
      ) : null}
      {others.length ? (
        <details>
          <summary className="cursor-pointer text-sm">
            {others.length} other recorded {others.length === 1 ? "turn" : "turns"} under this
            approval
          </summary>
          <div className="mt-3 flex flex-col gap-4">{others.map(turnRow)}</div>
        </details>
      ) : null}
      {execution.hasMore ? (
        <p className="text-xs text-(--mut)">
          Showing the latest {execution.turns.length} verified records. Earlier work remains in the
          story activity.
        </p>
      ) : null}
      <Link
        href={`${storyPath}#conversation`}
        className="w-fit text-sm underline underline-offset-4"
      >
        Open story conversation
      </Link>
    </section>
  );
}

/** The story already refreshes; only the standalone confirmation needs its own observation loop. */
export function LivePlanExecutionOutcome({
  decision,
  workflow: initial,
  retainedTurnIds,
  storyPath,
  projectId,
  storyId,
}: Props & { projectId: string; storyId: string }) {
  const [workflow, setWorkflow] = useState(() =>
    initial?.execution &&
    initial.plan.decisionRevision >= decision.decisionRevision &&
    Date.parse(initial.execution.observedAt) >= Date.parse(decision.confirmedAt)
      ? initial
      : undefined,
  );
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const refresh = useRef(() => {});
  const workflowPath = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/workflow`;
  useEffect(() => {
    let disposed = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      timer = setTimeout(() => {
        if (document.visibilityState === "hidden") schedule();
        else void read();
      }, 8000);
    }
    async function read() {
      if (reading || disposed) return;
      clearTimeout(timer);
      reading = true;
      setLoading(true);
      setError(undefined);
      const result = await clientApi<StoryWorkflowStatus>("GET", workflowPath);
      reading = false;
      if (disposed) return;
      setLoading(false);
      if (!result.ok) {
        setWorkflow(undefined);
        setError(result.message);
        return;
      }
      setWorkflow(result.data);
      if (
        result.data.execution &&
        currentApproval(result.data, decision) &&
        (result.data.queuedAgents.length > 0 ||
          result.data.execution.turns.some(
            (turn) => turn.state === "running" || turn.state === "queued",
          ))
      )
        schedule();
    }
    refresh.current = () => {
      void read();
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
      refresh.current = () => {};
    };
  }, [workflowPath, decision]);
  return (
    <div className="flex flex-col gap-3">
      <PlanExecutionOutcome
        decision={decision}
        workflow={workflow}
        retainedTurnIds={retainedTurnIds}
        storyPath={storyPath}
        loading={loading}
        error={error}
      />
      <Button size="sm" className="w-fit" disabled={loading} onClick={() => refresh.current()}>
        {loading ? "Checking execution…" : "Check execution again"}
      </Button>
    </div>
  );
}
