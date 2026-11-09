"use client";

import type { PlanDecisionReview, StoryPlans } from "@facility/sdk";
import { Button, Eyebrow } from "@facility/ui";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { PlanContent } from "@/components/story/plan-content";
import { clientApi } from "@/lib/client-api";
import { formatTime } from "@/lib/story-presentation";

export function PlanConfirmation({ initial }: { initial: PlanDecisionReview }) {
  const [review, setReview] = useState(initial),
    [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState(initial.decision),
    [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(() => Date.parse(initial.request.expiresAt) <= Date.now());
  const busyRef = useRef(false),
    retry = useRef<{ proof: string; key: string } | null>(null),
    sequence = useRef(0);
  const storyPath = `/projects/${encodeURIComponent(review.projectId)}/stories/${encodeURIComponent(review.storyId)}`;
  const path = `/v1/projects/${encodeURIComponent(review.projectId)}/workspace-stories/${encodeURIComponent(review.storyId)}/plan/decisions/${encodeURIComponent(review.request.id)}`;
  useEffect(() => {
    const remaining = Date.parse(review.request.expiresAt) - Date.now();
    setExpired(remaining <= 0);
    const timer = setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [review.request.expiresAt]);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  async function reload() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const n = ++sequence.current;
    const result = await clientApi<PlanDecisionReview>("GET", path);
    if (n !== sequence.current) return;
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReview(result.data);
    setReceipt(result.data.decision);
  }
  async function confirm() {
    if (
      busyRef.current ||
      !review.proof ||
      review.request.status !== "pending" ||
      Date.parse(review.request.expiresAt) <= Date.now()
    )
      return;
    if (retry.current?.proof !== review.proof)
      retry.current = { proof: review.proof, key: crypto.randomUUID() };
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const n = ++sequence.current;
    const result = await clientApi<StoryPlans>("POST", `${path}/confirm`, {
      proof: review.proof,
      idempotency_key: retry.current.key,
    });
    if (n !== sequence.current) return;
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReceipt(
      result.data.decisions.items.find((item) => item.requestId === review.request.id) ??
        result.data.decision,
    );
  }
  const pending = review.request.status === "pending" && !!review.proof && !expired && !receipt;
  const approval = review.request.intent === "approve";
  return (
    <section
      aria-label="Confirm plan decision"
      className="flex min-w-0 flex-col gap-5 border border-(--line) p-4 sm:p-6"
    >
      <header className="flex flex-col gap-2">
        <Eyebrow>plan decision</Eyebrow>
        <h1 className="text-[24px] font-semibold">
          {receipt
            ? "Decision recorded"
            : approval
              ? "Confirm plan approval"
              : "Confirm requested changes"}
        </h1>
        <p className="text-sm text-(--mut)">
          This decision applies to revision {review.plan.revision} and the repositories and agents
          below. Depending on project policy, approval may release queued agents immediately. It
          does not accept the final delivery.
        </p>
      </header>
      <PlanContent plan={review.plan} />
      <div className="flex flex-col gap-2 border-y border-(--line) py-4 text-sm">
        <p>
          <strong>Requested decision:</strong> {approval ? "Approve" : "Request changes to"} plan r
          {review.request.planRevision}
        </p>
        {review.request.reason ? (
          <p className="whitespace-pre-wrap break-words">
            <strong>Reason:</strong> {review.request.reason}
          </p>
        ) : null}
        <p className="text-[12px] text-(--dim)">
          Requested by{" "}
          {review.request.requestedBy.name ??
            (review.request.requestedBy.type === "service" ? "a service" : "a project member")}{" "}
          · {formatTime(review.request.requestedAt)} · expires{" "}
          {formatTime(review.request.expiresAt)}
        </p>
      </div>
      {error ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
      {receipt ? (
        <div role="status" className="flex flex-col gap-2">
          <p>
            {receipt.intent === "approve" ? "Approval" : "Requested changes"} recorded for plan r
            {receipt.planRevision} by {receipt.confirmedBy.name ?? "a project member"} ·{" "}
            {formatTime(receipt.confirmedAt)}.
          </p>
          <p className="text-[12px] text-(--dim)">
            Recorded through an interactive Facility session. Open the story to check the current
            plan and next action.
          </p>
        </div>
      ) : !pending ? (
        <p role="alert" className="text-sm text-(--bad)">
          {review.request.status === "superseded"
            ? `This review was superseded. The current plan is r${review.state.revision}; open the story and request a fresh review.`
            : expired || review.request.status === "expired"
              ? "This review has expired. Open the story and request a fresh review."
              : "This request cannot be confirmed. Reload its review to see the current receipt or state."}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {pending ? (
          <Button
            variant="primary"
            className="h-auto min-h-10 max-w-full whitespace-normal py-2"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy
              ? "Confirming…"
              : approval
                ? `Approve plan r${review.plan.revision}`
                : `Confirm changes to plan r${review.plan.revision}`}
          </Button>
        ) : null}
        <Button size="sm" disabled={busy} onClick={() => void reload()}>
          {busy ? "Loading…" : "Reload review"}
        </Button>
        <Link href={`${storyPath}#story-plan`} className="text-[13px] underline underline-offset-4">
          Open current plan
        </Link>
      </div>
    </section>
  );
}
