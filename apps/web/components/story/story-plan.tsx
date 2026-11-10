"use client";

import type {
  StoryAgent,
  StoryPlan,
  StoryPlanRepositories,
  StoryPlans,
  StoryWorkflowStatus,
} from "@facility/sdk";
import { Button, Field, TextArea, TextInput } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PlanContent } from "@/components/story/plan-content";
import { PlanExecutionOutcome } from "@/components/story/plan-execution-outcome";
import { PlanExecutionScope } from "@/components/story/plan-execution-scope";
import { clientApi } from "@/lib/client-api";
import { PLAN_PROPOSAL_EVENT, type PlanProposalSource } from "@/lib/story-plan-events";
import { formatTime } from "@/lib/story-presentation";
import {
  type PlanSelection,
  selectionMatchesPlan,
  storyReviewHref,
} from "@/lib/story-review-navigation";

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
  selection,
  latestPlanHref,
  agents,
  defaultAgent,
  queuedAgents = [],
  blockedReason,
  workflow,
  catalogError,
  canWrite,
  userId,
}: {
  projectId: string;
  storyId: string;
  initial?: StoryPlans;
  selection?: PlanSelection;
  latestPlanHref?: string;
  agents: StoryAgent[];
  defaultAgent: string | null;
  queuedAgents?: string[];
  blockedReason?: string | null;
  workflow?: StoryWorkflowStatus;
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
  const initializeRepositoryScope = useRef(false);
  const [scopeNotice, setScopeNotice] = useState<string | null>(null);
  const observedHeads = useRef({
    revision: initial?.state.revision ?? 0,
    decisionRevision: initial?.state.decisionRevision ?? 0,
  });
  const path = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/plan`;
  const storyPath = `/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(storyId)}`;
  const selectionCurrent =
    !selection ||
    (current?.state.revision === selection.revision &&
      selectionMatchesPlan(selection, current?.plan));
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
        !selection &&
        value?.projectId === projectId &&
        value.storyId === storyId &&
        typeof value.markdown === "string"
      )
        setPendingSource(value);
    }
    window.addEventListener(PLAN_PROPOSAL_EVENT, receive);
    return () => window.removeEventListener(PLAN_PROPOSAL_EVENT, receive);
  }, [projectId, storyId, canWrite, selection]);
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

  async function loadRepositories(offset = 0, term = "") {
    const n = ++optionsSequence.current;
    if (offset === 0) searchTerm.current = term;
    setLoadingOptions(true);
    setOptionsError(null);
    const result = await clientApi<Repositories>(
      "GET",
      `${path}/repositories?${new URLSearchParams({ q: searchTerm.current, limit: "50", offset: String(offset) })}`,
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
    if (initializeRepositoryScope.current && offset === 0 && term === "") {
      initializeRepositoryScope.current = false;
      setRepositories(result.data.hasMore ? [] : result.data.items.map((repo) => repo.repository));
      setScopeNotice(
        result.data.hasMore
          ? "This project has more than 50 connected repositories. No partial scope was selected automatically. Review the required scope; a plan can include up to 50 repositories."
          : "All connected project repositories are selected for this new plan. Review the scope before saving; removing repositories can leave queued work blocked.",
      );
    }
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
      value?.plan?.agents.map((agent) => agent.name) ??
        (queuedAgents.length
          ? [...new Set(queuedAgents)]
          : from
            ? from.agentName
              ? [from.agentName]
              : []
            : defaultAgent
              ? [defaultAgent]
              : []),
    );
    initializeRepositoryScope.current = !value?.plan;
    setScopeNotice(null);
    setOptions(null);
    setQuery("");
    setSource(from?.messageId ?? value?.plan?.source?.messageId);
    setError(null);
    setNotice(null);
    setEditing(true);
    setPendingSource(null);
    retry.current = null;
    void loadRepositories();
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
    if (!selectionCurrent || (selection && action === "proposal")) {
      setError(
        "Open the current plan explicitly before changing or deciding a different revision.",
      );
      return;
    }
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
  const missingQueuedAgents = [...new Set(queuedAgents)].filter(
    (name) => !current?.plan?.agents.some((agent) => agent.name === name),
  );
  if (selection && !selectionCurrent)
    return (
      <section
        id="story-plan"
        aria-label="Story plan"
        className="flex min-w-0 scroll-mt-6 flex-col gap-4"
      >
        <h2 className="text-lg font-semibold">
          {selection.revision ? `Linked plan r${selection.revision}` : "Linked plan unavailable"}
        </h2>
        <p role={selection.error ? "alert" : "status"} className="text-sm text-(--mut)">
          {selection.error ??
            (current?.plan
              ? `The current plan is r${current.plan.revision}. This linked revision stays open for comparison; no decision will be requested for a different plan.`
              : "The current plan could not be verified. This linked revision stays open for reading.")}
        </p>
        <Link
          className="inline-flex min-h-11 items-center text-(--info) underline underline-offset-4"
          href={latestPlanHref ?? `${storyPath}#story-plan`}
        >
          Open current plan{current?.plan ? ` r${current.plan.revision}` : ""}
        </Link>
        {blockedReason ? (
          <p className="border-l-2 border-(--human) pl-3 text-sm">
            Current workflow: {blockedReason}
          </p>
        ) : null}
        {selection.plan && !selection.error ? (
          <PlanContent plan={selection.plan} location={{ projectId, storyId }} />
        ) : null}
      </section>
    );
  const decisionActions =
    canWrite && current?.plan && (!editing || selection) ? (
      <div className="flex flex-col gap-3">
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
            Approve plan r{current.state.revision}
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
    ) : null;
  return (
    <section
      id="story-plan"
      aria-label="Story plan"
      className="flex min-w-0 scroll-mt-6 flex-col gap-4"
    >
      <h2 className="flex flex-wrap items-baseline gap-x-3 text-[18px] font-semibold">
        {current?.plan ? `Plan r${current.state.revision}` : "Agree on the plan"}
        {current?.state.status === "proposed" ? (
          <span className="text-xs font-normal text-(--human)">Pending approval</span>
        ) : null}
      </h2>
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
      {blockedReason ? (
        <div role="status" className="flex flex-col gap-2 border-l-2 border-(--human) pl-3 text-sm">
          <p className="break-words text-(--mut)">{blockedReason}</p>
          {queuedAgents.length ? (
            <p className="break-words text-(--mut)">
              Waiting agents: {[...new Set(queuedAgents)].join(", ")}.
            </p>
          ) : null}
        </div>
      ) : null}
      {current?.plan && missingQueuedAgents.length ? (
        <p role="alert" className="text-sm text-(--bad)">
          This plan does not include queued work for {missingQueuedAgents.join(", ")}. Propose a
          revision with the intended agents before approving recovery.
        </p>
      ) : null}
      {current && !current.plan && !editing ? (
        <PlanExecutionScope
          scope={workflow?.executionScope}
          planRevision={current.state.revision}
        />
      ) : null}
      {pendingSource && canWrite && !selection ? (
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
          {current.state.status !== "proposed" ? (
            <p className="text-[13px] font-medium">
              {current.state.status === "approved"
                ? "Approved for this revision"
                : current.state.status === "rejected"
                  ? "Changes requested for this revision"
                  : "Awaiting a decision on this revision"}
            </p>
          ) : null}
          {current.state.status === "approved" && current.decision ? (
            <PlanExecutionOutcome
              decision={current.decision}
              workflow={workflow}
              storyPath={`/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(storyId)}`}
            />
          ) : null}
          <PlanContent
            plan={selection?.plan ?? current.plan}
            location={{ projectId, storyId }}
            checks={
              (!editing || selection) && (current.state.status !== "approved" || blockedReason) ? (
                <PlanExecutionScope
                  scope={workflow?.executionScope}
                  planRevision={current.state.revision}
                />
              ) : null
            }
            actions={decisionActions}
          />
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
      {editing && canWrite && !selection ? (
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
            {scopeNotice ? (
              <p role="status" className="text-xs text-(--mut)">
                {scopeNotice}
              </p>
            ) : null}
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
                  onChange={(event) => {
                    initializeRepositoryScope.current = false;
                    setRepositories((selected) =>
                      event.target.checked
                        ? [...selected, repo.repository]
                        : selected.filter((name) => name !== repo.repository),
                    );
                  }}
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
            <p className="text-xs text-(--mut)">
              Choose the agents allowed to execute this plan. The author and the executing agent can
              differ.
              {queuedAgents.length
                ? ` Existing queued work: ${[...new Set(queuedAgents)].join(", ")}. A matching approval may resume those turns.`
                : ""}
            </p>
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
                loadingOptions ||
                !!staleDraft ||
                !markdown.trim() ||
                !repositories.length ||
                !selectedAgents.length ||
                selectedAgents.length > 20 ||
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-(--mut)">
        {selection ? (
          <Link
            href={latestPlanHref ?? `${storyPath}#story-plan`}
            className="inline-flex min-h-11 items-center text-(--info) underline"
          >
            Open current plan to edit
          </Link>
        ) : canWrite && current && !editing ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => startEdit()}
            className="min-h-11 underline underline-offset-4 hover:text-(--ink)"
          >
            {current.plan ? "Propose revision" : "Propose plan"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void load()}
          className="min-h-11 underline underline-offset-4 hover:text-(--ink)"
        >
          {busy ? "Loading…" : "Reload plan"}
        </button>
      </div>
      {history.length || decisions.length ? (
        <details className="text-[12px]">
          <summary className="min-h-11 w-fit cursor-pointer py-3 text-(--mut)">
            Plan and decision history
          </summary>
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
                <Link
                  href={storyReviewHref(projectId, storyId, {
                    revision: historical.revision,
                    digest: historical.digest,
                  })}
                  className="inline-flex min-h-11 items-center text-(--info) underline"
                >
                  Open linked revision r{historical.revision}
                </Link>
                <PlanContent plan={historical} location={{ projectId, storyId }} />
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
