"use client";

import { Button, Field, Select, TextArea, TextInput } from "@facility/ui";
import { useState } from "react";
import type { StoryAgent } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

type AgentUpdateResult = {
  branch: string;
  commit_sha: string;
  pull_request: { number: number; url: string };
};

const reasoningEfforts = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function AgentEditor({ projectId, agent }: { projectId: string; agent: StoryAgent }) {
  const [description, setDescription] = useState(agent.description);
  const [engine, setEngine] = useState(agent.engine);
  const [model, setModel] = useState(agent.model);
  const [reasoningEffort, setReasoningEffort] = useState(agent.options.reasoning_effort ?? "");
  const [enabled, setEnabled] = useState(agent.enabled);
  const [triggers, setTriggers] = useState(JSON.stringify(agent.triggers, null, 2));
  const [prompt, setPrompt] = useState(agent.prompt);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<AgentUpdateResult | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setProposal(null);
    let parsedTriggers: unknown;
    try {
      parsedTriggers = JSON.parse(triggers);
      if (!Array.isArray(parsedTriggers)) throw new Error("Triggers must be a JSON array.");
    } catch (cause) {
      setPending(false);
      setError(cause instanceof Error ? cause.message : "Triggers must be valid JSON.");
      return;
    }
    const result = await clientApi<AgentUpdateResult>(
      "PATCH",
      `/v1/projects/${encodeURIComponent(projectId)}/story-agents/${encodeURIComponent(agent.name)}`,
      {
        expected_commit_sha: agent.commit_sha,
        description,
        engine,
        model,
        reasoning_effort: reasoningEffort || null,
        enabled,
        triggers: parsedTriggers,
        prompt,
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setProposal(result.data);
  }

  return (
    <details className="border-t border-(--line) pt-4">
      <summary className="cursor-pointer text-[12px] font-medium text-(--info)">
        Edit through Git
      </summary>
      <form onSubmit={submit} className="mt-5 grid gap-4">
        <Field label="Description">
          <TextInput
            required
            maxLength={240}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Engine">
            <Select
              value={engine}
              onChange={(event) => setEngine(event.target.value as StoryAgent["engine"])}
            >
              <option value="claude_code">Claude Code</option>
              <option value="codex">Codex</option>
            </Select>
          </Field>
          <Field label="Model">
            <TextInput
              required
              maxLength={160}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          </Field>
        </div>
        <Field
          label="Reasoning effort"
          hint="The only engine-specific execution option in Facility 0.12."
        >
          <Select
            value={reasoningEffort}
            onChange={(event) => setReasoningEffort(event.target.value)}
          >
            {reasoningEfforts.map((effort) => (
              <option key={effort || "default"} value={effort}>
                {effort || "engine default"}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Triggers (JSON)"
          hint="Manual, MCP, UI, GitHub, and schedule triggers use the shared manifest validator."
        >
          <TextArea
            required
            rows={9}
            className="font-mono text-[12px]"
            value={triggers}
            onChange={(event) => setTriggers(event.target.value)}
          />
        </Field>
        <Field label="Agent prompt">
          <TextArea
            required
            rows={14}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-[12px] text-(--ink)">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enabled
        </label>
        {error ? (
          <p role="alert" className="text-[12px] text-(--bad)">
            {error}
          </p>
        ) : null}
        {proposal ? (
          <p role="status" className="text-[12px] leading-relaxed text-(--ok)">
            Saved to <code>{proposal.branch}</code>. Review{" "}
            <a
              className="text-(--info) underline"
              href={proposal.pull_request.url}
              target="_blank"
              rel="noreferrer"
            >
              PR #{proposal.pull_request.number}
            </a>{" "}
            before merging.
          </p>
        ) : null}
        <Button
          type="submit"
          size="sm"
          variant="primary"
          tone="agent"
          className="w-fit"
          disabled={pending}
        >
          {pending ? "validating and committing…" : "validate and open pull request"}
        </Button>
      </form>
    </details>
  );
}
