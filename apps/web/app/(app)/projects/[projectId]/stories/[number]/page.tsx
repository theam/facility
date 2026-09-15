import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { AttentionActions } from "@/components/story/attention-actions";
import { EnvironmentLogs } from "@/components/story/environment-logs";
import { StoryActions } from "@/components/story/story-actions";
import { StoryConversation } from "@/components/story/story-conversation";
import { StoryTimeline } from "@/components/story/story-timeline";
import { WorkspaceVariables } from "@/components/story/workspace-variables";
import { api, type StoryEnvironment } from "@/lib/api";
import { titleStatus } from "@/lib/backlog-presentation";
import { can } from "@/lib/permissions";
import {
  computeLabel,
  errorSummary,
  formatTime,
  phaseLabel,
  safeExternalUrl,
  storyActivity,
} from "@/lib/story-presentation";

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return { title: `story ${number}` };
}

/**
 * One story: what it is doing and what to do about it at the top, the
 * conversation as requests and the responses they produced, and the
 * environment below. Activity, logs and evidence stay folded and are fetched
 * only when opened; opening the page starts nothing and wakes nothing.
 */
export default async function StoryPage({
  params,
}: {
  params: Promise<{ projectId: string; number: string }>;
}) {
  const { projectId, number: storyId } = await params;
  const [detail, conversation, environment, agents, me] = await Promise.all([
    api.workspaceStory(projectId, storyId),
    api.workspaceStoryConversation(projectId, storyId),
    api.workspaceStoryEnvironment(projectId, storyId),
    api.storyAgents(projectId),
    api.me(),
  ]);

  if (!detail.ok) {
    if (detail.offline) return <Offline />;
    if (detail.status === 404) notFound();
    return <ErrorNotice message={`Couldn't load this story — ${detail.message}`} />;
  }

  const bundle = detail.data;
  const story = bundle.story;
  const activity = storyActivity(bundle);
  const openAttention = bundle.attention.filter((item) => item.status === "open");
  const resolvedAttention = bundle.attention.filter((item) => item.status !== "open");
  const currentEnvironment = environment.ok ? environment.data : null;
  const agentRows = agents.ok ? agents.data.agents : [];
  const permissions = me.ok ? me.data.permissions : [];
  const canExecute = can(permissions, "workspaces:execute");
  const canWrite = can(permissions, "projects:write");
  const activeTurn =
    bundle.turns.find((turn) => turn.state === "running") ??
    bundle.turns.find((turn) => turn.state === "queued") ??
    null;
  const waiting = openAttention.filter((item) => item.kind === "agent_waiting");
  const waitingTurnIds = waiting.map((item) => item.turnId).filter((id): id is string => !!id);
  const waitingAgent =
    waiting
      .map((item) => bundle.turns.find((turn) => turn.id === item.turnId)?.agentName ?? null)
      .find((name) => name !== null) ?? null;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <LiveRefresh seconds={8} />
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow>
            {story.provider === "manual"
              ? "Started in Facility"
              : story.provider === "schedule"
                ? `Scheduled · ${story.externalId}`
                : `GitHub · ${story.externalId.replace(":", " #")}`}
          </Eyebrow>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/stories`}
            className="text-[11.5px] text-(--dim) hover:text-(--ink)"
          >
            ← all stories
          </Link>
        </div>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">{story.title}</h1>
        <dl className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12px] text-(--mut)">
          <div className="inline-flex items-center gap-2">
            <dt className="sr-only">Agent activity</dt>
            <StatusDot tone={activity.active ? "agent" : "machine"} pulse={activity.active} />
            <dd className="text-(--ink)">{activity.label}</dd>
          </div>
          <div className="inline-flex gap-1.5">
            <dt>Task phase:</dt>
            <dd className="text-(--ink)">{phaseLabel(story.status)}</dd>
          </div>
          <div className="inline-flex gap-1.5">
            <dt>Environment:</dt>
            <dd className="text-(--ink)">{computeLabel(currentEnvironment)}</dd>
          </div>
          {story.branch ? (
            <div className="inline-flex gap-1.5">
              <dt className="sr-only">Branch</dt>
              <dd className="font-mono text-(--mut)">{story.branch}</dd>
            </div>
          ) : null}
          {bundle.assignees.length > 0 ? (
            <div className="inline-flex gap-1.5">
              <dt>Working on it:</dt>
              <dd className="text-(--ink)">
                {bundle.assignees
                  .map(
                    (person) => person.name ?? (person.login ? `@${person.login}` : person.subject),
                  )
                  .join(", ")}
              </dd>
            </div>
          ) : null}
          {titleStatus({ titleSource: story.titleSource, createdAt: story.createdAt }) ? (
            <div className="inline-flex gap-1.5 text-(--dim)">
              <dt className="sr-only">Title</dt>
              <dd>{titleStatus({ titleSource: story.titleSource, createdAt: story.createdAt })}</dd>
            </div>
          ) : null}
        </dl>
        <StoryActions
          projectId={projectId}
          story={story}
          workspace={bundle.workspace}
          agents={agentRows}
          canExecute={canExecute}
          canWrite={canWrite}
          computeState={currentEnvironment?.inspection.state}
          activeTurn={activeTurn}
          waitingAgent={waitingAgent}
          artifacts={bundle.artifacts}
        />
        {canExecute && !agents.ok ? (
          <ErrorNotice message={`Couldn't load .agents — ${agents.message}`} />
        ) : null}
      </header>

      {openAttention.length > 0 ? (
        <section
          className="border border-(--bad)/50 bg-(--bg-subtle) p-5"
          aria-label="Needs your attention"
        >
          <h2 className="mb-4 font-semibold">Needs your attention · {openAttention.length}</h2>
          {openAttention.map((item) => (
            <div key={item.id} className="border-t border-(--line) py-4">
              <p className="font-medium">{item.title}</p>
              <p className="mt-2 text-sm text-(--mut)">
                {item.kind === "agent_waiting" ? item.detail : errorSummary(item.detail)}
              </p>
              {item.kind !== "agent_waiting" && item.detail ? (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer">Technical details</summary>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                    {item.detail}
                  </pre>
                </details>
              ) : null}
              {canExecute ? (
                <AttentionActions
                  projectId={projectId}
                  storyId={story.id}
                  item={item}
                  agentName={
                    bundle.turns.find((turn) => turn.id === item.turnId)?.agentName ?? null
                  }
                />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section id="conversation" className="scroll-mt-6 flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <Eyebrow>conversation</Eyebrow>
          <span className="text-[11px] text-(--dim)">
            Newest first · each request with the run and response it produced
          </span>
        </div>
        {!conversation.ok ? (
          <ErrorNotice message={`Couldn't load conversation — ${conversation.message}`} />
        ) : (
          <StoryConversation
            projectId={projectId}
            storyId={story.id}
            initial={conversation.data}
            waitingTurnIds={waitingTurnIds}
            canExecute={canExecute && story.deletedAt === null}
          />
        )}
      </section>

      <section
        id="workspace"
        className="scroll-mt-6 flex flex-col gap-4 border border-(--line) p-5 lg:p-6"
      >
        <h2 className="text-lg font-semibold">Development environment</h2>
        {bundle.workspace ? (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-2 border border-(--line) px-3 py-1">
                {bundle.workspace.provider === "vercel" ? (
                  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24">
                    <path fill="currentColor" d="M12 3 24 23H0Z" />
                  </svg>
                ) : null}
                {bundle.workspace.provider === "vercel" ? "Vercel" : bundle.workspace.provider}
              </span>
              <strong>{computeLabel(currentEnvironment)}</strong>
              <span className="text-xs text-(--mut)">
                Last workspace activity: {formatTime(bundle.workspace.lastActivityAt)}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-(--mut)">
              {currentEnvironment?.inspection.state === "sleeping"
                ? "Compute is stopped. Your saved workspace is retained; opening the app or sending a task resumes it."
                : currentEnvironment?.inspection.state === "running"
                  ? "The machine is on. It may serve a preview even when no agent is running."
                  : "Machine availability is separate from the task phase and agent activity."}
            </p>
            <p className="text-sm">
              Cost:{" "}
              {currentEnvironment ? formatCost(currentEnvironment.metrics.cost) : "Unavailable"}
            </p>
            {bundle.workspace.provider === "vercel" ? (
              <p className="text-xs leading-relaxed text-(--dim)">
                Suspended machines incur no CPU or memory usage; retained snapshots can still incur
                storage charges.{" "}
                <a
                  className="text-(--info) underline"
                  href="https://vercel.com/docs/sandbox/pricing"
                  target="_blank"
                  rel="noreferrer"
                >
                  Vercel pricing ↗
                </a>
              </p>
            ) : null}
            <details className="text-xs text-(--mut)">
              <summary className="cursor-pointer py-2">Environment details</summary>
              <dl className="mt-3 grid grid-cols-[100px_minmax(0,1fr)] gap-3">
                <dt>Image</dt>
                <dd className="break-all font-mono">{bundle.workspace.environment.image ?? "—"}</dd>
                <dt>Storage reference</dt>
                <dd className="break-all font-mono">{bundle.workspace.volumeRef}</dd>
                <dt>Recorded state</dt>
                <dd>{bundle.workspace.state} (last saved)</dd>
                <dt>Create / wake</dt>
                <dd>
                  {formatDuration(currentEnvironment?.metrics.create_time_ms ?? null)} /{" "}
                  {formatDuration(currentEnvironment?.metrics.wake_time_ms ?? null)}
                </dd>
              </dl>
            </details>
            {!environment.ok ? (
              <ErrorNotice
                message={`Environment inspection unavailable — ${environment.message}`}
              />
            ) : null}
            <EnvironmentLogs projectId={projectId} storyId={story.id} />
            {bundle.workspace.state !== "destroyed" && !story.deletedAt ? (
              <WorkspaceVariables
                key={bundle.workspace.id}
                projectId={projectId}
                storyId={story.id}
                canExecute={canExecute}
              />
            ) : null}
          </>
        ) : (
          <p className="text-sm text-(--dim)">Workspace has not been created.</p>
        )}
      </section>

      <StoryTimeline projectId={projectId} storyId={story.id} />

      {resolvedAttention.length > 0 ? (
        <details className="border border-(--line) p-5">
          <summary className="cursor-pointer text-sm text-(--mut)">
            Resolved and dismissed notices · {resolvedAttention.length}
          </summary>
          {resolvedAttention.map((item) => (
            <div key={item.id} className="mt-4 border-t border-(--line) pt-3 text-sm">
              <p>
                {item.title} · {item.resolution ?? "Resolved"}
              </p>
              <p className="text-xs text-(--dim)">
                {formatTime(item.resolvedAt ?? item.createdAt)}
              </p>
              <details>
                <summary className="mt-2 cursor-pointer text-xs">Original details</summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {item.detail}
                </pre>
              </details>
            </div>
          ))}
        </details>
      ) : null}

      {bundle.artifacts.length > 3 ? (
        <section id="results" className="scroll-mt-6 flex flex-col gap-3">
          <Eyebrow>results · {bundle.artifacts.length}</Eyebrow>
          <div className="flex flex-col border border-(--line)">
            {bundle.artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className="flex items-center gap-3 border-b border-(--line) p-4 last:border-b-0"
              >
                <span className="font-mono text-[10px] text-(--dim)">{artifact.kind}</span>
                {safeExternalUrl(artifact.uri) ? (
                  <a
                    href={artifact.uri}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-(--info) hover:underline"
                  >
                    {artifact.label} ↗
                  </a>
                ) : (
                  <span className="text-[12px] text-(--mut)">
                    {artifact.label} · {artifact.uri}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function formatDuration(value: number | null) {
  return value === null ? "—" : `${value} ms`;
}

function formatCost(cost: StoryEnvironment["metrics"]["cost"]) {
  if (cost.active_compute_cents === null && cost.retained_storage_cents === null) {
    return "not reported by provider";
  }
  return `${cost.active_compute_cents === null ? "unknown" : `${cost.active_compute_cents}¢`} compute · ${cost.retained_storage_cents === null ? "unknown" : `${cost.retained_storage_cents}¢`} storage`;
}
