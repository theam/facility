"use client";

import type { StoryAgent, StoryWorkflowPolicyState, WorkflowPolicyReview } from "@facility/sdk";
import { Button, Eyebrow } from "@facility/ui";
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
  return (
    <section
      aria-label="Workflow approvals"
      className="flex min-w-0 flex-col gap-4 border border-(--line) p-4 sm:p-5"
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
