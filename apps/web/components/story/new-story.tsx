"use client";

import { Button, cx, TextArea } from "@facility/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import type { WorkspaceStoryBundle } from "@/lib/api";
import type { AgentChoice } from "@/lib/backlog-presentation";
import { clientApi } from "@/lib/client-api";

export type LinkedIssue = {
  key: string;
  title: string;
  number: number;
  repository: string;
  repositoryId: string;
  url: string;
};

/**
 * The composer is a request box first. Everything else — the reusable action
 * that runs it, the engine, the provider — is optional and explained in place.
 * A request is stored under a provisional title the moment it is sent; the
 * generated title arrives afterwards without holding the user.
 */
export function NewStory({
  projectId,
  agents,
  defaultAgent,
  titleGeneration,
  linked,
  clearHref,
}: {
  projectId: string;
  agents: AgentChoice[];
  defaultAgent: string | null;
  titleGeneration: boolean;
  linked: LinkedIssue | null;
  clearHref: string;
}) {
  const router = useRouter();
  const headingId = useId();
  const [message, setMessage] = useState("");
  const [agent, setAgent] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // One key per request attempt: retrying after a failure reuses it, so the
  // server sees one story even if the button is pressed twice.
  const attemptKey = useRef<string | null>(null);
  const defaultChoice = agents.find((choice) => choice.isDefault) ?? null;
  const canSubmit = message.trim().length > 0 && !pending && (defaultChoice || agent);

  function updateMessage(value: string) {
    if (!attemptKey.current || message.trim().length === 0) {
      attemptKey.current = `ui-start-${crypto.randomUUID()}`;
    }
    setMessage(value);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    const key = attemptKey.current ?? `ui-start-${crypto.randomUUID()}`;
    attemptKey.current = key;
    setPending(true);
    setError("");
    const result = await clientApi<WorkspaceStoryBundle>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories`,
      {
        ...(linked
          ? {
              provider: "github",
              external_id: `issue:${linked.number}`,
              repository_id: linked.repositoryId,
              title: linked.title,
            }
          : { provider: "manual" }),
        ...(agent ? { agent } : {}),
        message,
        idempotency_key: key,
      },
    );
    if (!result.ok) {
      setPending(false);
      setError(result.message);
      return;
    }
    attemptKey.current = null;
    router.push(
      `/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(result.data.story.id)}`,
    );
    router.refresh();
  }

  return (
    <form
      id="new-story"
      onSubmit={submit}
      aria-labelledby={headingId}
      className="scroll-mt-6 flex flex-col gap-4 border border-(--line) bg-(--bg-subtle) p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={headingId} className="text-[15px] font-semibold text-(--ink)">
          {linked ? `Start work on #${linked.number}` : "New story"}
        </h2>
        {linked ? (
          <p className="flex flex-wrap items-center gap-2 text-[12px] text-(--mut)">
            <span className="truncate">
              {linked.repository}#{linked.number} · {linked.title}
            </span>
            <a
              href={linked.url}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) underline-offset-4 hover:underline"
            >
              Issue ↗
            </a>
            <Link href={clearHref} className="text-(--dim) underline-offset-4 hover:underline">
              Not this issue
            </Link>
          </p>
        ) : null}
      </div>
      <label htmlFor={`${headingId}-request`} className="sr-only">
        What do you need?
      </label>
      <div className="flex flex-col gap-2">
        <TextArea
          id={`${headingId}-request`}
          required
          maxLength={200_000}
          value={message}
          onChange={(event) => updateMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            linked
              ? "Describe what should happen with this issue and how it should be verified."
              : "Describe what you need: the outcome, constraints, and how it should be verified. You can also say how you want it approached."
          }
          rows={4}
          aria-describedby={`${headingId}-hint`}
        />
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p id={`${headingId}-hint`} className="max-w-xl text-[11.5px] leading-relaxed text-(--dim)">
          {linked
            ? "The story keeps the issue's title and stays linked to it."
            : titleGeneration
              ? "Facility names the story from your request; your words are kept as the first message."
              : "The first line of your request becomes the title; your words are kept as the first message."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <AgentPicker
            agents={agents}
            defaultAgent={defaultAgent}
            value={agent}
            onChange={setAgent}
          />
          <Button type="submit" variant="primary" tone="agent" disabled={!canSubmit}>
            {pending ? "Starting…" : "Start story"}
          </Button>
        </div>
      </div>
      {!defaultChoice && agents.length === 0 ? (
        <p role="alert" className="text-[12px] text-(--bad)">
          No enabled agent in <code className="font-mono">.agents/</code> accepts requests from the
          web. Enable one on the Agents page before starting a story.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-[12px] text-(--bad)">
          Couldn't start the story: {error}. Your request is still here; try again.
        </p>
      ) : null}
    </form>
  );
}

/**
 * A reusable action is a repository-defined agent (`.agents/<name>.md`). The
 * engine is the coding tool that executes it, and the provider is the model
 * vendor behind that engine. All three are named so nobody has to know the
 * internal identifiers to make a choice.
 */
function AgentPicker({
  agents,
  defaultAgent,
  value,
  onChange,
}: {
  agents: AgentChoice[];
  defaultAgent: string | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = agents.find((choice) => choice.name === value) ?? null;
  const shown = selected ?? agents.find((choice) => choice.isDefault) ?? null;
  const groupId = useId();
  if (agents.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={groupId}
        className="flex h-10 items-center gap-2 border border-(--line) px-3 text-[12.5px] text-(--mut) hover:border-(--line-strong) hover:text-(--ink)"
      >
        <span className="text-(--dim)">Run with</span>
        {shown ? (
          <span className="inline-flex items-center gap-2 text-(--ink)">
            <span className="font-mono">{shown.name}</span>
            <AiIdentity identity={shown.engine} className="text-(--mut)" />
            {selected ? null : <span className="text-(--dim)">(default)</span>}
          </span>
        ) : (
          <span className="text-(--ink)">Choose an action</span>
        )}
        <span aria-hidden className="text-(--dim)">
          {open ? "▴" : "▾"}
        </span>
      </button>
      <fieldset
        id={groupId}
        hidden={!open}
        className="absolute right-0 z-20 mt-1 flex w-[min(92vw,26rem)] flex-col gap-1 border border-(--line) bg-(--bg) p-2 shadow-(--shadow-lift)"
      >
        <legend className="sr-only">Reusable action to run</legend>
        <p className="px-2 py-1 text-[11px] leading-relaxed text-(--dim)">
          Actions are defined by the repository in <code className="font-mono">.agents/</code>. Each
          one runs on a coding engine from a model provider.
        </p>
        {defaultAgent ? (
          <Choice
            checked={value === ""}
            onSelect={() => {
              onChange("");
              setOpen(false);
            }}
            name={`Project default · ${defaultAgent}`}
            description="Let the project decide; this is what runs when you don't pick an action."
            choice={agents.find((choice) => choice.name === defaultAgent) ?? null}
          />
        ) : null}
        {agents.map((choice) => (
          <Choice
            key={choice.name}
            checked={value === choice.name}
            onSelect={() => {
              onChange(choice.name);
              setOpen(false);
            }}
            name={choice.name}
            description={choice.description}
            choice={choice}
          />
        ))}
      </fieldset>
    </div>
  );
}

function Choice({
  checked,
  onSelect,
  name,
  description,
  choice,
}: {
  checked: boolean;
  onSelect: () => void;
  name: string;
  description: string;
  choice: AgentChoice | null;
}) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-3 border px-3 py-2 text-left hover:bg-(--bg-subtle)",
        checked ? "border-(--line-strong)" : "border-transparent",
      )}
    >
      <input
        type="radio"
        name="agent"
        checked={checked}
        onChange={onSelect}
        className="mt-1 accent-(--accent)"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-mono text-[12.5px] text-(--ink)">{name}</span>
        <span className="text-[11.5px] leading-relaxed text-(--mut)">{description}</span>
        {choice ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-(--dim)">
            <span className="inline-flex items-center gap-1">
              <span>Engine</span>
              <AiIdentity identity={choice.engine} className="text-(--mut)" />
            </span>
            <span>
              Provider <span className="text-(--mut)">{choice.provider.label}</span>
            </span>
            <span className="font-mono">{choice.model}</span>
          </span>
        ) : null}
      </span>
    </label>
  );
}
