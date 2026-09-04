"use client";

import { Button, cx, Eyebrow } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Markdown } from "@/components/markdown";
import type { Proposal, ProposalReviewContext } from "@/lib/api";

type ReviewContext = ProposalReviewContext["reviewContext"];

export function requestProposalReviewContext(proposalId: string, fetchImpl: typeof fetch = fetch) {
  return fetchImpl(`/api/v1/proposals/${proposalId}/review-context`, {
    method: "POST",
  });
}

/**
 * A gate in card form: the evidence inline, the decision one tap.
 * Decisions hit the HITL ledger and are fully audited.
 */
export function ProposalCard({ proposal, focused }: { proposal: Proposal; focused?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  // A human gate must be deliberate: the first click arms a decision, a second
  // confirms it, so one stray tap cannot dispatch or deny.
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [reviewContext, setReviewContext] = useState<ReviewContext | null>(null);
  const [reviewContextSeq, setReviewContextSeq] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function arm(decision: "approve" | "reject") {
    setError(null);
    if (proposal.actionType !== "plan_acceptance") {
      setPending(decision);
      return;
    }
    setBusy(decision);
    try {
      const res = await requestProposalReviewContext(proposal.id);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `review context failed (${res.status})`);
      }
      const body = (await res.json()) as {
        reviewContextSeq: number;
        reviewContext: ReviewContext;
      };
      setReviewContextSeq(body.reviewContextSeq);
      setReviewContext(body.reviewContext);
      setPending(decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "review context failed");
    } finally {
      setBusy(null);
    }
  }

  async function decide(decision: "approve" | "reject") {
    setBusy(decision);
    setPending(null);
    setError(null);
    try {
      const res = await fetch(`/api/v1/proposals/${proposal.id}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision,
          note: note || undefined,
          ...(reviewContextSeq ? { reviewContextSeq } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `decision failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "decision failed");
      if (proposal.actionType === "plan_acceptance") {
        setReviewContext(null);
        setReviewContextSeq(null);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <article
      id={proposal.id}
      className={cx(
        "flex flex-col gap-4 border bg-(--bg) p-6",
        focused ? "border-(--human)" : "border-(--line)",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow className="text-(--human)">{proposal.actionType}</Eyebrow>
        <span className="font-mono text-[10px] text-(--dim)">
          {new Date(proposal.createdAt).toLocaleString()}
          {proposal.expiresAt
            ? ` · expires ${new Date(proposal.expiresAt).toLocaleDateString()}`
            : null}
        </span>
      </div>

      {/* Agents write the gate's evidence as markdown (plans arrive with
          headings, lists, and code spans) — render it, don't dump the source. */}
      <Markdown source={proposal.contextMd} />

      {proposal.executionError ? (
        <p className="border border-(--bad) bg-(--bad-subtle) p-3 font-mono text-[11px] text-(--bad)">
          {proposal.actionType === "plan_acceptance"
            ? "Builder dispatch blocked"
            : "Execution failed"}
          : {proposal.executionError}
        </p>
      ) : null}

      <details className="group">
        <summary className="cursor-pointer select-none text-[12px] font-medium text-(--dim) hover:text-(--mut)">
          payload
        </summary>
        <pre className="mt-3 overflow-x-auto border border-(--line) bg-(--bg-subtle) p-4 font-mono text-[11.5px] leading-relaxed text-(--code)">
          {JSON.stringify(proposal.payload, null, 2)}
        </pre>
      </details>

      {pending ? (
        <div className="flex flex-col gap-3">
          {reviewContext ? <ReviewContextPanel context={reviewContext} /> : null}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-(--ink)">
              Confirm <span className="font-mono">{pending}</span>? Recorded in the HITL ledger.
            </span>
            <Button
              size="sm"
              variant={pending === "approve" ? "primary" : "danger"}
              disabled={
                busy !== null || (pending === "approve" && reviewContext?.status === "unavailable")
              }
              onClick={() => decide(pending)}
            >
              {busy ? `${pending}…` : `confirm ${pending}`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                setPending(null);
                setReviewContext(null);
                setReviewContextSeq(null);
              }}
            >
              cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="primary"
            disabled={busy !== null}
            onClick={() => arm("approve")}
          >
            {busy === "approve" ? "loading context…" : "approve"}
          </Button>
          <Button size="sm" variant="danger" disabled={busy !== null} onClick={() => arm("reject")}>
            {busy === "reject" ? "loading context…" : "reject"}
          </Button>
          <input
            name="note"
            aria-label="Decision note (recorded in the ledger)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="note (recorded in the ledger)"
            className="h-8 min-w-0 flex-1 border-b border-(--line) bg-transparent px-1 text-[13px] text-(--ink) placeholder:text-(--dim) focus:border-(--line-strong)"
          />
        </div>
      )}
      {error ? <p className="font-mono text-[11px] text-(--bad)">{error}</p> : null}
    </article>
  );
}

export function ReviewContextPanel({ context }: { context: ReviewContext }) {
  const repository = context.repository
    ? `${context.repository.owner}/${context.repository.name}`
    : "unavailable";
  const comparison = context.status === "available" ? context.comparison : null;
  const unavailableReason = context.status === "unavailable" ? context.reason : null;
  const changed = comparison?.changedPaths.length ?? 0;
  return (
    <div
      className={cx(
        "border p-4 font-mono text-[11px] leading-relaxed",
        context.status === "available"
          ? "border-(--line) bg-(--bg-subtle) text-(--code)"
          : "border-(--bad) bg-(--bad-subtle) text-(--bad)",
      )}
    >
      <p>Repository: {repository}</p>
      <p>Branch: {context.branch ?? "unavailable"}</p>
      <p>Plan based on: {shortSha(context.planBaseSha)}</p>
      <p>
        Currently presented:{" "}
        {shortSha(context.status === "available" ? context.presentedBaseSha : null)}
      </p>
      {comparison ? (
        <p>
          Drift: {comparison.aheadBy} commits ahead, {comparison.behindBy} behind, {changed}
          {comparison.changedPathsTruncated ? "+" : ""} changed paths
        </p>
      ) : (
        <p>Evidence unavailable: {unavailableReason ?? "unknown"}</p>
      )}
      {comparison && changed > 0 ? (
        <details className="mt-2">
          <summary className="cursor-pointer">changed paths</summary>
          <ul className="mt-1 list-inside list-disc">
            {comparison.changedPaths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : "unavailable";
}
