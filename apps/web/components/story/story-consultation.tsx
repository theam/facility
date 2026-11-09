"use client";

import type {
  RequestStoryConsultation,
  StoryAgent,
  StoryConsultation,
  StoryConsultationHandoff,
  StoryConsultationOptions,
  StoryConsultations,
} from "@facility/sdk";
import { Button, Eyebrow, Field, Select, TextArea, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { StoryComposer } from "@/components/story/story-actions";
import { clientApi } from "@/lib/client-api";
import {
  type ConsultationDraft,
  consultationDraftKey,
  readConsultationDraft,
  writeConsultationDraft,
} from "@/lib/consultation-draft";
import { formatTime } from "@/lib/story-presentation";

const active = (item: StoryConsultation) => ["queued", "preparing", "running"].includes(item.state);
function merge(previous: StoryConsultation[], incoming: StoryConsultation[]) {
  const rows = new Map(previous.map((row) => [row.id, row]));
  for (const next of incoming) {
    const before = rows.get(next.id);
    // A replayed queued receipt cannot undo an already observed terminal result.
    rows.set(
      next.id,
      before?.endedAt && !next.endedAt
        ? {
            ...before,
            billing: next.billing.costsVisible
              ? before.billing
              : { ...before.billing, costsVisible: false, costCents: null, estimatedCents: null },
          }
        : next,
    );
  }
  return [...rows.values()].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
}
const money = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(cents / 100);
function failure(code: string | null) {
  if (!code) return null;
  if (code.includes("authorization")) return "Permission to run this consultation was revoked.";
  if (code.includes("configuration"))
    return "The agent configuration changed. Review it before starting a new consultation.";
  if (code.includes("repository") || code.includes("source"))
    return "A selected source could not be verified. Review its repository, commit and path.";
  if (code.includes("budget"))
    return "The project budget could not admit this consultation. Check the budget and any unconfirmed spending.";
  if (code.includes("tool_denied"))
    return "The response requested tools, which this consultation cannot execute.";
  if (code.includes("credentials")) return "The configured provider API key is unavailable.";
  if (code.includes("canceled"))
    return "Cancellation recorded. Any submitted model usage is retained.";
  if (code.includes("expired")) return "The consultation expired.";
  if (code.includes("refused")) return "The provider declined this request.";
  if (code.includes("context_too_large"))
    return "Choose fewer or smaller sources, or shorten the question.";
  if (code.includes("incomplete")) return "The response ended before completion.";
  return "The consultation could not finish. Check its billing status below before starting another request.";
}
const capabilityReason = (code: string | null) =>
  code === "provider_api_key_unavailable"
    ? "This model needs its project provider API key. Native subscription login is not used."
    : code === "agent_prompt_too_large"
      ? "The agent prompt exceeds the consultation snapshot limit."
      : code === "reasoning_api_unsupported"
        ? "This agent's reasoning settings are not supported by the text API executor."
        : code === "agent_unavailable"
          ? "This agent is not enabled for this surface."
          : code
            ? "The configured model is not supported by the text API executor."
            : "";

export function StoryConsultationPanel({
  projectId,
  storyId,
  initial,
  initialError,
  agents,
  defaultAgent,
  canExecute,
  draftOwnerId,
}: {
  projectId: string;
  storyId: string;
  initial?: StoryConsultations;
  initialError?: string;
  agents: StoryAgent[];
  defaultAgent: string | null;
  canExecute: boolean;
  draftOwnerId?: string;
}) {
  const router = useRouter();
  const base = `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories/${encodeURIComponent(storyId)}/consultations`;
  const storageKey = consultationDraftKey(draftOwnerId, projectId, storyId);
  const [draft, setDraft] = useState<ConsultationDraft>({
    agent: defaultAgent ?? "",
    question: "",
    sources: [],
  });
  const [loaded, setLoaded] = useState(false),
    [saved, setSaved] = useState(false),
    [open, setOpen] = useState(false);
  const [items, setItems] = useState(initial?.items ?? []),
    [total, setTotal] = useState(initial?.total ?? 0);
  const [options, setOptions] = useState<StoryConsultationOptions | null>(null),
    [optionsError, setOptionsError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState(initialError ?? null),
    [error, setError] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [optionsLoading, setOptionsLoading] = useState(false),
    [historyLoading, setHistoryLoading] = useState(false);
  const [handoff, setHandoff] = useState<StoryConsultationHandoff | null>(null);
  const sending = useRef(false),
    optionSequence = useRef(0);
  const question = useRef<HTMLFormElement>(null);
  useEffect(() => {
    const previous = readConsultationDraft(storageKey);
    if (previous) setDraft(previous);
    setLoaded(true);
  }, [storageKey]);
  useEffect(() => {
    if (loaded) setSaved(writeConsultationDraft(storageKey, draft));
  }, [draft, loaded, storageKey]);
  useEffect(() => {
    if (initial) {
      setItems((previous) => merge(previous, initial.items));
      setTotal(initial.total);
      setHistoryError(null);
    } else if (initialError) setHistoryError(initialError);
  }, [initial, initialError]);
  useEffect(() => {
    if (open && loaded && !busy)
      question.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [open, loaded, busy]);
  useEffect(
    () => () => {
      optionSequence.current++;
    },
    [],
  );
  const selected = options?.agents.find((agent) => agent.name === draft.agent);
  const waiting = items.some(active);

  async function loadOptions() {
    const sequence = ++optionSequence.current;
    setOptionsLoading(true);
    setOptionsError(null);
    const result = await clientApi<StoryConsultationOptions>("GET", `${base}/options`);
    if (sequence !== optionSequence.current) return;
    setOptionsLoading(false);
    if (result.ok) setOptions(result.data);
    else setOptionsError(result.message);
  }
  async function history(more = false) {
    setHistoryLoading(true);
    setHistoryError(null);
    const result = await clientApi<StoryConsultations>(
      "GET",
      `${base}?limit=10&offset=${more ? items.length : 0}`,
    );
    setHistoryLoading(false);
    if (result.ok) {
      setItems((previous) => merge(previous, result.data.items));
      setTotal(result.data.total);
    } else setHistoryError(result.message);
  }
  function edit(change: Partial<ConsultationDraft>) {
    setError(null);
    setNotice(null);
    setDraft((previous) => ({ ...previous, ...change, attempt: undefined }));
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      sending.current ||
      !canExecute ||
      !loaded ||
      !draft.question.trim() ||
      (waiting && !draft.attempt)
    )
      return;
    let attempt = draft.attempt;
    if (!attempt) {
      if (!options || !selected?.eligible) return;
      if (new TextEncoder().encode(draft.question).length > options.limits.requestBytes) {
        setError("The question exceeds its byte limit. Shorten it before sending.");
        return;
      }
      const sources = draft.sources.map((source) => ({
        repository_id: source.repositoryId,
        commit_sha: source.commitSha,
        path: source.path,
      }));
      if (
        sources.some(
          (source) =>
            !source.repository_id ||
            !/^[a-f0-9]{40}$/.test(source.commit_sha) ||
            !source.path.trim(),
        )
      ) {
        setError("Choose a repository, an exact commit and a file path for each source.");
        return;
      }
      const body: RequestStoryConsultation = {
        agent: draft.agent,
        expected_agent_hash: selected.manifestHash,
        expected_catalog_sha: options.catalogSha,
        message: draft.question,
        sources,
        idempotency_key: `ui-message-${crypto.randomUUID()}`,
      };
      attempt = { body, model: selected.model };
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    const pending = { ...draft, attempt };
    setDraft(pending);
    writeConsultationDraft(storageKey, pending);
    const response = await clientApi<StoryConsultation>("POST", base, attempt.body);
    sending.current = false;
    setBusy(false);
    if (!response.ok) {
      setError(response.message);
      return;
    }
    setItems((previous) => merge(previous, [response.data]));
    setDraft({ agent: draft.agent, question: "", sources: [] });
    writeConsultationDraft(storageKey, { agent: draft.agent, question: "", sources: [] });
    setOpen(false);
    setNotice("Consultation saved. Its current status appears below.");
    await history();
    router.refresh();
  }
  async function cancel(item: StoryConsultation) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await clientApi<StoryConsultation>(
      "POST",
      `${base}/${encodeURIComponent(item.id)}/cancel`,
      { idempotency_key: `ui-message-${crypto.randomUUID()}` },
    );
    sending.current = false;
    setBusy(false);
    if (!result.ok) setError(result.message);
    else {
      setItems((previous) => merge(previous, [result.data]));
      router.refresh();
    }
  }
  async function prepare(item: StoryConsultation) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError(null);
    const result = await clientApi<StoryConsultationHandoff>(
      "GET",
      `${base}/${encodeURIComponent(item.id)}/handoff`,
    );
    sending.current = false;
    setBusy(false);
    if (result.ok) {
      setHandoff(result.data);
      setOpen(false);
    } else setError(result.message);
  }
  return (
    <section
      id="consultation"
      className="flex min-w-0 flex-col gap-4 border border-(--line) p-5 lg:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Eyebrow>read-only consultation</Eyebrow>
          <h2 className="mt-2 text-lg font-semibold">Ask about this task</h2>
        </div>
        {canExecute && (
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              setOpen((value) => !value);
              if (!open && !options) void loadOptions();
            }}
          >
            {open
              ? "Close consultation draft"
              : draft.question
                ? "Resume consultation draft"
                : "New consultation"}
          </Button>
        )}
      </div>
      <p className="text-[12px] text-(--dim)">
        A paid text response from the configured model, using saved task context, plan, PR
        observations and selected committed files. Workspace changes require a separate
        implementation request. Uncommitted workspace files are excluded.
      </p>
      {notice && (
        <p role="status" className="text-sm text-(--mut)">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-(--bad)">
          {error}
        </p>
      )}
      {open && canExecute && (
        <form
          ref={question}
          aria-label="Start a read-only consultation"
          onSubmit={submit}
          className="flex min-w-0 flex-col gap-4 border-t border-(--line) pt-4"
        >
          {optionsLoading && (
            <p role="status" className="text-sm text-(--dim)">
              Reading agent capabilities and source revisions…
            </p>
          )}
          {optionsError && (
            <p role="alert" className="text-sm text-(--bad)">
              {optionsError}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Consult with" className="w-full min-w-0 sm:w-auto sm:flex-1">
              <Select
                aria-label="Consult with"
                value={draft.agent}
                disabled={busy || Boolean(draft.attempt)}
                onChange={(event) => edit({ agent: event.target.value })}
              >
                <option value="">Choose an agent</option>
                {options?.agents.map((agent) => (
                  <option key={agent.name} value={agent.name}>
                    {agent.name} · {agent.model}
                    {agent.eligible ? "" : " · unavailable"}
                  </option>
                ))}
                {draft.agent && !options?.agents.some((a) => a.name === draft.agent) && (
                  <option value={draft.agent}>{draft.agent} · awaiting capability check</option>
                )}
              </Select>
            </Field>
            <Button
              type="button"
              variant="textual"
              disabled={busy || optionsLoading}
              onClick={() => void loadOptions()}
            >
              Refresh options
            </Button>
          </div>
          {selected && !draft.attempt && (
            <p className="text-[12px] text-(--dim)">
              {selected.model}
              {selected.reasoningEffort ? ` · ${selected.reasoningEffort} reasoning` : ""}.{" "}
              {selected.eligible
                ? selected.estimateCents === null
                  ? "Project budget enforcement applies."
                  : `Reserves an estimate of ${money(selected.estimateCents)} before starting.`
                : capabilityReason(selected.reason)}
            </p>
          )}
          <Field label="Consultation question">
            <TextArea
              aria-label="Consultation question"
              value={draft.question}
              rows={4}
              maxLength={8000}
              disabled={busy || Boolean(draft.attempt)}
              onChange={(event) => edit({ question: event.target.value })}
              placeholder="Ask for analysis, an explanation, or a review of a proposed change."
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-[12px] text-(--dim)">
              Optional committed source files · up to {options?.limits.files ?? 4}
            </span>
            <Button
              type="button"
              variant="textual"
              disabled={
                busy ||
                Boolean(draft.attempt) ||
                !options ||
                draft.sources.length >= (options?.limits.files ?? 4)
              }
              onClick={() =>
                edit({
                  sources: [
                    ...draft.sources,
                    { rowId: crypto.randomUUID(), repositoryId: "", commitSha: "", path: "" },
                  ],
                })
              }
            >
              Add source file
            </Button>
          </div>
          {draft.sources.map((source, index) => (
            <div
              key={source.rowId}
              className="flex min-w-0 flex-col gap-3 border border-(--line) p-3"
            >
              <div className="flex flex-wrap items-end gap-3">
                <Field
                  label={`Source ${index + 1} repository`}
                  className="w-full min-w-0 sm:w-auto sm:flex-1"
                >
                  <Select
                    aria-label={`Source ${index + 1} repository`}
                    value={source.repositoryId}
                    disabled={busy || Boolean(draft.attempt)}
                    onChange={(event) => {
                      const repository = options?.repositories.find(
                        (r) => r.id === event.target.value,
                      );
                      edit({
                        sources: draft.sources.map((row, i) =>
                          i === index
                            ? {
                                ...row,
                                repositoryId: event.target.value,
                                commitSha: repository?.commitSha ?? "",
                              }
                            : row,
                        ),
                      });
                    }}
                  >
                    <option value="">Choose a connected repository</option>
                    {options?.repositories.map((repository) => (
                      <option key={repository.id} value={repository.id}>
                        {repository.repository} · {repository.branch}
                      </option>
                    ))}
                    {source.repositoryId &&
                      !options?.repositories.some((r) => r.id === source.repositoryId) && (
                        <option value={source.repositoryId}>
                          Previous repository · refresh connection
                        </option>
                      )}
                  </Select>
                </Field>
                <Button
                  type="button"
                  variant="textual"
                  disabled={busy || Boolean(draft.attempt)}
                  onClick={() => edit({ sources: draft.sources.filter((_, i) => i !== index) })}
                >
                  Remove source {index + 1}
                </Button>
              </div>
              <Field label={`Source ${index + 1} file path`}>
                <TextInput
                  aria-label={`Source ${index + 1} file path`}
                  value={source.path}
                  maxLength={500}
                  disabled={busy || Boolean(draft.attempt)}
                  onChange={(event) =>
                    edit({
                      sources: draft.sources.map((row, i) =>
                        i === index ? { ...row, path: event.target.value } : row,
                      ),
                    })
                  }
                  placeholder="src/service.ts"
                />
              </Field>
              <details>
                <summary className="cursor-pointer break-all text-[12px] text-(--dim)">
                  Pinned commit {source.commitSha ? source.commitSha.slice(0, 12) : "not selected"}
                </summary>
                <Field label={`Source ${index + 1} exact commit`}>
                  <TextInput
                    aria-label={`Source ${index + 1} exact commit`}
                    value={source.commitSha}
                    maxLength={40}
                    disabled={busy || Boolean(draft.attempt)}
                    onChange={(event) =>
                      edit({
                        sources: draft.sources.map((row, i) =>
                          i === index ? { ...row, commitSha: event.target.value } : row,
                        ),
                      })
                    }
                  />
                </Field>
              </details>
            </div>
          ))}
          {draft.attempt && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-[12px] text-(--dim)">
                Retry the original request for {draft.attempt.model} to confirm it without creating
                another paid attempt.
              </p>
              <Button type="button" variant="textual" disabled={busy} onClick={() => edit({})}>
                Edit as a new request
              </Button>
            </div>
          )}
          <p className="text-[12px] text-(--dim)">
            {saved
              ? "Closing keeps this draft in this tab for up to 24 hours."
              : "Closing keeps this draft while the page is open."}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              disabled={
                busy ||
                !loaded ||
                !draft.question.trim() ||
                (!draft.attempt && (!selected?.eligible || waiting))
              }
            >
              {busy
                ? "Saving consultation…"
                : draft.attempt
                  ? "Retry original consultation"
                  : "Start consultation"}
            </Button>
            <Button
              type="button"
              variant="textual"
              disabled={busy}
              onClick={() => {
                edit({ question: "", sources: [] });
                writeConsultationDraft(storageKey, {
                  agent: draft.agent,
                  question: "",
                  sources: [],
                });
                setNotice("Consultation draft discarded.");
              }}
            >
              Discard consultation draft
            </Button>
          </div>
          {waiting && (
            <p className="text-[12px] text-(--dim)">
              A consultation is already active for this task. Its status appears below.
            </p>
          )}
        </form>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Eyebrow>saved consultations</Eyebrow>
        <Button
          type="button"
          variant="textual"
          disabled={historyLoading}
          onClick={() => void history()}
        >
          Refresh consultations
        </Button>
      </div>
      {historyError && (
        <p role="alert" className="text-sm text-(--bad)">
          {historyError}
        </p>
      )}
      {!items.length && !historyError && (
        <p className="text-sm text-(--dim)">No consultations saved for this task.</p>
      )}
      {items.map((item) => (
        <article
          key={item.id}
          className="flex min-w-0 flex-col gap-3 border-t border-(--line) pt-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="min-w-0 wrap-anywhere text-sm font-medium">
              {item.agent.name} · {item.state}
              {item.cancelRequestedAt && active(item) ? " · cancellation requested" : ""}
            </h3>
            <time className="text-[11px] text-(--dim)">{formatTime(item.createdAt)}</time>
          </div>
          <p className="wrap-anywhere text-[12px] text-(--dim)">
            {item.agent.model}
            {item.agent.reasoningEffort ? ` · ${item.agent.reasoningEffort} reasoning` : ""} · text
            API consultation
          </p>
          <p className="whitespace-pre-wrap wrap-anywhere text-sm">{item.request}</p>
          {item.errorCode && <p className="text-[12px] text-(--dim)">{failure(item.errorCode)}</p>}
          {item.result !== null && (
            <pre className="max-h-128 overflow-y-auto whitespace-pre-wrap wrap-anywhere font-sans text-[13px] leading-relaxed">
              {item.result}
            </pre>
          )}
          <p className="text-[12px] text-(--dim)">
            {item.billing.state === "unconfirmed"
              ? "Usage unconfirmed. "
              : item.billing.state === "not_started"
                ? "No model request started. "
                : `Usage ${item.billing.state}. `}
            {item.billing.costsVisible && item.billing.costCents !== null
              ? `${item.billing.state === "unconfirmed" ? "At least " : "Recorded charge: "}${money(item.billing.costCents)}.`
              : !item.billing.costsVisible
                ? "Cost details are unavailable with your current permissions."
                : item.billing.estimatedCents !== null
                  ? item.billing.state === "unconfirmed"
                    ? `Admission estimate: ${money(item.billing.estimatedCents)}. The final charge is unknown.`
                    : `Reserved estimate: ${money(item.billing.estimatedCents)}.`
                  : ""}
          </p>
          <details className="min-w-0 text-[12px] text-(--dim)">
            <summary className="cursor-pointer">Snapshot and provenance</summary>
            <div className="mt-2 flex flex-col gap-2 break-all">
              <span>
                {item.id} · {item.actor.name ?? item.actor.id}
              </span>
              <span>Agent catalog: {item.agent.catalogSha}</span>
              {item.context.taskState && (
                <span>
                  Task state: {item.context.taskState.hash} · plan revision{" "}
                  {item.context.taskState.planRevision} · decision revision{" "}
                  {item.context.taskState.decisionRevision} · delivery revision{" "}
                  {item.context.taskState.deliveryScopeRevision} · observed{" "}
                  {formatTime(item.context.taskState.capturedAt)}
                </span>
              )}
              <span>
                Snapshot: {item.context.hash ?? "not captured"} · conversation through message{" "}
                {item.context.throughMessageSeq}
              </span>
              {!item.context.hash &&
                item.context.requestedSources.map((file) => (
                  <span key={JSON.stringify([file.repository_id, file.commit_sha, file.path])}>
                    Requested source: {file.repository_id}/{file.path} @ {file.commit_sha} ·
                    awaiting verification
                  </span>
                ))}
              {item.context.files.map((file) => (
                <span key={JSON.stringify([file.repositoryId, file.commitSha, file.path])}>
                  {file.repository}/{file.path} @ {file.commitSha} · {file.bytes} bytes ·{" "}
                  {file.hash}
                </span>
              ))}
              {item.context.omissions.map((omission) => (
                <span key={omission}>{omission}</span>
              ))}
              {item.resultHash && <span>Result SHA-256: {item.resultHash}</span>}
            </div>
          </details>
          <div className="flex flex-wrap gap-3">
            {canExecute && active(item) && (
              <Button
                type="button"
                disabled={busy || item.cancelRequestedAt !== null}
                onClick={() => void cancel(item)}
              >
                Cancel consultation
              </Button>
            )}
            {canExecute && item.state === "succeeded" && item.billing.state === "confirmed" && (
              <Button
                type="button"
                className="max-w-full"
                disabled={busy}
                onClick={() => void prepare(item)}
              >
                <span className="whitespace-normal text-left">Prepare implementation request</span>
              </Button>
            )}
          </div>
        </article>
      ))}
      {items.length < total && (
        <Button
          type="button"
          variant="textual"
          disabled={historyLoading}
          onClick={() => void history(true)}
        >
          {historyLoading
            ? "Loading consultations…"
            : `Load older consultations (${items.length} of ${total} shown)`}
        </Button>
      )}
      {handoff && canExecute && (
        <div className="flex flex-col gap-3 border-t border-(--line) pt-4">
          <h3 className="text-sm font-semibold">Implementation request from this consultation</h3>
          <p className="text-[12px] text-(--dim)">
            Review the request and recipient below. Sending it starts the normal implementation
            workflow.
          </p>
          <StoryComposer
            composerId={`consultation-implementation-${handoff.consultationId}`}
            formLabel="Send an implementation request"
            key={handoff.consultationId}
            projectId={projectId}
            storyId={storyId}
            agents={agents.filter((agent) => agent.enabled)}
            initialDraft={{ agent: defaultAgent ?? "", message: handoff.message }}
            draftOwnerId={
              draftOwnerId
                ? JSON.stringify([
                    draftOwnerId,
                    "consultation-implementation",
                    handoff.consultationId,
                  ])
                : undefined
            }
            onCancel={() => setHandoff(null)}
            onDone={(message) => {
              setHandoff(null);
              setNotice(message);
            }}
          />
        </div>
      )}
    </section>
  );
}
