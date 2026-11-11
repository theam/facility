"use client";

import type { StoryAgent, StoryPlan, StoryPlanRepositories, StoryPlans } from "@facility/sdk";
import { Button, Eyebrow, Field, TextArea, TextInput } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PlanContent } from "@/components/story/plan-content";
import { clientApi } from "@/lib/client-api";
import { PLAN_PROPOSAL_EVENT, type PlanProposalSource } from "@/lib/story-plan-events";
import { formatTime } from "@/lib/story-presentation";

type Repositories = StoryPlanRepositories;
function newer(previous: StoryPlans | undefined, next: StoryPlans) {
  if (
    !previous ||
    next.state.revision > previous.state.revision ||
    (next.state.revision === previous.state.revision &&
      (next.state.decisionRevision > previous.state.decisionRevision ||
        (next.state.decisionRevision === previous.state.decisionRevision &&
          next.generatedAt >= previous.generatedAt)))
  )
    return next;
  return previous;
}
function mergeRevisions<T>(values: T[], added: T[], revision: (value: T) => number) {
  return [...new Map([...values, ...added].map((value) => [revision(value), value])).values()].sort(
    (a, b) => revision(b) - revision(a),
  );
}

export function StoryPlanPanel({
  projectId,
  storyId,
  initial,
  agents,
  defaultAgent,
  catalogError,
  canWrite,
  userId,
}: {
  projectId: string;
  storyId: string;
  initial?: StoryPlans;
  agents: StoryAgent[];
  defaultAgent: string | null;
  catalogError?: string;
  canWrite: boolean;
  userId?: string;
}) {
  const router = useRouter();
  const [current, setCurrent] = useState(initial);
  const [editing, setEditing] = useState(false),
    [markdown, setMarkdown] = useState("");
  const [baseRevision, setBaseRevision] = useState(0),
    [repositories, setRepositories] = useState<string[]>([]),
    [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [source, setSource] = useState<string | undefined>();
  const [pendingSource, setPendingSource] = useState<PlanProposalSource | null>(null);
  const [options, setOptions] = useState<Repositories | null>(null),
    [query, setQuery] = useState("");
  const [optionsError, setOptionsError] = useState<string | null>(null),
    [loadingOptions, setLoadingOptions] = useState(false);
  const [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false),
    [reason, setReason] = useState("");
  const [historyPages, setHistoryPages] = useState<StoryPlans["history"] | null>(null),
    [decisionPages, setDecisionPages] = useState<StoryPlans["decisions"] | null>(null);
  const [historical, setHistorical] = useState<StoryPlan | null>(null);
  const busyRef = useRef(false),
    retry = useRef<{ signature: string; key: string } | null>(null);
  const sequence = useRef(0),
    optionsSequence = useRef(0),
    searchTerm = useRef("");
  const textarea = useRef<HTMLTextAreaElement>(null),
    sourceNotice = useRef<HTMLDivElement>(null);
  const draftMarkdown = useRef("");
  const observedHeads = useRef({
    revision: initial?.state.revision ?? 0,
    decisionRevision: initial?.state.decisionRevision ?? 0,
  });
  const path = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/plan`;
  const storyPath = `/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(storyId)}`;
  useEffect(() => {
    if (initial) setCurrent((old) => newer(old, initial));
  }, [initial]);
  useEffect(() => {
    if (!current) return;
    if (current.state.revision > observedHeads.current.revision)
      setHistoryPages((old) =>
        old
          ? {
              ...old,
              hasMore: current.state.revision > 1,
              nextBeforeRevision: current.state.revision > 1 ? current.state.revision : null,
            }
          : old,
      );
    if (current.state.decisionRevision > observedHeads.current.decisionRevision)
      setDecisionPages((old) =>
        old
          ? {
              ...old,
              hasMore: current.state.decisionRevision > 1,
              nextBeforeRevision:
                current.state.decisionRevision > 1 ? current.state.decisionRevision : null,
            }
          : old,
      );
    observedHeads.current = {
      revision: current.state.revision,
      decisionRevision: current.state.decisionRevision,
    };
  }, [current]);
  useEffect(() => {
    function receive(event: Event) {
      const value = (event as CustomEvent<PlanProposalSource>).detail;
      if (
        canWrite &&
        value?.projectId === projectId &&
        value.storyId === storyId &&
        typeof value.markdown === "string"
      )
        setPendingSource(value);
    }
    window.addEventListener(PLAN_PROPOSAL_EVENT, receive);
    return () => window.removeEventListener(PLAN_PROPOSAL_EVENT, receive);
  }, [projectId, storyId, canWrite]);
  useEffect(() => {
    if (pendingSource) sourceNotice.current?.focus();
  }, [pendingSource]);
  useEffect(() => {
    if (editing) textarea.current?.focus();
  }, [editing]);
  useEffect(
    () => () => {
      sequence.current++;
      optionsSequence.current++;
    },
    [],
  );

  async function loadRepositories(offset = 0, term = "", choosePrimary = false) {
    const n = ++optionsSequence.current;
    if (offset === 0) searchTerm.current = term;
    setLoadingOptions(true);
    setOptionsError(null);
    const result = await clientApi<Repositories>(
      "GET",
      `${path}/repositories?${new URLSearchParams({ q: searchTerm.current, limit: "25", offset: String(offset) })}`,
    );
    if (n !== optionsSequence.current) return;
    setLoadingOptions(false);
    if (!result.ok) {
      setOptionsError(result.message);
      return;
    }
    setOptions((previous) => ({
      ...result.data,
      items:
        offset > 0 && previous
          ? [
              ...new Map(
                [...previous.items, ...result.data.items].map((item) => [item.repository, item]),
              ).values(),
            ]
          : result.data.items,
    }));
    if (choosePrimary)
      setRepositories((selected) =>
        selected.length
          ? selected
          : result.data.items.filter((repo) => repo.primary).map((repo) => repo.repository),
      );
  }
  function startEdit(value = current, from?: PlanProposalSource) {
    if (busyRef.current) return;
    if (from && from.markdown.length > 100_000) {
      setError("This message exceeds the plan limit. Prepare a shorter plan before proposing it.");
      return;
    }
    setBaseRevision(value?.state.revision ?? 0);
    draftMarkdown.current = from?.markdown ?? value?.plan?.markdown ?? "";
    setMarkdown(draftMarkdown.current);
    setRepositories(value?.plan?.repositories.map((repo) => repo.repository) ?? []);
    setSelectedAgents(
      value?.plan?.agents.map((agent) => agent.name) ?? (defaultAgent ? [defaultAgent] : []),
    );
    setSource(from?.messageId ?? value?.plan?.source?.messageId);
    setError(null);
    setNotice(null);
    setEditing(true);
    setPendingSource(null);
    retry.current = null;
    void loadRepositories(0, "", !value?.plan);
  }
  async function load(kind: "current" | "history" | "decisions" = "current") {
    if (busyRef.current) return;
    const params = new URLSearchParams();
    if (kind === "history")
      params.set("before_revision", String((historyPages ?? current?.history)?.nextBeforeRevision));
    if (kind === "decisions")
      params.set(
        "before_decision_revision",
        String((decisionPages ?? current?.decisions)?.nextBeforeRevision),
      );
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const n = ++sequence.current;
    const result = await clientApi<StoryPlans>("GET", `${path}${params.size ? `?${params}` : ""}`);
    if (n !== sequence.current) return;
    busyRef.current = false;
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCurrent((old) => newer(old, result.data));
    if (kind === "history")
      setHistoryPages((old) => ({
        ...result.data.history,
        items: mergeRevisions(
          [...(current?.history.items ?? []), ...(old?.items ?? [])],
          result.data.history.items,
          (item) => item.revision,
        ),
      }));
    if (kind === "decisions")
      setDecisionPages((old) => ({
        ...result.data.decisions,
        items: mergeRevisions(
          [...(current?.decisions.items ?? []), ...(old?.items ?? [])],
          result.data.decisions.items,
          (item) => item.decisionRevision,
        ),
      }));
    if (kind === "current") {
      setHistoryPages(null);
      setDecisionPages(null);
      setNotice(
        editing
          ? "Current plan reloaded. Your draft is still here; use it as the next revision or explicitly replace it."
          : null,
      );
    }
  }
  async function mutate(action: "proposal" | "approve" | "reject") {
    if (busyRef.current) return;
    const body =
      action === "proposal"
        ? {
            expected_revision: baseRevision,
            markdown,
            repositories,
            agents: selectedAgents,
            ...(source ? { source_message_id: source } : {}),
          }
        : {
            expected_revision: current?.state.revision ?? 0,
            expected_decision_revision: current?.state.decisionRevision ?? 0,
            intent: action,
            ...(action === "reject" && reason.trim() ? { reason: reason.trim() } : {}),
          };
    const signature = JSON.stringify([action, body]);
    if (retry.current?.signature !== signature)
      retry.current = { signature, key: crypto.randomUUID() };
    const key = retry.current.key;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const n = ++sequence.current;
    if (action === "proposal") {
      const result = await clientApi<StoryPlans>("POST", path, { ...body, idempotency_key: key });
      if (n !== sequence.current) return;
      busyRef.current = false;
      setBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setCurrent((old) => newer(old, result.data));
      const newerDraft = draftMarkdown.current !== markdown;
      setEditing(newerDraft);
      if (newerDraft) setBaseRevision(result.data.state.revision);
      setSource(undefined);
      retry.current = null;
      setNotice(
        newerDraft
          ? `Plan revision ${result.data.state.revision} recorded. Your newer draft is still open and has not been saved.`
          : `Plan revision ${result.data.state.revision} recorded. Review it before confirming a decision.`,
      );
      router.refresh();
    } else {
      const result = await clientApi<{ request: { id: string } }>("POST", `${path}/decisions`, {
        ...body,
        idempotency_key: key,
      });
      if (n !== sequence.current) return;
      busyRef.current = false;
      setBusy(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.push(`${storyPath}/plan/decisions/${encodeURIComponent(result.data.request.id)}`);
    }
  }
  async function showRevision(revision: number) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const n = ++sequence.current;
    const result = await clientApi<StoryPlan>("GET", `${path}/revisions/${revision}`);
    if (n !== sequence.current) return;
    busyRef.current = false;
    setBusy(false);
    if (result.ok) setHistorical(result.data);
    else setError(result.message);
  }
  const enabledAgents = agents.filter((agent) => agent.enabled);
  const invalidAgents = selectedAgents.filter(
    (name) => !enabledAgents.some((agent) => agent.name === name),
  );
  const repoChoices = [
    ...new Map(
      [
        ...(options?.items ?? []),
        ...repositories
          .filter((name) => !options?.items.some((repo) => repo.repository === name))
          .map((repository) => ({ repository, primary: false })),
      ].map((repo) => [repo.repository, repo]),
    ).values(),
  ];
  const history = mergeRevisions(
    current?.history.items ?? [],
    historyPages?.items ?? [],
    (item) => item.revision,
  );
  const decisions = mergeRevisions(
    [...(current?.decisions.items ?? []), ...(current?.decision ? [current.decision] : [])],
    decisionPages?.items ?? [],
    (item) => item.decisionRevision,
  );
  const staleDraft = editing && current && current.state.revision !== baseRevision;
  return (
    <section
      id="story-plan"
      aria-label="Story plan"
      className="flex min-w-0 scroll-mt-6 flex-col gap-4 border border-(--line) p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>plan and decisions</Eyebrow>
          <h2 className="mt-1 text-[18px] font-semibold">
            {current?.plan ? `Plan r${current.state.revision}` : "Agree on the plan"}
          </h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void load()}>
            {busy ? "Loading…" : "Reload plan"}
          </Button>
          {canWrite && current && !editing ? (
            <Button size="sm" disabled={busy} onClick={() => startEdit()}>
              {current.plan ? "Propose revision" : "Propose plan"}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="break-words text-sm text-(--bad)">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-(--mut)">
          {notice}
        </p>
      ) : null}
      {pendingSource && canWrite ? (
        <div
          ref={sourceNotice}
          tabIndex={-1}
          role="status"
          className="flex flex-col gap-3 border border-(--human)/60 p-3"
        >
          <p>
            {editing
              ? "Replace your current draft with this message?"
              : "Use this message as a plan proposal?"}{" "}
            Review its repositories and agents before saving.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => startEdit(current, pendingSource)}>
              Use this message
            </Button>
            <Button size="sm" onClick={() => setPendingSource(null)}>
              {editing ? "Keep my draft" : "Cancel"}
            </Button>
          </div>
        </div>
      ) : null}
      {!current ? (
        <p className="text-sm text-(--mut)">
          Plan metadata is unavailable. Reload the plan to inspect its current revision.
        </p>
      ) : current.plan ? (
        <>
          <p className="text-[13px] font-medium">
            {current.state.status === "approved"
              ? "Approved for this revision"
              : current.state.status === "rejected"
                ? "Changes requested for this revision"
                : "Awaiting a decision on this revision"}
          </p>
          <PlanContent plan={current.plan} />
          {current.decision ? (
            <p className="break-words text-[12px] text-(--mut)">
              {current.decision.planRevision !== current.state.revision
                ? "Earlier decision: "
                : "Decision: "}
              {current.decision.intent === "approve" ? "approved" : "changes requested"} on r
              {current.decision.planRevision} by{" "}
              {current.decision.confirmedBy.name ?? "a project member"} ·{" "}
              {formatTime(current.decision.confirmedAt)}
              {current.decision.reason ? ` · ${current.decision.reason}` : ""}
              {current.decision.planRevision !== current.state.revision
                ? ". This does not approve the current plan."
                : ""}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-(--mut)">
          No plan has been proposed. Write one or use an agent response from the conversation.
        </p>
      )}
      {editing && canWrite ? (
        <form
          className="flex flex-col gap-4 border-t border-(--line) pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate("proposal");
          }}
        >
          <p className="text-[12px] text-(--dim)">
            Draft based on r{baseRevision}. Saving creates an immutable proposal; it does not start
            agents.
          </p>
          {staleDraft ? (
            <div role="alert" className="flex flex-col gap-2 text-sm text-(--bad)">
              <p>A newer plan was recorded. Your draft has been preserved.</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    setBaseRevision(current.state.revision);
                    retry.current = null;
                  }}
                >
                  Use my draft after r{current.state.revision}
                </Button>
                <Button size="sm" onClick={() => startEdit(current)}>
                  Replace draft with current plan
                </Button>
              </div>
            </div>
          ) : null}
          <Field
            label="Plan text"
            hint={
              source
                ? "Exact source message selected. Editing the text removes that attribution."
                : "Include scope, risks and how the result will be checked."
            }
          >
            <textarea
              ref={textarea}
              className="min-h-48 w-full border border-(--line) bg-(--bg-subtle) px-3 py-2 text-[14px] leading-relaxed"
              rows={9}
              value={markdown}
              maxLength={100_000}
              onChange={(event) => {
                draftMarkdown.current = event.target.value;
                setMarkdown(event.target.value);
                setSource(undefined);
              }}
            />
          </Field>
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="mb-2 text-[12px] font-medium">Repositories</legend>
            <div className="flex min-w-0 flex-wrap gap-2">
              <TextInput
                aria-label="Find plan repositories"
                className="min-w-0 flex-1"
                value={query}
                maxLength={200}
                onChange={(event) => setQuery(event.target.value)}
              />
              <Button
                size="sm"
                disabled={loadingOptions}
                onClick={() => void loadRepositories(0, query)}
              >
                Find repositories
              </Button>
            </div>
            {loadingOptions ? (
              <p role="status" className="text-xs text-(--dim)">
                Loading repository names…
              </p>
            ) : null}
            {optionsError ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-(--bad)">
                <span className="break-words">{optionsError}</span>
                <Button size="sm" onClick={() => void loadRepositories(0, query)}>
                  Retry repository list
                </Button>
              </div>
            ) : null}
            {repoChoices.map((repo) => (
              <label key={repo.repository} className="flex min-w-0 items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={repositories.includes(repo.repository)}
                  disabled={
                    busy || (!repositories.includes(repo.repository) && repositories.length >= 50)
                  }
                  onChange={(event) =>
                    setRepositories((selected) =>
                      event.target.checked
                        ? [...selected, repo.repository]
                        : selected.filter((name) => name !== repo.repository),
                    )
                  }
                />
                <span className="min-w-0 break-words">
                  {repo.repository}
                  {repo.primary ? " · primary repository" : ""}
                </span>
              </label>
            ))}
            {options && !options.items.length ? (
              <p className="text-xs text-(--mut)">
                No matching repositories. A project owner can connect repositories in Settings.
              </p>
            ) : null}
            {options?.hasMore ? (
              <Button
                size="sm"
                disabled={loadingOptions}
                onClick={() => void loadRepositories(options.nextOffset ?? 0)}
              >
                More repositories
              </Button>
            ) : null}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-[12px] font-medium">Agents</legend>
            {enabledAgents.map((agent) => (
              <label key={agent.name} className="flex items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selectedAgents.includes(agent.name)}
                  disabled={
                    busy || (!selectedAgents.includes(agent.name) && selectedAgents.length >= 20)
                  }
                  onChange={(event) =>
                    setSelectedAgents((selected) =>
                      event.target.checked
                        ? [...selected, agent.name]
                        : selected.filter((name) => name !== agent.name),
                    )
                  }
                />
                <span className="min-w-0 break-words">
                  {agent.name} · {agent.model}
                </span>
              </label>
            ))}
            {invalidAgents.map((name) => (
              <label key={name} className="flex items-start gap-2 text-[13px] text-(--bad)">
                <input
                  type="checkbox"
                  checked
                  disabled={busy}
                  onChange={() =>
                    setSelectedAgents((selected) => selected.filter((agent) => agent !== name))
                  }
                />
                <span className="break-words">{name} · unavailable; remove from this proposal</span>
              </label>
            ))}
            {catalogError || invalidAgents.length || !enabledAgents.length ? (
              <p role="alert" className="break-words text-xs text-(--bad)">
                {catalogError ??
                  (invalidAgents.length
                    ? `Choose an available agent instead of ${invalidAgents.join(", ")}.`
                    : "No enabled agents are available. Ask a project owner to review the agent configuration.")}
              </p>
            ) : null}
          </fieldset>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={
                busy ||
                !!staleDraft ||
                !markdown.trim() ||
                !repositories.length ||
                !selectedAgents.length ||
                !!invalidAgents.length ||
                !!catalogError
              }
            >
              {busy ? "Saving…" : "Save plan proposal"}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setEditing(false)}>
              Discard plan draft
            </Button>
          </div>
        </form>
      ) : null}
      {canWrite && current?.plan && !editing ? (
        <div className="flex flex-col gap-3 border-t border-(--line) pt-4">
          <p className="text-[12px] text-(--dim)">
            Review and confirm the exact plan on the next page. Confirmation does not start agents
            or accept delivery.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={() => {
                setReason("");
                void mutate("approve");
              }}
            >
              Review approval
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setRejecting((value) => !value)}>
              Request changes
            </Button>
          </div>
          {rejecting ? (
            <div className="flex flex-col gap-3">
              <Field label="What should change?">
                <TextArea
                  rows={3}
                  maxLength={2000}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Field>
              <Button
                size="sm"
                disabled={busy || !reason.trim()}
                onClick={() => void mutate("reject")}
              >
                Review requested changes
              </Button>
            </div>
          ) : null}
          {current.pending.items
            .filter((item) => !item.boundUserId || item.boundUserId === userId)
            .map((item) => (
              <Link
                key={item.id}
                className="break-words text-[12px] underline underline-offset-4"
                href={`${storyPath}/plan/decisions/${encodeURIComponent(item.id)}`}
              >
                Open requested {item.intent === "approve" ? "approval" : "changes"} for r
                {item.planRevision} · expires {formatTime(item.expiresAt)}
              </Link>
            ))}
          {current.pending.hasMore ? (
            <p className="text-xs text-(--dim)">
              More requests exist. You can request a fresh review of the current plan above.
            </p>
          ) : null}
        </div>
      ) : null}
      {history.length || decisions.length ? (
        <details className="border-t border-(--line) pt-4 text-[12px]">
          <summary className="cursor-pointer">Plan and decision history</summary>
          <div className="mt-3 flex flex-col gap-3">
            {history.map((item) => (
              <div key={item.revision} className="flex flex-wrap items-center gap-2">
                <span>
                  Plan r{item.revision} · {formatTime(item.proposedAt)}
                </span>
                <Button size="sm" disabled={busy} onClick={() => void showRevision(item.revision)}>
                  Read r{item.revision}
                </Button>
              </div>
            ))}
            {(historyPages ?? current?.history)?.hasMore ? (
              <Button size="sm" disabled={busy} onClick={() => void load("history")}>
                Older plan revisions
              </Button>
            ) : null}
            {decisions.map((item) => (
              <p key={item.id} className="break-words">
                Decision {item.decisionRevision}:{" "}
                {item.intent === "approve" ? "approved" : "changes requested"} r{item.planRevision}{" "}
                · {item.confirmedBy.name ?? "project member"} · {formatTime(item.confirmedAt)}
                {item.reason ? ` · ${item.reason}` : ""}
              </p>
            ))}
            {(decisionPages ?? current?.decisions)?.hasMore ? (
              <Button size="sm" disabled={busy} onClick={() => void load("decisions")}>
                Older decisions
              </Button>
            ) : null}
            {historical ? (
              <div className="flex min-w-0 flex-col gap-3 border border-(--line) p-3">
                <p className="font-medium">Historical plan · r{historical.revision}</p>
                <PlanContent plan={historical} />
                <Button size="sm" onClick={() => setHistorical(null)}>
                  Close historical plan
                </Button>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </section>
  );
}
