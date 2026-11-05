import type { StoryWorkflowStatus } from "@facility/sdk";
import { formatTime } from "@/lib/story-presentation";

export function PlanExecutionScope({
  scope,
  planRevision,
}: {
  scope?: StoryWorkflowStatus["executionScope"];
  planRevision: number;
}) {
  if (!scope) return null;
  if (scope.planRevision !== planRevision) {
    return (
      <p role="status" className="text-sm text-(--mut)">
        The execution scope was checked for plan r{scope.planRevision}. Reload the story to inspect
        the scope for r{planRevision} before relying on it.
      </p>
    );
  }
  const needsReview = scope.queuedWork.filter(
    (turn) => turn.configuration !== "current" || turn.planAgent !== "current",
  ).length;
  const retainedWork = (
    <ul className="flex min-w-0 flex-col gap-3">
      {scope.queuedWork.map((turn) => (
        <li key={turn.turnId} className="min-w-0 border-l-2 border-(--line-strong) pl-3">
          <p className="break-words font-medium">
            {turn.agentName} ·{" "}
            {turn.engine === "codex"
              ? "Codex"
              : turn.engine === "claude_code"
                ? "Claude Code"
                : turn.engine}{" "}
            · {turn.model}
          </p>
          <p className="mt-1 text-(--mut)">
            {turn.configuration === "unavailable"
              ? "The retained or configured agent version cannot be verified. Inspect the configuration before continuing."
              : turn.configuration === "changed"
                ? "The configured agent has changed since this turn was queued. Approving this plan alone will not resume that turn."
                : turn.planAgent === "missing"
                  ? "This retained agent is missing from the plan."
                  : turn.planAgent === "changed"
                    ? "The plan selects a different agent version or primary repository."
                    : "The plan matches this retained agent version."}
          </p>
          <details className="mt-2 text-xs text-(--dim)">
            <summary className="cursor-pointer">Retained turn evidence</summary>
            <dl className="mt-2 flex flex-col gap-2 break-all">
              <div>
                <dt>Turn</dt>
                <dd className="font-mono">{turn.turnId}</dd>
              </div>
              <div>
                <dt>Queued</dt>
                <dd>{formatTime(turn.createdAt)}</dd>
              </div>
              <div>
                <dt>Agent configuration</dt>
                <dd className="font-mono">{turn.manifestHash}</dd>
              </div>
            </dl>
          </details>
        </li>
      ))}
    </ul>
  );
  return (
    <section
      aria-label="Execution scope"
      className="flex min-w-0 flex-col gap-3 border-t border-(--line) pt-4 text-sm"
    >
      <div>
        <h3 className="font-medium">Scope and retained work</h3>
        <p className="mt-1 text-xs text-(--dim)">
          Observed {formatTime(scope.observedAt)} · plan r{scope.planRevision}
        </p>
      </div>
      <p className={scope.repositories.matches ? "text-(--mut)" : "text-(--human)"}>
        {!planRevision
          ? `When plan approval is required, the plan must cover the ${scope.repositories.connectedCount} connected project repositories.`
          : scope.repositories.matches
            ? `The plan covers all ${scope.repositories.connectedCount} current repository connections.`
            : "This plan does not cover the current repository scope. Review the connections before approving recovery."}
      </p>
      {planRevision > 0 && scope.repositories.missing.length > 0 ? (
        <p className="break-words">
          <strong>Not covered:</strong> {scope.repositories.missing.join(", ")}
        </p>
      ) : null}
      {planRevision > 0 && scope.repositories.removed.length > 0 ? (
        <p className="break-words">
          <strong>Removed or changed connections:</strong> {scope.repositories.removed.join(", ")}
        </p>
      ) : null}
      {scope.queuedWork.length > 1 ? (
        <details>
          <summary className="cursor-pointer font-medium">
            {scope.queuedWork.length} retained turns
            {needsReview ? ` · ${needsReview} need scope review` : " · agent versions match"}
          </summary>
          <div className="mt-3">{retainedWork}</div>
        </details>
      ) : (
        retainedWork
      )}
      {scope.hasMore ? (
        <p className="text-(--human)">
          Showing the first {scope.queuedWork.length} queued turns. Other queued work can also be
          released if it matches the approved scope.
        </p>
      ) : null}
      <p className="text-xs text-(--mut)">
        {scope.queuedWork.length
          ? "This is a scope check, not execution authorization. Current policy, permissions, budget and capacity still apply when each turn starts."
          : "No queued turns were present in this scope check. Approval does not create a new request."}
      </p>
    </section>
  );
}
