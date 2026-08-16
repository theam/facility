"use client";

import type { ProjectRepo } from "@facility/sdk";
import { Button, PillTag } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Lane = "repo" | "platform";

const LANE_AGENTS = [
  "architect",
  "builder",
  "codex-architect",
  "codex-builder",
  "review",
  "address-review",
  "ci-doctor",
  "security-sweep",
] as const;

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function ObserveFirstEditor({
  projectId,
  settings,
  repos,
}: {
  projectId: string;
  settings: Record<string, unknown>;
  repos: ProjectRepo[];
}) {
  const router = useRouter();
  const repoAnswers = objectOrEmpty(repos[0]?.renderAnswers);
  const configured = objectOrEmpty(settings.execution_lane_override);
  const fallback = objectOrEmpty(
    repoAnswers.execution_lane_override ?? repoAnswers.execution_lane,
  );
  const initialLane = (name: string): Lane =>
    (configured[name] ?? fallback[name]) === "platform" ? "platform" : "repo";
  const [mode, setMode] = useState<"observe" | "active">(
    settings.autonomy_mode === "observe" ? "observe" : "active",
  );
  const [summary, setSummary] = useState(settings.observe_summary === true);
  const [lanes, setLanes] = useState<Record<string, Lane>>(() =>
    Object.fromEntries(LANE_AGENTS.map((name) => [name, initialLane(name)])),
  );
  const [prefix, setPrefix] = useState(
    typeof settings.command_prefix === "string"
      ? settings.command_prefix
      : typeof repoAnswers.command_prefix === "string"
        ? repoAnswers.command_prefix
        : "",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    const response = await fetch(\`/api/v1/projects/\${projectId}\`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        settings: {
          ...settings,
          autonomy_mode: mode,
          observe_summary: summary,
          execution_lane_override: lanes,
          command_prefix: prefix.trim() || null,
        },
      }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setMessage(body?.error?.message ?? \`could not save project policy (\${response.status})\`);
      return;
    }
    setMessage("project policy saved");
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5 border border-(--line) p-5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setMode("observe")}>
          <PillTag active={mode === "observe"}>observe first</PillTag>
        </button>
        <button type="button" onClick={() => setMode("active")}>
          <PillTag active={mode === "active"}>active</PillTag>
        </button>
      </div>
      <p className="text-sm leading-relaxed text-(--mut)">
        {mode === "observe"
          ? "Manual runs stay inside Facility and scheduled agents do not fire. GitHub remains unchanged unless a summary is explicitly enabled."
          : "Scheduled agents may run and control-plane sessions publish their normal GitHub feedback."}
      </p>
      {mode === "observe" ? (
        <label className="flex items-center gap-2 text-sm text-(--mut)">
          <input
            type="checkbox"
            checked={summary}
            onChange={(event) => setSummary(event.target.checked)}
          />
          publish one terminal summary for a completed architect run
        </label>
      ) : null}

      <div className="grid gap-4 border-t border-(--line) pt-5 sm:grid-cols-3">
        {LANE_AGENTS.map((name) => (
          <LaneSelect
            key={name}
            label={name}
            value={lanes[name] ?? "repo"}
            onChange={(value) => setLanes((current) => ({ ...current, [name]: value }))}
          />
        ))}
        <label className="flex flex-col gap-1 text-[11px] font-medium text-(--dim)">
          command prefix
          <input
            className="border border-(--line) bg-transparent px-3 py-2 font-mono text-[12px] text-(--ink)"
            value={prefix}
            maxLength={32}
            placeholder="none — or fx"
            pattern="[a-z0-9][a-z0-9_-]*"
            onChange={(event) => setPrefix(event.target.value.toLowerCase())}
          />
        </label>
      </div>
      <p className="text-[11px] leading-relaxed text-(--dim)">
        These operator settings apply to {repos.length || "no"} connected{" "}
        {repos.length === 1 ? "repository" : "repositories"} without modifying their manifests.
        {prefix ? \` Facility listens to /\${prefix} architect and /\${prefix} builder.\` : ""}
      </p>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? "saving…" : "save autonomy policy"}
        </Button>
        {message ? <span className="font-mono text-[11px] text-(--dim)">{message}</span> : null}
      </div>
    </div>
  );
}

function LaneSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Lane;
  onChange: (value: Lane) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] font-medium text-(--dim)">
      {label} lane
      <select
        className="border border-(--line) bg-(--bg) px-3 py-2 text-[12px] text-(--ink)"
        value={value}
        onChange={(event) => onChange(event.target.value as Lane)}
      >
        <option value="repo">repository</option>
        <option value="platform">Facility</option>
      </select>
    </label>
  );
}
