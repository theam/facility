"use client";

import type { StoryAgent, StoryWorkflowPolicyState, WorkflowPolicyReview } from "@facility/sdk";
import { Button, cardClassName, Eyebrow } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { clientApi } from "@/lib/client-api";

export function WorkflowPolicy({
  projectId,
  initial,
  agents,
  canWrite,
  catalogError,
}: {
  projectId: string;
  initial: StoryWorkflowPolicyState;
  agents: StoryAgent[];
  canWrite: boolean;
  catalogError?: string;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState(initial),
    [policy, setPolicy] = useState(initial.policy);
  const [review, setReview] = useState<WorkflowPolicyReview | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const working = useRef(false),
    retryKey = useRef<string | null>(null);
  const path = `/v1/projects/${encodeURIComponent(projectId)}/workflow-policy`;
  async function reviewChanges() {
    if (working.current || !canWrite) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await clientApi<WorkflowPolicyReview>("POST", `${path}/review`, {
      expected_revision: saved.revision,
      policy,
      idempotency_key: crypto.randomUUID(),
    });
    working.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    retryKey.current = crypto.randomUUID();
    setReview(result.data);
  }
  async function confirm() {
    if (working.current || !review || !canWrite) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const result = await clientApi<StoryWorkflowPolicyState>("POST", `${path}/confirm`, {
      expected_revision: review.expectedRevision,
      policy: review.policy,
      nonce: review.nonce,
      expires_at: review.expiresAt,
      proof: review.proof,
      idempotency_key: retryKey.current,
    });
    working.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setSaved(result.data);
    setPolicy(result.data.policy);
    setReview(null);
    retryKey.current = null;
    setNotice("Workflow policy saved.");
    router.refresh();
  }
  const names = [
    ...new Set([
      ...agents.filter((agent) => agent.enabled).map((agent) => agent.name),
      ...policy.planApprovalAgents,
    ]),
  ].sort();
  const cycle = policy.reviewCycle;
  return (
    <section
      aria-label="Workflow approvals"
      className={`${cardClassName} flex min-w-0 flex-col gap-4 p-5 sm:p-6`}
    >
      <Eyebrow>workflow approvals</Eyebrow>
      <p className="text-sm text-(--mut)">
        Choose which native agents require an approved plan before their turns can start. Agents can
        access every connected project repository; an execution plan must include that full
        repository scope. Read-only consultations remain available.
      </p>
      {catalogError ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          Agent catalog unavailable: {catalogError}
        </p>
      ) : null}
      <fieldset
        disabled={!canWrite || busy || !!review}
        className="flex min-w-0 flex-col gap-3 text-sm"
      >
        <legend className="mb-2 font-semibold">Require plan approval for</legend>
        {names.length ? (
          names.map((name) => (
            <label key={name} className="flex min-w-0 items-start gap-2 break-words">
              <input
                type="checkbox"
                className="mt-1"
                checked={policy.planApprovalAgents.includes(name)}
                onChange={(event) => {
                  setPolicy({
                    ...policy,
                    planApprovalAgents: event.target.checked
                      ? [...policy.planApprovalAgents, name].sort()
                      : policy.planApprovalAgents.filter((value) => value !== name),
                  });
                  setNotice(null);
                }}
              />
              <span className="min-w-0 break-words">{name}</span>
            </label>
          ))
        ) : (
          <p className="text-(--dim)">No enabled agents are configured.</p>
        )}
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={policy.holdAfterFailure}
            onChange={(event) => {
              setPolicy({ ...policy, holdAfterFailure: event.target.checked });
              setNotice(null);
            }}
          />
          <span>After failed or canceled work, hold the next agent until a new plan approval.</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            checked={policy.requireDeliveryAcceptance}
            onChange={(event) => {
              setPolicy({
                ...policy,
                requireDeliveryAcceptance: event.target.checked,
                requirePreviewForAcceptance:
                  event.target.checked && policy.requirePreviewForAcceptance,
              });
              setNotice(null);
            }}
          />
          <span>Require human acceptance of the final PR set before completing a story.</span>
        </label>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1"
            disabled={!policy.requireDeliveryAcceptance}
            checked={policy.requirePreviewForAcceptance}
            onChange={(event) => {
              setPolicy({ ...policy, requirePreviewForAcceptance: event.target.checked });
              setNotice(null);
            }}
          />
          <span>Require a ready preview of that exact candidate before acceptance.</span>
        </label>
      </fieldset>
      <fieldset
        disabled={!canWrite || busy || !!review}
        className="flex min-w-0 flex-col gap-3 text-sm"
      >
        <legend className="mb-2 font-semibold">Automatic delivery review</legend>
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={!!cycle}
            disabled={names.length < 2 && !cycle}
            onChange={(event) => {
              if (!event.target.checked) {
                const { reviewCycle: _cycle, ...remaining } = policy;
                setPolicy(remaining);
                return;
              }
              const builderAgent = names.includes("builder") ? "builder" : names[0];
              const reviewerAgent = names.includes("pr-reviewer")
                ? "pr-reviewer"
                : names.find((name) => name !== builderAgent);
              if (builderAgent && reviewerAgent)
                setPolicy({
                  ...policy,
                  holdAfterFailure: true,
                  requireDeliveryAcceptance: true,
                  planApprovalAgents: [
                    ...new Set([...policy.planApprovalAgents, builderAgent]),
                  ].sort(),
                  reviewCycle: {
                    builderAgent,
                    reviewerAgent,
                    timeoutMinutes: 30,
                    maxCostCents: 200,
                  },
                });
            }}
          />
          <span>
            Review a complete delivery with up to two reviews and one correction by its Builder.
          </span>
        </label>
        {cycle ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1">
              <label htmlFor="review-cycle-builder">Builder</label>
              <select
                id="review-cycle-builder"
                className="border border-(--line) p-1"
                value={cycle.builderAgent}
                onChange={(event) => {
                  const builderAgent = event.target.value;
                  setPolicy({
                    ...policy,
                    reviewCycle: { ...cycle, builderAgent },
                    planApprovalAgents: [
                      ...new Set([...policy.planApprovalAgents, builderAgent]),
                    ].sort(),
                  });
                }}
              >
                {names.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1">
              <label htmlFor="review-cycle-reviewer">Reviewer</label>
              <select
                id="review-cycle-reviewer"
                className="border border-(--line) p-1"
                value={cycle.reviewerAgent}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    reviewCycle: { ...cycle, reviewerAgent: event.target.value },
                  })
                }
              >
                {[...new Set([...names, cycle.reviewerAgent])].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
            <label className="grid gap-1">
              Time limit (minutes)
              <input
                className="w-24 border border-(--line) p-1"
                type="number"
                min={1}
                max={120}
                value={cycle.timeoutMinutes}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    reviewCycle: { ...cycle, timeoutMinutes: Number(event.target.value) },
                  })
                }
              />
            </label>
            <label className="grid gap-1">
              Cost limit (cents)
              <input
                className="w-24 border border-(--line) p-1"
                type="number"
                min={1}
                max={10000}
                value={cycle.maxCostCents}
                onChange={(event) =>
                  setPolicy({
                    ...policy,
                    reviewCycle: { ...cycle, maxCostCents: Number(event.target.value) },
                  })
                }
              />
            </label>
          </div>
        ) : null}
      </fieldset>
      {review ? (
        <div
          role="status"
          className="flex min-w-0 flex-col gap-3 border-t border-(--line) pt-3 text-sm"
        >
          <p>
            Confirm these settings for this project. Queued agents may start immediately if the new
            policy permits them. Running work must finish or be canceled before a policy change.
          </p>
          <p className="text-(--mut)">
            Plan approval: {review.policy.planApprovalAgents.join(", ") || "no agents"}. Hold after
            failure: {review.policy.holdAfterFailure ? "yes" : "no"}. Delivery acceptance:{" "}
            {review.policy.requireDeliveryAcceptance ? "required" : "optional"}. Ready preview:{" "}
            {review.policy.requirePreviewForAcceptance ? "required" : "optional"}.
          </p>
          {review.policy.reviewCycle ? (
            <p className="text-(--mut)">
              {review.policy.reviewCycle.builderAgent} → {review.policy.reviewCycle.reviewerAgent}.
              Up to {review.policy.reviewCycle.timeoutMinutes} minutes and{" "}
              {review.policy.reviewCycle.maxCostCents} cents.
              {review.policy.reviewCycle.requiredPullLabel ? (
                <>
                  {" "}
                  Required PR label <code>{review.policy.reviewCycle.requiredPullLabel}</code>.
                </>
              ) : null}
              {review.policy.reviewCycle.requiredChecks?.length ? (
                <>
                  {" "}
                  Required CI checks{" "}
                  {review.policy.reviewCycle.requiredChecks.map((check) => check.name).join(", ")}.
                </>
              ) : null}
            </p>
          ) : (
            <p className="text-(--mut)">Automatic delivery review is off.</p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
              {busy ? "Saving…" : "Confirm workflow policy"}
            </Button>
            <Button disabled={busy} onClick={() => setReview(null)}>
              Back to editing
            </Button>
          </div>
        </div>
      ) : canWrite ? (
        <div>
          <Button
            disabled={busy || JSON.stringify(policy) === JSON.stringify(saved.policy)}
            onClick={() => void reviewChanges()}
          >
            {busy ? "Loading review…" : "Review changes"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-(--dim)">
          A project and repository configuration writer must confirm changes in Facility.
        </p>
      )}
      {error ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
