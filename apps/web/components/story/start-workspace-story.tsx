"use client";

import { Button, Field, Select, TextArea, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StoryAgent, WorkspaceStoryBundle } from "@/lib/api";
import { clientApi } from "@/lib/client-api";

export function StartWorkspaceStory({
  projectId,
  agents,
}: {
  projectId: string;
  agents: StoryAgent[];
}) {
  const router = useRouter();
  const enabled = agents.filter((candidate) => candidate.enabled);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [agent, setAgent] = useState(
    enabled.find((candidate) => candidate.name === "builder")?.name ?? enabled[0]?.name ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!agent) return;
    setPending(true);
    setError("");
    const key = `ui-start-${crypto.randomUUID()}`;
    const result = await clientApi<WorkspaceStoryBundle>(
      "POST",
      `/v1/projects/${encodeURIComponent(projectId)}/workspace-stories`,
      {
        provider: "manual",
        title,
        agent,
        message,
        idempotency_key: key,
      },
    );
    setPending(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    router.push(
      `/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(result.data.story.id)}`,
    );
    router.refresh();
  }

  return (
    <form
      onSubmit={submit}
      className="grid gap-4 border border-(--line) bg-(--bg-subtle) p-5 sm:p-6"
    >
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_220px]">
        <Field label="Story title">
          <TextInput
            required
            maxLength={500}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What should change?"
          />
        </Field>
        <Field label="Agent" hint="Engine and model come from .agents/.">
          <Select required value={agent} onChange={(event) => setAgent(event.target.value)}>
            {enabled.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} · {candidate.engine === "claude_code" ? "Claude" : "Codex"}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="First message" error={error || undefined}>
        <TextArea
          required
          maxLength={200_000}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Describe the outcome, constraints, and how it should be verified."
          rows={4}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-[11.5px] leading-relaxed text-(--dim)">
          Facility creates one durable workspace and keeps its worktree and native agent sessions
          until you explicitly delete it.
        </p>
        <Button type="submit" variant="primary" tone="agent" disabled={pending || !agent}>
          {pending ? "starting…" : "start story"}
        </Button>
      </div>
    </form>
  );
}
