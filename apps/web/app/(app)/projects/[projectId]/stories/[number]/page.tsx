import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/markdown";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { AttentionActions } from "@/components/story/attention-actions";
import {
  CancelTurnButton,
  StoryComposer,
  WorkspaceControls,
} from "@/components/story/workspace-story-controls";
import { WorkspaceVariables } from "@/components/story/workspace-variables";
import { api, type StoryEnvironment, type StoryMessage } from "@/lib/api";
import { can } from "@/lib/permissions";
import {
  computeLabel,
  errorSummary,
  newestMessages,
  presentMessage,
  safeExternalUrl,
  storyActivity,
} from "@/lib/story-presentation";

export async function generateMetadata({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  return { title: `story ${number}` };
}

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
  const pullRequestUrl = safeExternalUrl(story.pullRequestUrl);
  const messages = newestMessages(conversation.ok ? conversation.data.messages : []);
  const activity = storyActivity(bundle);
  const openAttention = bundle.attention.filter((item) => item.status === "open");
  const resolvedAttention = bundle.attention.filter((item) => item.status !== "open");
  const currentEnvironment = environment.ok ? environment.data : null;
  const agentRows = agents.ok ? agents.data.agents : [];
  const permissions = me.ok ? me.data.permissions : [];
  const canExecute = can(permissions, "workspaces:execute");
  const canWrite = can(permissions, "projects:write");

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8">
      <LiveRefresh seconds={8} />
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Eyebrow>
            {story.provider}:{story.externalId}
          </Eyebrow>
          <Link
            href={`/projects/${encodeURIComponent(projectId)}/stories`}
            className="text-[11.5px] text-(--dim) hover:text-(--ink)"
          >
            ← all stories
          </Link>
        </div>
        <h1 className="text-[clamp(22px,3vw,32px)] font-semibold tracking-tight">{story.title}</h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11.5px] text-(--mut)">
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={activity.active ? "agent" : "machine"} pulse={activity.active} />
            {activity.label}
          </span>
          <span>Environment: {computeLabel(currentEnvironment)}</span>
          <span>Task phase: {story.status === "working" ? "In progress" : story.status}</span>
          {story.branch ? <span className="font-mono">{story.branch}</span> : null}
          {pullRequestUrl ? (
            <a
              href={pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="text-(--info) underline-offset-4 hover:underline"
            >
              View pull request #{story.pullRequestNumber} ↗
            </a>
          ) : null}
        </div>
        <nav aria-label="Story shortcuts" className="flex flex-wrap gap-3 text-sm">
          {canExecute ? (
            <a
              href="#story-composer"
              className="border border-(--accent) px-4 py-2 text-(--accent)"
            >
              Send a task ↓
            </a>
          ) : null}
          <a href="#workspace" className="border border-(--line) px-4 py-2">
            Review environment ↓
          </a>
          <a href="#conversation" className="border border-(--line) px-4 py-2">
            Latest messages ↓
          </a>
          <a href="#sessions" className="border border-(--line) px-4 py-2">
            Agent runs ↓
          </a>
        </nav>
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
                <AttentionActions projectId={projectId} storyId={story.id} item={item} />
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section id="conversation" className="scroll-mt-6 flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <Eyebrow>conversation · {messages.length}</Eyebrow>
          <span className="text-[11px] text-(--dim)">Newest first · shared across agents</span>
        </div>
        {!conversation.ok ? (
          <ErrorNotice message={`Couldn't load conversation — ${conversation.message}`} />
        ) : messages.length === 0 ? (
          <p className="border border-(--line) p-6 text-sm text-(--dim)">No messages yet.</p>
        ) : (
          <div className="flex flex-col gap-px border border-(--line) bg-(--line)">
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
          </div>
        )}
        {canExecute && story.deletedAt === null && agentRows.length > 0 ? (
          <StoryComposer projectId={projectId} storyId={story.id} agents={agentRows} />
        ) : null}
      </section>

      <section
        id="workspace"
        className="scroll-mt-6 grid gap-6 border border-(--line) p-5 lg:grid-cols-[minmax(0,1fr)_300px] lg:p-6"
      >
        <div className="flex min-w-0 flex-col gap-4">
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
              </div>
              <p className="text-sm leading-relaxed text-(--mut)">
                {currentEnvironment?.inspection.state === "sleeping"
                  ? "Compute is stopped. Your saved workspace is retained; opening the app or sending a task resumes it."
                  : currentEnvironment?.inspection.state === "running"
                    ? "The machine is on. It may serve a preview even when no agent is running."
                    : "Machine availability is separate from the task phase and agent activity."}
              </p>
              <p className="text-xs text-(--mut)">
                Last workspace activity: {formatTime(bundle.workspace.lastActivityAt)}
              </p>
              <p className="text-sm">
                Cost:{" "}
                {currentEnvironment ? formatCost(currentEnvironment.metrics.cost) : "Unavailable"}
              </p>
              {bundle.workspace.provider === "vercel" ? (
                <p className="text-xs leading-relaxed text-(--dim)">
                  Suspended machines incur no CPU or memory usage; retained snapshots can still
                  incur storage charges.{" "}
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
                  <dd className="break-all font-mono">
                    {bundle.workspace.environment.image ?? "—"}
                  </dd>
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
            </>
          ) : (
            <p className="text-sm text-(--dim)">Workspace has not been created.</p>
          )}
        </div>
        <WorkspaceControls
          projectId={projectId}
          story={story}
          workspace={bundle.workspace}
          canExecute={canExecute}
          canWrite={canWrite}
          computeState={currentEnvironment?.inspection.state}
        />
        {bundle.workspace && bundle.workspace.state !== "destroyed" && !story.deletedAt ? (
          <div className="min-w-0 lg:col-span-2">
            <WorkspaceVariables
              key={bundle.workspace.id}
              projectId={projectId}
              storyId={story.id}
              canExecute={canExecute}
            />
          </div>
        ) : null}
      </section>

      <details className="border border-(--line) p-5">
        <summary className="cursor-pointer font-medium">
          Activity history and technical evidence
        </summary>
        <section className="mt-5 flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <Eyebrow>story timeline · {bundle.timeline.length}</Eyebrow>
            <span className="text-[11px] text-(--dim)">
              agent, workspace, Git and GitHub evidence
            </span>
          </div>
          <div className="flex flex-col border border-(--line)">
            {[...bundle.timeline]
              .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
              .map((event) => (
                <article
                  key={event.id}
                  className="grid gap-2 border-b border-(--line) p-4 last:border-b-0 sm:grid-cols-[130px_minmax(0,1fr)]"
                >
                  <div>
                    <p className="font-mono text-[9.5px] uppercase text-(--accent)">
                      {event.source}
                    </p>
                    <time className="text-[10px] text-(--dim)" dateTime={event.occurred_at}>
                      {formatTime(event.occurred_at)}
                    </time>
                  </div>
                  <div className="min-w-0">
                    <p className="font-mono text-[11px] text-(--ink)">{event.type}</p>
                    <p className="mt-1 text-[11.5px] leading-relaxed text-(--mut)">
                      {timelineSummary(event.type, event.data)}
                    </p>
                    {event.turn_id ? (
                      <p className="mt-1 font-mono text-[9.5px] text-(--dim)">
                        turn {event.turn_id}
                      </p>
                    ) : null}
                  </div>
                </article>
              ))}
          </div>
        </section>
      </details>
      <section id="sessions" className="scroll-mt-6 grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h2 className="font-semibold">Agent runs</h2>
          <div className="flex flex-col border border-(--line)">
            {bundle.turns.length === 0 ? (
              <p className="p-5 text-[12px] text-(--dim)">No turns yet.</p>
            ) : (
              [...bundle.turns]
                .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                .map((turn) => (
                  <div
                    id={`run-${turn.id}`}
                    key={turn.id}
                    className="border-b border-(--line) p-4 last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-3 text-[11.5px]">
                      <span className="font-mono text-(--ink)">{turn.agentName}</span>
                      <span className={turn.state === "failed" ? "text-(--bad)" : "text-(--mut)"}>
                        {turn.state}
                      </span>
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-(--dim)">
                      {turn.engine} · {turn.model} · {formatTime(turn.createdAt)}
                    </p>
                    {turn.error ? (
                      <details className="mt-2 text-xs text-(--mut)">
                        <summary className="cursor-pointer">Run error details</summary>
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                          {turn.error}
                        </pre>
                      </details>
                    ) : null}
                    {canExecute && ["queued", "running"].includes(turn.state) ? (
                      <CancelTurnButton projectId={projectId} storyId={story.id} turnId={turn.id} />
                    ) : null}
                  </div>
                ))
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <details>
            <summary className="cursor-pointer font-medium">Service logs</summary>
            {!environment.ok ? (
              <ErrorNotice message={environment.message} />
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {(environment.data.workspace.environment.ports ?? []).map((service) => (
                    <span
                      key={service.service}
                      className="border border-(--line) px-2 py-1 font-mono text-[10px] text-(--mut)"
                    >
                      {service.service}:{service.port} · {environment.data.inspection.state}
                    </span>
                  ))}
                </div>
                <div className="max-h-96 overflow-auto border border-(--line) bg-(--bg-subtle) p-4 font-mono text-[10.5px] leading-relaxed">
                  {environment.data.events.length === 0 ? (
                    <p className="text-(--dim)">No environment events yet.</p>
                  ) : (
                    environment.data.events.map((event) => (
                      <div key={event.seq} className="mb-3 last:mb-0">
                        <p className="text-(--accent)">
                          {event.seq} · {event.type}
                        </p>
                        <pre className="mt-1 whitespace-pre-wrap break-words text-(--mut)">
                          {JSON.stringify(event.data, null, 2)}
                        </pre>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </details>
        </div>
      </section>

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

      {bundle.artifacts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <Eyebrow>artifacts</Eyebrow>
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

function Message({ message }: { message: StoryMessage }) {
  const isAgent = message.role === "agent";
  const presentation = presentMessage(message);
  return (
    <article className="bg-(--bg) p-5 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center gap-3 text-[10.5px]">
        <span className={`font-mono ${isAgent ? "text-(--accent)" : "text-(--human)"}`}>
          {isAgent ? "agent" : (message.actor?.id?.replace(/^github:/, "@") ?? message.role)}
        </span>
        {message.requestedAgentName ? (
          <span className="font-mono text-(--dim)">→ {message.requestedAgentName}</span>
        ) : null}
        <time className="ml-auto text-(--dim)" dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
      </div>
      {presentation.title ? <h3 className="mb-3 font-semibold">{presentation.title}</h3> : null}
      <div className="max-w-prose text-[15px] leading-7">
        {presentation.body.length > 1600 ? (
          <>
            <Markdown source={`${presentation.body.slice(0, 800)}…`} />
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-(--info)">Read full message</summary>
              <div className="mt-4">
                <Markdown source={presentation.body} />
              </div>
            </details>
          </>
        ) : (
          <Markdown source={presentation.body} />
        )}
      </div>
      <div className="mt-3 flex gap-4 text-xs text-(--info)">
        {presentation.sourceUrl ? (
          <a href={presentation.sourceUrl} target="_blank" rel="noreferrer">
            View on GitHub ↗
          </a>
        ) : null}
        {message.turnId ? <a href={`#run-${message.turnId}`}>View agent run ↓</a> : null}
      </div>
      {presentation.technical ? (
        <details className="mt-4 text-xs text-(--dim)">
          <summary className="cursor-pointer">Original event · technical details</summary>
          <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words">
            {message.body}
          </pre>
        </details>
      ) : null}
    </article>
  );
}

function timelineSummary(type: string, data: Record<string, unknown>) {
  const text = (key: string) => (typeof data[key] === "string" ? String(data[key]) : null);
  const count = (key: string) => (Array.isArray(data[key]) ? data[key].length : 0);
  if (type === "story.created") return text("title") ?? "Story created.";
  if (type === "turn.context_recorded") {
    return [text("agent"), text("model"), text("initialSha")?.slice(0, 10), text("branch")]
      .filter(Boolean)
      .join(" · ");
  }
  if (type === "git.changes_recorded") {
    return `${count("commits")} commits · ${count("changedFiles")} changed files · ${text("initialSha")?.slice(0, 10) ?? "unknown"} → ${text("finalSha")?.slice(0, 10) ?? "unknown"}`;
  }
  if (type === "github.branch_observed" || type === "github.branch_deleted") {
    return `${text("branch") ?? "branch"} · ${text("headSha")?.slice(0, 10) ?? "unknown"} · ${text("actor") ?? "external"}`;
  }
  if (type === "github.pull_request_observed") {
    return `PR #${String(data.number ?? "?")} · ${text("state") ?? "unknown"} · ${text("title") ?? ""}`;
  }
  if (type === "github.review_observed") {
    return `${text("author") ?? "unknown reviewer"} · ${text("state") ?? "reviewed"} · PR #${String(data.pullNumber ?? "?")}`;
  }
  if (type === "github.check_observed") {
    return `${text("name") ?? "check"} · ${text("conclusion") ?? text("status") ?? "unknown"}`;
  }
  if (type === "artifact.recorded") return text("label") ?? "Artifact recorded.";
  if (type.startsWith("attention.")) return text("title") ?? type;
  if (type === "turn.failed") return text("error") ?? "Turn failed.";
  return type.replaceAll(".", " ");
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
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
