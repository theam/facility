"use client";

import type { DeliveryAcceptanceReview, StoryDeliveryAcceptance } from "@facility/sdk";
import { Button, Eyebrow } from "@facility/ui";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clientApi } from "@/lib/client-api";
import { formatTime } from "@/lib/story-presentation";

export function DeliveryAcceptanceConfirmation({ initial }: { initial: DeliveryAcceptanceReview }) {
  const [review, setReview] = useState(initial),
    [receipt, setReceipt] = useState(initial.receipt);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(() => Date.parse(initial.request.expiresAt) <= Date.now());
  const working = useRef(false),
    retry = useRef<{ proof: string; key: string } | null>(null),
    sequence = useRef(0);
  const storyPath = `/projects/${encodeURIComponent(initial.projectId)}/stories/${encodeURIComponent(initial.storyId)}`;
  const path = `/v1/projects/${encodeURIComponent(initial.projectId)}/workspace-stories/${encodeURIComponent(initial.storyId)}/delivery-acceptance/${encodeURIComponent(initial.request.id)}`;
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
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    const n = ++sequence.current;
    const result = await clientApi<DeliveryAcceptanceReview>("GET", path);
    if (n !== sequence.current) return;
    working.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReview(result.data);
    setReceipt(result.data.receipt);
  }
  async function confirm() {
    if (
      working.current ||
      !review.proof ||
      receipt ||
      review.request.status !== "pending" ||
      Date.parse(review.request.expiresAt) <= Date.now()
    )
      return;
    if (retry.current?.proof !== review.proof)
      retry.current = { proof: review.proof, key: crypto.randomUUID() };
    working.current = true;
    setBusy(true);
    setError(null);
    const n = ++sequence.current;
    const result = await clientApi<StoryDeliveryAcceptance>("POST", `${path}/confirm`, {
      proof: review.proof,
      idempotency_key: retry.current.key,
    });
    if (n !== sequence.current) return;
    working.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setReceipt(result.data.receipt);
  }
  const pending = review.request.status === "pending" && !!review.proof && !expired && !receipt;
  const candidate = review.request.snapshot;
  return (
    <section
      aria-label="Confirm delivery acceptance"
      className="flex min-w-0 flex-col gap-5 border border-(--line) p-4 sm:p-6"
    >
      <header className="flex flex-col gap-2">
        <Eyebrow>delivery acceptance</Eyebrow>
        <h1 className="text-[24px] font-semibold">
          {receipt ? "Acceptance recorded" : "Review this exact delivery"}
        </h1>
        <p className="text-sm text-(--mut)">
          Confirm only after reviewing the required PR heads below
          {candidate.planRevision ? ` and plan r${candidate.planRevision}` : ""}. New heads or
          plan/policy changes need a fresh acceptance.
        </p>
        <p className="text-sm text-(--mut)">
          Acceptance records your review. Merging and completing the story remain separate actions.
        </p>
      </header>
      <ul className="flex min-w-0 flex-col gap-3" aria-label="Required pull requests">
        {candidate.pullRequests.map((pull) => (
          <li
            key={`${pull.repository}:${pull.number}`}
            className="min-w-0 border-t border-(--line) pt-3 text-sm"
          >
            {/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pull.repository) ? (
              <a
                className="break-words underline"
                href={`https://github.com/${pull.repository}/pull/${pull.number}`}
                target="_blank"
                rel="noreferrer"
              >
                {pull.repository} #{pull.number}
              </a>
            ) : (
              <span className="break-words">
                {pull.repository} #{pull.number}
              </span>
            )}
            <p className="mt-1 break-all font-mono text-[12px] text-(--mut)">
              Head: {pull.headSha}
            </p>
          </li>
        ))}
      </ul>
      {candidate.previewGeneration ? (
        <p className="text-sm">
          A ready preview matched this exact PR set when the review was prepared. The server will
          check it again on confirmation.
        </p>
      ) : null}
      <p className="text-[12px] text-(--dim)">
        Requested by{" "}
        {review.request.requestedBy.name ??
          (review.request.requestedBy.type === "service" ? "a service" : "a project member")}{" "}
        · expires {formatTime(review.request.expiresAt)}.
      </p>
      {error ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
      {receipt ? (
        <p role="status" className="text-sm">
          Accepted by {receipt.confirmedBy.name ?? "a project member"} ·{" "}
          {formatTime(receipt.confirmedAt)}. Open the story to check whether this acceptance is
          still current.
        </p>
      ) : !pending ? (
        <p role="alert" className="text-sm text-(--bad)">
          {expired || review.request.status === "expired"
            ? "This review expired. Request a fresh review from the story."
            : "The delivery changed or this review was already used. Open the story and request a fresh review."}
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
            {busy ? "Confirming…" : "Accept this exact delivery"}
          </Button>
        ) : null}
        <Button disabled={busy} onClick={() => void reload()}>
          Reload review
        </Button>
        <Link href={storyPath} className="text-sm underline">
          Open current story
        </Link>
      </div>
    </section>
  );
}
