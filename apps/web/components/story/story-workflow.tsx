"use client";

import type { DeliveryAcceptanceRequest, StoryDelivery, StoryWorkflowStatus } from "@facility/sdk";
import { Button, Eyebrow } from "@facility/ui";
import Link from "next/link";
import { useRef, useState } from "react";
import { clientApi } from "@/lib/client-api";

export function StoryWorkflowPanel({
  initial,
  canWrite,
  candidateReady,
}: {
  initial: StoryWorkflowStatus;
  canWrite: boolean;
  candidateReady: boolean;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<DeliveryAcceptanceRequest | null>(null);
  const working = useRef(false),
    retry = useRef<{ candidate: string; key: string } | null>(null);
  const path = `/v1/projects/${encodeURIComponent(initial.projectId)}/workspace-stories/${encodeURIComponent(initial.storyId)}`;
  async function requestReview() {
    if (working.current || !canWrite) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const delivery = await clientApi<StoryDelivery>("GET", `${path}/delivery`);
    if (
      !delivery.ok ||
      !delivery.data.candidate.revision ||
      delivery.data.candidate.state !== "recorded"
    ) {
      setError(
        delivery.ok
          ? "Declare the complete PR set and refresh its heads before requesting acceptance."
          : delivery.message,
      );
      working.current = false;
      setBusy(false);
      return;
    }
    const workflow = await clientApi<StoryWorkflowStatus>("GET", `${path}/workflow`);
    if (!workflow.ok) {
      setError(workflow.message);
      working.current = false;
      setBusy(false);
      return;
    }
    const candidate = JSON.stringify([
      delivery.data.candidate.revision,
      workflow.data.plan.revision,
      workflow.data.plan.decisionRevision,
      workflow.data.policy.revision,
    ]);
    if (retry.current?.candidate !== candidate)
      retry.current = { candidate, key: crypto.randomUUID() };
    const result = await clientApi<DeliveryAcceptanceRequest>(
      "POST",
      `${path}/delivery-acceptance`,
      {
        expected_candidate_revision: delivery.data.candidate.revision,
        expected_plan_revision: workflow.data.plan.revision,
        expected_decision_revision: workflow.data.plan.decisionRevision,
        idempotency_key: retry.current.key,
      },
    );
    working.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRequest(result.data);
  }
  return (
    <section
      aria-label="Workflow status"
      className="flex min-w-0 flex-col gap-3 border border-(--line) p-4 sm:p-5"
    >
      <Eyebrow>approvals and acceptance</Eyebrow>
      {initial.blockedReason ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {initial.blockedReason}{" "}
          <Link href="#story-plan" className="underline">
            Review the current plan
          </Link>
          .
        </p>
      ) : null}
      <p className="text-sm">
        Delivery acceptance: <strong>{initial.acceptance.status}</strong>
        {initial.acceptance.required
          ? " · required before story completion"
          : " · optional for this project"}
        .
      </p>
      <p className="text-sm text-(--mut)">
        Acceptance records your review of the exact required PR heads and plan. New heads or
        plan/policy changes require a fresh acceptance.
      </p>
      {initial.acceptance.receipt ? (
        <p className="break-words text-sm text-(--dim)">
          Last accepted by {initial.acceptance.receipt.confirmedBy.name ?? "a project member"} ·
          plan r{initial.acceptance.receipt.snapshot.planRevision} · acceptance r
          {initial.acceptance.receipt.revision}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
      {request ? (
        <Link
          className="w-fit max-w-full break-words text-sm underline"
          href={request.confirmationUrl}
        >
          Review and confirm this delivery
        </Link>
      ) : null}
      {!candidateReady ? (
        <p className="text-sm text-(--dim)">
          Declare the complete required PR set in{" "}
          <Link href="#story-delivery" className="underline">
            Delivery
          </Link>{" "}
          before requesting acceptance.
        </p>
      ) : null}
      {canWrite && candidateReady && initial.acceptance.status !== "current" ? (
        <div>
          <Button disabled={busy} onClick={() => void requestReview()}>
            {busy ? "Preparing review…" : "Request delivery acceptance"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
