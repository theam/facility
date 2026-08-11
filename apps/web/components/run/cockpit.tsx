"use client";

import { isBuilderMode, runObjectiveText } from "@facility/run-objective";
import { Button, Cell, cx, Eyebrow, HairlineGrid, Metric, StatusDot, toneFor } from "@facility/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiIdentity } from "@/components/ai-identity";
import { RunTranscript } from "@/components/run/transcript";
import { engineIdentity } from "@/lib/ai-identity";
import type { Project, Run, RunEvent } from "@/lib/api";
import { fetchRunEventPages } from "@/lib/run-event-pages";
import { fmtCost, fmtDuration, fmtStatus } from "@/lib/run-format";

const LIVE = new Set(["queued", "provisioning", "running", "awaiting_human"]);
const RETRYABLE = new Set(["failed", "canceled"]);

const PHASES = [
  { key: "queued", label: "queued" },
  { key: "provisioning", label: "provisioning" },
  { key: "running", label: "running" },
  { key: "checks", label: "checks" },
  { key: "result", label: "result" },
] as const;

type PhaseKey = (typeof PHASES)[number]["key"];
type PhaseStatus = "pending" | "active" | "ok" | "bad" | "canceled" | "waiting";
type ActionState = { tone: "ok" | "bad" | "info"; message: string } | null;

function hasPermission(permissions: string[], permission: string) {
  const [resource] = permission.split(":");
  return permissions.some((p) => p === "*" || p === permission || p === `${resource}:*`);
}

function textFromData(data: Record<string, unknown>) {
  const value =
    typeof data.text === "string"
      ? data.text
      : typeof data.message === "string"
        ? data.message
        : typeof data.phase === "string"
          ? data.phase
          : typeof data.command === "string"
            ? data.command
            : typeof data.name === "string"
              ? data.name
              : null;
  if (value) return value;
  // Known machine payloads become sentences; unknown ones become terse
  // key–value pairs. Raw JSON never reaches the chrome.
  if (typeof data.queue === "string") {
    return data.queue === "runs.dispatch" ? "waiting in the dispatch queue" : `queue ${data.queue}`;
  }
  const pairs = Object.entries(data)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .slice(0, 3)
    .map(([k, v]) => `${k} ${String(v)}`);
  return pairs.length > 0 ? pairs.join(" · ") : null;
}

function eventLabel(event: RunEvent) {
  const text = textFromData(event.data);
  if (!text) return event.type;
  if (event.type === "tool") return `tool: ${text}`;
  if (event.type === "shell") return `shell: ${text}`;
  if (event.type === "check") return `check: ${text}`;
  if (event.type === "status") return text;
  if (event.type === "steer") return `human steer: ${text}`;
  if (event.type === "queued") return text;
  return `${event.type}: ${text}`;
}

export function phaseForEvent(event: RunEvent): PhaseKey {
  const haystack = `${event.type} ${textFromData(event.data)}`.toLowerCase();
  if (event.type === "phase") {
    const name = typeof event.data.name === "string" ? event.data.name : "";
    if (name === "acceptance") return "checks";
    if (
      ["bootstrap", "workspace", "runner_runtime", "package_install", "provision"].includes(name)
    ) {
      return "provisioning";
    }
    return "running";
  }
  if (event.type === "queued" || haystack.includes("queue")) return "queued";
  if (
    event.type === "provisioning" ||
    haystack.includes("provision") ||
    haystack.includes("sandbox")
  ) {
    return "provisioning";
  }
  if (event.type === "check" || haystack.includes("test") || haystack.includes("lint")) {
    return "checks";
  }
  if (
    event.type === "result" ||
    event.type === "error" ||
    haystack.includes("succeeded") ||
    haystack.includes("failed") ||
    haystack.includes("canceled")
  ) {
    return "result";
  }
  return "running";
}

function resultIsOk(event: RunEvent) {
  const result = event.data.result;
  const status = event.data.status;
  return (
    result === "success" ||
    result === "passed" ||
    result === "ok" ||
    status === "success" ||
    status === "passed" ||
    status === "succeeded"
  );
}

function resultIsBad(event: RunEvent) {
  const result = event.data.result;
  const status = event.data.status;
  return (
    event.type === "error" ||
    result === "failure" ||
    result === "failed" ||
    result === "error" ||
    status === "failure" ||
    status === "failed" ||
    status === "error"
  );
}

export function derivePhases(
  events: RunEvent[],
  run: Pick<Run, "queuedAt" | "startedAt" | "status">,
) {
  const byPhase = new Map<PhaseKey, RunEvent[]>();
  for (const event of events) {
    const phase = phaseForEvent(event);
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), event]);
  }

  if (run.queuedAt && !byPhase.has("queued")) byPhase.set("queued", []);
  if (run.startedAt && !byPhase.has("running")) byPhase.set("running", []);
  if (!LIVE.has(run.status) && !byPhase.has("result")) byPhase.set("result", []);

  const activePhase =
    run.status === "queued"
      ? "queued"
      : run.status === "provisioning"
        ? "provisioning"
        : run.status === "running" || run.status === "awaiting_human"
          ? "running"
          : "result";

  return PHASES.map((phase) => {
    const phaseEvents = byPhase.get(phase.key) ?? [];
    let status: PhaseStatus = phaseEvents.length ? "ok" : "pending";
    if (phase.key === activePhase && LIVE.has(run.status)) status = "active";
    if (phase.key === "running" && run.status === "awaiting_human") status = "waiting";
    if (phase.key === "checks" && phaseEvents.some(resultIsBad)) status = "bad";
    if (phase.key === "result" && run.status === "failed") status = "bad";
    if (phase.key === "result" && run.status === "canceled") status = "canceled";
    if (phase.key === "result" && run.status === "succeeded") status = "ok";
    return {
      ...phase,
      status,
      count: phaseEvents.length,
      latest: phaseEvents.at(-1),
    };
  });
}

const PHASE_STATUS_WORDS: Record<PhaseStatus, string> = {
  active: "now",
  waiting: "on you",
  ok: "done",
  bad: "failed",
  canceled: "canceled",
  pending: "",
};

function toneForPhase(status: PhaseStatus) {
  if (status === "active") return "agent";
  if (status === "waiting") return "human";
  if (status === "bad") return "bad";
  if (status === "ok") return "ok";
  return "machine";
}

function chipClass(tone: "ok" | "bad" | "machine" | "human") {
  return cx(
    "inline-flex items-center border px-2 py-1 text-[11px] font-medium",
    tone === "ok" && "border-(--ok) text-(--ok)",
    tone === "bad" && "border-(--bad) text-(--bad)",
    tone === "human" && "border-(--human) text-(--human)",
    tone === "machine" && "border-(--line) text-(--mut)",
  );
}

function getTriggerString(trigger: Record<string, unknown> | undefined, keys: string[]) {
  for (const key of keys) {
    const value = trigger?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function agentName(run: Run) {
  return (
    getTriggerString(run.trigger, ["agentName", "agent", "command", "handle"]) ??
    run.agentDefId ??
    "agent"
  );
}

function formatStarted(run: Run) {
  const iso = run.startedAt ?? run.queuedAt;
  if (!iso) return "-";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortTokens(value?: number) {
  if (value == null) return "-";
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
}

function linkFromValue(value: unknown) {
  if (typeof value !== "string") return null;
  return /^https?:\/\//.test(value) ? value : null;
}

// A gh artifact can be a bare string/number, or the {number,url} object the
// platform PR hook actually writes onto runs.gh.pr — resolve either shape.
function artifactFrom(value: unknown): { text: string; href: string | null } | null {
  if (typeof value === "string" || typeof value === "number") {
    return { text: String(value), href: linkFromValue(value) };
  }
  if (value && typeof value === "object") {
    const obj = value as { number?: unknown; url?: unknown };
    const href = linkFromValue(obj.url);
    const text = typeof obj.number === "number" ? `#${obj.number}` : href ? "open" : null;
    if (text || href) return { text: text ?? "open", href };
  }
  return null;
}

function githubArtifacts(run: Run) {
  const gh = (run.gh ?? {}) as Record<string, unknown>;
  const pr = artifactFrom(gh.pr) ?? artifactFrom(gh.prUrl) ?? artifactFrom(gh.url);
  const issueNumber = typeof gh.issueNumber === "number" ? gh.issueNumber : undefined;
  // Backlink to the issue this run works on — derive the GitHub URL from the
  // run's own repo context when the payload doesn't carry one.
  const issueUrl =
    typeof gh.owner === "string" && typeof gh.repo === "string" && issueNumber !== undefined
      ? `https://github.com/${gh.owner}/${gh.repo}/issues/${issueNumber}`
      : null;
  const issue =
    artifactFrom(gh.issue) ??
    artifactFrom(gh.issueUrl) ??
    artifactFrom(gh.htmlUrl) ??
    (issueNumber !== undefined ? { text: `#${issueNumber}`, href: issueUrl } : null);
  return [
    pr ? { label: "PR", text: pr.text, href: pr.href } : null,
    issue ? { label: "issue", text: issue.text, href: issue.href } : null,
  ].filter((item): item is { label: string; text: string; href: string | null } => Boolean(item));
}

function checkItems(events: RunEvent[]) {
  return events
    .filter((event) => event.type === "check")
    .map((event) => ({
      key: `${event.seq}-${event.ts}`,
      label: textFromData(event.data),
      tone: (resultIsOk(event) ? "ok" : resultIsBad(event) ? "bad" : "machine") as
        | "ok"
        | "bad"
        | "machine",
      // Platform-owned gate vs the agent's own self-report — the runner sets
      // self_reported:false on gates it ran itself.
      platform: event.data.self_reported === false,
      exitCode: typeof event.data.exit_code === "number" ? event.data.exit_code : null,
      output: typeof event.data.output === "string" ? event.data.output : null,
    }));
}

function mergeEvents(prev: RunEvent[], next: RunEvent[]) {
  const seen = new Set(prev.map((event) => event.seq));
  const merged = [...prev];
  for (const event of next) {
    if (!seen.has(event.seq)) {
      seen.add(event.seq);
      merged.push(event);
    }
  }
  return merged.sort((a, b) => a.seq - b.seq);
}

export function RunCockpit({
  run,
  project,
  agentDisplayName,
  permissions,
  initialEvents,
  initialEventsError = false,
}: {
  run: Run;
  project: Pick<Project, "id" | "name" | "slug"> | null;
  agentDisplayName?: string;
  permissions: string[];
  initialEvents: RunEvent[];
  initialEventsError?: boolean;
}) {
  const [events, setEvents] = useState(initialEvents);
  const [action, setAction] = useState<ActionState>(null);
  const [busy, setBusy] = useState<"cancel" | "retry" | "interrupt" | "resume" | null>(null);
  const lastSeq = useRef(initialEvents.at(-1)?.seq ?? 0);
  const pulling = useRef(false);
  // Session identity lands on runs written after the resume infrastructure —
  // older rows simply don't offer resume.
  const engineSessionId = (run as { engineSessionId?: string | null }).engineSessionId ?? null;
  const transcriptUri = (run as { transcriptUri?: string | null }).transcriptUri ?? null;
  const resumable =
    !LIVE.has(run.status) && run.engine === "claude_code" && Boolean(engineSessionId);

  const live = LIVE.has(run.status);
  const canSteer = hasPermission(permissions, "runs:steer");
  const canWrite = hasPermission(permissions, "runs:write");
  const canTrigger = hasPermission(permissions, "runs:trigger");
  const usage = run.receipt?.usage;
  const phases = useMemo(() => derivePhases(events, run), [events, run]);
  const latestMeaningful = useMemo(
    () =>
      [...events]
        .reverse()
        .find((event) => !["heartbeat", "queued"].includes(event.type.toLowerCase())),
    [events],
  );
  const checks = useMemo(() => checkItems(events), [events]);
  const artifacts = useMemo(() => githubArtifacts(run), [run]);

  const pull = useCallback(async () => {
    if (pulling.current) return;
    pulling.current = true;
    try {
      const body = await fetchRunEventPages(run.id, lastSeq.current);
      if (body.length) {
        lastSeq.current = Math.max(lastSeq.current, body.at(-1)?.seq ?? lastSeq.current);
        setEvents((prev) => mergeEvents(prev, body));
      }
    } finally {
      pulling.current = false;
    }
  }, [run.id]);

  useEffect(() => {
    void pull();
    if (!live) return;

    const source = new EventSource(`/api/v1/runs/${run.id}/stream?afterSeq=${lastSeq.current}`);
    source.addEventListener("run_event", (msg) => {
      try {
        const event = JSON.parse(msg.data) as RunEvent;
        if (event.seq > lastSeq.current) {
          lastSeq.current = event.seq;
          setEvents((prev) => mergeEvents(prev, [event]));
        }
      } catch {
        // Ignore malformed frames; heartbeat frames have their own event type.
      }
    });
    source.onerror = () => {
      void pull();
    };
    const poll = setInterval(() => {
      if (source.readyState === EventSource.CLOSED) void pull();
    }, 3000);
    return () => {
      source.close();
      clearInterval(poll);
    };
  }, [live, pull, run.id]);

  async function cancelRun() {
    if (
      !window.confirm("Cancel this run? The agent will be stopped and the run marked canceled.")
    ) {
      return;
    }
    setBusy("cancel");
    setAction(null);
    try {
      const res = await fetch(`/api/v1/runs/${run.id}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error(`cancel failed (${res.status})`);
      setAction({ tone: "ok", message: "cancel requested" });
      window.location.reload();
    } catch (err) {
      setAction({ tone: "bad", message: err instanceof Error ? err.message : "cancel failed" });
    } finally {
      setBusy(null);
    }
  }

  async function interruptRun() {
    if (
      !window.confirm(
        "Interrupt this session? The engine stops gracefully, uploads its state, and stays resumable.",
      )
    ) {
      return;
    }
    setBusy("interrupt");
    setAction(null);
    try {
      const res = await fetch(`/api/v1/runs/${run.id}/interrupt`, { method: "POST" });
      if (!res.ok) throw new Error(`interrupt failed (${res.status})`);
      setAction({ tone: "ok", message: "interrupt requested — the session will stop shortly" });
    } catch (err) {
      setAction({ tone: "bad", message: err instanceof Error ? err.message : "interrupt failed" });
    } finally {
      setBusy(null);
    }
  }

  async function resumeRun() {
    const message = window.prompt(
      "Resume this session — what should the agent do next? (empty = continue where it left off)",
    );
    if (message === null) return;
    setBusy("resume");
    setAction(null);
    try {
      const res = await fetch(`/api/v1/runs/${run.id}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message.trim() ? { message: message.trim() } : {}),
      });
      const next = (await res.json().catch(() => null)) as {
        id?: string;
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(next?.error?.message ?? `resume failed (${res.status})`);
      if (next?.id) window.location.assign(`/projects/${run.projectId}/sessions/${next.id}`);
    } catch (err) {
      setAction({ tone: "bad", message: err instanceof Error ? err.message : "resume failed" });
    } finally {
      setBusy(null);
    }
  }

  async function retryRun() {
    if (!window.confirm("Retry this run with the same project and agent?")) return;
    const trigger: Record<string, unknown> = {
      ...(run.trigger ?? {}),
      source: "web",
      retryOf: run.id,
    };
    if (isBuilderMode(run.mode) && !runObjectiveText(trigger)) {
      const objective = window.prompt("Retry this builder — what should it do?");
      if (objective === null) return;
      const message = objective.trim();
      if (!message) {
        setAction({ tone: "bad", message: "an objective is required to retry this builder" });
        return;
      }
      trigger.message = message;
    }
    setBusy("retry");
    setAction(null);
    try {
      const body: Record<string, unknown> = {
        mode: run.mode,
        engine: run.engine,
        trigger,
      };
      if (run.agentDefId) body.agentDefId = run.agentDefId;
      else {
        const agent = getTriggerString(run.trigger, ["agentName", "agent", "command", "handle"]);
        if (agent) body.agent = agent;
      }
      const res = await fetch(`/api/v1/projects/${run.projectId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`retry failed (${res.status})`);
      const next = (await res.json()) as { id?: string };
      if (next.id) window.location.assign(`/projects/${run.projectId}/sessions/${next.id}`);
      else setAction({ tone: "ok", message: "retry queued" });
    } catch (err) {
      setAction({ tone: "bad", message: err instanceof Error ? err.message : "retry failed" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="border border-(--line) bg-(--bg)">
        <div className="flex flex-col gap-5 border-b border-(--line) p-4 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 flex-1">
              <Eyebrow>session · {run.id}</Eyebrow>
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <h1 className="min-w-0 break-words font-mono text-[clamp(20px,3vw,32px)] font-semibold tracking-tight">
                  {run.mode}
                </h1>
                <span className="inline-flex items-center gap-2 text-[12.5px] text-(--mut)">
                  <StatusDot tone={toneFor(run.status)} pulse={run.status === "running"} />
                  {fmtStatus(run.status)}
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-(--dim)">
                <AiIdentity identity={engineIdentity(run.engine)} />
                <span>{agentDisplayName ?? agentName(run)}</span>
                <span>{project?.slug ?? run.projectId}</span>
              </div>
            </div>

            <div className="flex w-full flex-col gap-2 sm:w-auto sm:min-w-[260px]">
              <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
                {live && canSteer ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={busy !== null}
                    onClick={interruptRun}
                    title="Stop gracefully; the session stays resumable"
                  >
                    {busy === "interrupt" ? "interrupting" : "interrupt"}
                  </Button>
                ) : null}
                {live && canWrite ? (
                  <Button
                    variant="danger"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={busy !== null}
                    onClick={cancelRun}
                  >
                    {busy === "cancel" ? "canceling" : "cancel"}
                  </Button>
                ) : null}
                {resumable && canTrigger ? (
                  <Button
                    variant="primary"
                    tone="agent"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={busy !== null}
                    onClick={resumeRun}
                  >
                    {busy === "resume" ? "resuming" : "resume session"}
                  </Button>
                ) : null}
                {RETRYABLE.has(run.status) && canTrigger ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={busy !== null}
                    onClick={retryRun}
                  >
                    {busy === "retry" ? "retrying" : "retry"}
                  </Button>
                ) : null}
              </div>
              {action ? (
                <span
                  className={cx(
                    "font-mono text-[11px]",
                    action.tone === "ok" && "text-(--ok)",
                    action.tone === "bad" && "text-(--bad)",
                    action.tone === "info" && "text-(--info)",
                  )}
                >
                  {action.message}
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex items-start gap-3 border border-(--line) bg-(--bg-subtle) px-4 py-3">
            <StatusDot
              tone={
                run.status === "awaiting_human"
                  ? "human"
                  : run.status === "queued"
                    ? "info"
                    : live
                      ? "agent"
                      : toneFor(run.status)
              }
              pulse={run.status === "running"}
              className="mt-1"
            />
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-(--dim)">current activity</p>
              <p className="mt-1 break-words text-sm text-(--ink)">
                {latestMeaningful
                  ? eventLabel(latestMeaningful)
                  : live
                    ? "waiting for events"
                    : "run is terminal"}
              </p>
            </div>
          </div>

          {run.error ? <p className="text-sm text-(--bad)">{run.error}</p> : null}
        </div>

        <HairlineGrid cols="grid-cols-2 lg:grid-cols-5" className="border-0 border-b">
          <Cell className="p-4 sm:p-5">
            <Metric
              label={run.startedAt ? "started" : "queued"}
              value={formatStarted(run)}
              hint={run.startedAt ? undefined : "waiting for a worker to pick it up"}
            />
          </Cell>
          <Cell className="p-4 sm:p-5">
            <Metric
              label="duration"
              value={fmtDuration(run.startedAt, run.endedAt)}
              hint={run.startedAt ? undefined : "starts when the sandbox does"}
            />
          </Cell>
          <Cell className="p-4 sm:p-5">
            <Metric
              label="cost"
              value={fmtCost(usage?.cost_cents)}
              hint={usage ? undefined : live ? "metered as it works" : "no receipt"}
            />
          </Cell>
          <Cell className="p-4 sm:p-5">
            <Metric
              label="tokens"
              value={`${shortTokens(usage?.input_tokens)} / ${shortTokens(usage?.output_tokens)}`}
              hint="input / output"
            />
          </Cell>
          <Cell className="col-span-2 p-4 sm:p-5 lg:col-span-1">
            <Metric label="project" value={project?.name ?? run.projectId} />
          </Cell>
        </HairlineGrid>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <div className="border border-(--line)">
            <div className="border-b border-(--line) px-5 py-3">
              <Eyebrow>phases</Eyebrow>
            </div>
            <div className="divide-y divide-(--line)">
              {phases.map((phase) => (
                <div key={phase.key} className="flex gap-4 px-5 py-4">
                  <StatusDot
                    tone={toneForPhase(phase.status)}
                    pulse={phase.status === "active"}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] font-medium text-(--ink)">{phase.label}</span>
                      <span className="text-[11px] text-(--dim)">
                        {PHASE_STATUS_WORDS[phase.status]}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-(--mut)">
                      {phase.latest
                        ? eventLabel(phase.latest)
                        : phase.count > 0
                          ? `${phase.count} events`
                          : "nothing yet"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="border border-(--line)">
            <div className="border-b border-(--line) px-5 py-3">
              <Eyebrow>checks + artifacts</Eyebrow>
            </div>
            <div className="flex flex-col gap-4 px-5 py-4">
              {checks.length || artifacts.length ? (
                <>
                  {checks.length ? (
                    <div className="flex flex-col gap-2">
                      {checks.map((check) => (
                        <div key={check.key} className="flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              title={
                                check.platform
                                  ? "platform-owned acceptance gate"
                                  : "agent self-reported"
                              }
                              className="text-[10px] font-medium text-(--dim)"
                            >
                              {check.platform ? "gate" : "self"}
                            </span>
                            <span className={chipClass(check.tone)}>{check.label}</span>
                            {check.exitCode !== null && check.exitCode !== 0 ? (
                              <span className="font-mono text-[10px] text-(--bad)">
                                exit {check.exitCode}
                              </span>
                            ) : null}
                          </div>
                          {check.output ? (
                            <details>
                              <summary className="cursor-pointer font-mono text-[10.5px] text-(--mut) hover:text-(--ink)">
                                output
                              </summary>
                              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border border-(--line) bg-(--bg-subtle) p-2 font-mono text-[11px] text-(--dim)">
                                {check.output}
                              </pre>
                            </details>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {transcriptUri ? (
                    <a
                      href={`/api/v1/runs/${run.id}/transcript`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[12px] text-(--info) underline-offset-4 hover:underline"
                    >
                      raw transcript ↗
                    </a>
                  ) : null}
                  {artifacts.length ? (
                    <div className="flex flex-col gap-2">
                      {artifacts.map((artifact) =>
                        artifact.href ? (
                          <a
                            key={artifact.label}
                            href={artifact.href}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-[12px] text-(--info) underline-offset-4 hover:underline"
                          >
                            {artifact.label}: {artifact.text}
                          </a>
                        ) : (
                          <span key={artifact.label} className="font-mono text-[12px] text-(--mut)">
                            {artifact.label}: {artifact.text}
                          </span>
                        ),
                      )}
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-(--dim)">No checks or GitHub artifacts recorded.</p>
              )}
            </div>
          </div>
        </div>

        {initialEventsError && events.length === 0 ? (
          <p className="border border-(--bad) px-4 py-2 font-mono text-[11px] text-(--bad)">
            couldn't load this run's recorded events — this is a load failure, not an empty run.
            {live ? " retrying live…" : " reload to try again."}
          </p>
        ) : null}
        <RunTranscript runId={run.id} events={events} live={live} canSteer={canSteer} />
      </section>
    </div>
  );
}
