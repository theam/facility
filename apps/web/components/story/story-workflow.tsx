"use client";

import type {
  DeliveryAcceptanceRequest,
  DeliveryAcceptanceReview,
  StoryDelivery,
  StoryWorkflowStatus,
} from "@facility/sdk";
import { Button, Eyebrow } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { clientApi } from "@/lib/client-api";
import { DeliveryAcceptanceConfirmation } from "./delivery-acceptance-confirmation";
import { ReviewCycleDetails, reviewCycleBlocksAcceptance } from "./review-cycle-details";

export function StoryWorkflowPanel({
  initial,
  canWrite,
  candidateReady,
}: {
  initial: StoryWorkflowStatus;
  canWrite: boolean;
  candidateReady: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<DeliveryAcceptanceRequest | null>(null);
  const [inlineReview, setInlineReview] = useState<DeliveryAcceptanceReview | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const working = useRef(false),
    retry = useRef<{ candidate: string; key: string } | null>(null);
  const path = `/v1/projects/${encodeURIComponent(initial.projectId)}/workspace-stories/${encodeURIComponent(initial.storyId)}`;
  const [observation, setObservation] = useState<{
    source: StoryWorkflowStatus;
    workflow: StoryWorkflowStatus;
  } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const status = observation?.source === initial ? observation.workflow : initial;
  const cycle = status.reviewCycle;
  const cycleBlocksAcceptance = reviewCycleBlocksAcceptance(cycle);
  const active = cycleBlocksAcceptance;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let reading = false;
    const timer = setInterval(async () => {
      if (reading || document.visibilityState === "hidden") return;
      reading = true;
      const result = await clientApi<StoryWorkflowStatus>("GET", `${path}/workflow`);
      reading = false;
      if (stopped) return;
      if (!result.ok) {
        setRefreshError(result.message);
        return;
      }
      if (
        result.data?.projectId !== initial.projectId ||
        result.data.storyId !== initial.storyId ||
        result.data.orgId !== initial.orgId
      ) {
        setRefreshError("The workflow response does not match this story.");
        return;
      }
      setRefreshError(null);
      setObservation({ source: initial, workflow: result.data });
      if (result.data.reviewCycle?.phase !== cycle?.phase) router.refresh();
    }, 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active, cycle?.phase, initial, path, router]);

  async function requestReview() {
    if (working.current || !canWrite || cycleBlocksAcceptance) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
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
    if (
      workflow.data?.projectId !== initial.projectId ||
      workflow.data.storyId !== initial.storyId ||
      workflow.data.orgId !== initial.orgId
    ) {
      setError("The workflow response does not match this story.");
      working.current = false;
      setBusy(false);
      return;
    }
    setObservation({ source: initial, workflow: workflow.data });
    if (reviewCycleBlocksAcceptance(workflow.data.reviewCycle)) {
      setError(
        workflow.data.reviewCycle?.reason ??
          "Wait for the recorded review cycle to finish before requesting acceptance.",
      );
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
    if (!result.ok) {
      working.current = false;
      setBusy(false);
      setError(result.message);
      return;
    }
    setRequest(result.data);
    // Confirm in place with the same review and single-use proof the confirmation
    // page uses; the link below stays as the fallback when it cannot be read here.
    const review = await clientApi<DeliveryAcceptanceReview>(
      "GET",
      `${path}/delivery-acceptance/${encodeURIComponent(result.data.id)}`,
    );
    working.current = false;
    setBusy(false);
    if (review.ok && review.data?.request?.id === result.data.id && review.data.request.snapshot)
      setInlineReview(review.data);
  }
  return (
    <section aria-label="Workflow status" className="flex min-w-0 flex-col gap-3">
      <Eyebrow>approvals and acceptance</Eyebrow>
      {cycle ? <ReviewCycleDetails cycle={cycle} /> : null}
      {refreshError ? (
        <p role="status" className="break-words text-sm text-(--mut)">
          Could not update the review — {refreshError}. The last recorded observation remains
          visible.
        </p>
      ) : null}
      {status.blockedReason ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {status.blockedReason}{" "}
          <Link href="#story-plan" className="underline">
            Review the current plan
          </Link>
          .
        </p>
      ) : null}
      <p className="text-sm">
        Delivery acceptance: <strong>{status.acceptance.status}</strong>
        {status.acceptance.required
          ? " · required before story completion"
          : " · optional for this project"}
        .
      </p>
      <p className="text-sm text-(--mut)">
        Acceptance records your review of the exact required PR heads and plan. New heads or
        plan/policy changes require a fresh acceptance.
      </p>
      {status.acceptance.receipt ? (
        <p className="break-words text-sm text-(--dim)">
          Last accepted by {status.acceptance.receipt.confirmedBy.name ?? "a project member"} · plan
          r{status.acceptance.receipt.snapshot.planRevision} · acceptance r
          {status.acceptance.receipt.revision}.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-(--ok)">
          {notice}
        </p>
      ) : null}
      {inlineReview ? (
        <DeliveryAcceptanceConfirmation
          key={inlineReview.request.id}
          compact
          initial={inlineReview}
          onClose={() => {
            setInlineReview(null);
            setRequest(null);
            router.refresh();
          }}
          onConfirmed={() => {
            setInlineReview(null);
            setRequest(null);
            setNotice(
              "Acceptance recorded. Merging and completing the story remain separate actions.",
            );
            router.refresh();
          }}
        />
      ) : request ? (
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
      {canWrite && candidateReady && status.acceptance.status !== "current" ? (
        <div>
          <Button disabled={busy || cycleBlocksAcceptance} onClick={() => void requestReview()}>
            {busy ? "Preparing review…" : "Request delivery acceptance"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
