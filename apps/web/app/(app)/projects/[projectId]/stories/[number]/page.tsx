import { Eyebrow, StatusDot } from "@facility/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ErrorNotice, Offline } from "@/components/offline";
import { LiveRefresh } from "@/components/shell/live-refresh";
import { AttentionActions } from "@/components/story/attention-actions";
import { EnvironmentLogs } from "@/components/story/environment-logs";
import { StoryActions } from "@/components/story/story-actions";
import { StoryCompletionPanel } from "@/components/story/story-completion";
import { StoryConsultationPanel } from "@/components/story/story-consultation";
import { StoryConversation } from "@/components/story/story-conversation";
import { StoryDeliveryPanel } from "@/components/story/story-delivery";
import { StoryPlanPanel } from "@/components/story/story-plan";
import { StoryPreviewConvergencePanel } from "@/components/story/story-preview-convergence";
import { StoryProgress } from "@/components/story/story-progress";
import { StorySections } from "@/components/story/story-sections";
import { StoryTimeline } from "@/components/story/story-timeline";
import { StoryWorkflowPanel } from "@/components/story/story-workflow";
import { WorkspaceVariables } from "@/components/story/workspace-variables";
import { api, type StoryEnvironment } from "@/lib/api";
import { titleStatus } from "@/lib/backlog-presentation";
import { can } from "@/lib/permissions";
import { storyFocus } from "@/lib/story-focus";
import {
  computeLabel,
  errorSummary,
  formatTime,
  isReviewNotice,
  phaseLabel,
  safeExternalUrl,
  storyActivity,
} from "@/lib/story-presentation";
import { readStoryReviewLink, storyReviewHref } from "@/lib/story-review-navigation";

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
  searchParams = Promise.resolve({}),
}: {
  params: Promise<{ projectId: string; number: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId, number: storyId } = await params;
  const { selection, messageId, messageError } = readStoryReviewLink(await searchParams);
  const [detail, conversation, environment, agents, me, consultations, workflow, linkedPlan] =
    await Promise.all([
      api.workspaceStory(projectId, storyId),
      messageError
        ? Promise.resolve({
            ok: false as const,
            status: 400,
            offline: false,
            message: messageError,
          })
        : api.workspaceStoryConversation(projectId, storyId, undefined, messageId),
      api.workspaceStoryEnvironment(projectId, storyId),
      api.storyAgents(projectId),
      api.me(),
      api.workspaceStoryConsultations(projectId, storyId),
      api.storyWorkflow(projectId, storyId),
      selection?.revision
        ? api.storyPlanRevision(projectId, storyId, selection.revision)
        : Promise.resolve(null),
    ]);

  if (!detail.ok) {
    if (detail.offline) return <Offline />;
    if (detail.status === 404) notFound();
    return <ErrorNotice message={`Couldn't load this story — ${detail.message}`} />;
  }

  const bundle = detail.data;
  if (selection && linkedPlan) {
    if (!linkedPlan.ok) selection.error = `Couldn't load the linked plan — ${linkedPlan.message}`;
    else if (
      linkedPlan.data.revision !== selection.revision ||
      (selection.digest && linkedPlan.data.digest !== selection.digest)
    )
      selection.error =
        "The saved plan does not match this link's revision and digest. Open the current plan explicitly to continue.";
    else selection.plan = linkedPlan.data;
  }
  const focusError =
    messageId &&
    conversation.ok &&
    (conversation.data.focus?.messageId !== messageId ||
      !conversation.data.messages.some((message) => message.id === messageId))
      ? "The requested source message was not returned. The latest conversation has not been substituted."
      : null;
  const story = bundle.story;
  const activity = storyActivity(bundle);
  const openAttention = bundle.attention.filter((item) => item.status === "open");
  const resolvedAttention = bundle.attention.filter((item) => item.status !== "open");
  const currentEnvironment = environment.ok ? environment.data : null;
  const agentRows = agents.ok ? agents.data.agents : [];
  const permissions = me.ok ? me.data.permissions : [];
  const canExecute = can(permissions, "workspaces:execute");
  const canWrite = can(permissions, "projects:write");
  const canConfigureIntegration = canWrite && can(permissions, "repos:write");
  const canRecordIntegration = can(permissions, "stories:write");
  const canComplete = canWrite && can(permissions, "github:write");
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

  const focus = storyFocus(
    bundle,
    workflow.ok ? workflow.data : undefined,
    selection ? { revision: selection.revision } : false,
  );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <LiveRefresh seconds={8} />
      <header className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-(--mut)">
          <Link
            href={`/projects/${encodeURIComponent(projectId)}`}
            className="inline-flex min-h-11 items-center hover:text-(--ink)"
          >
            ← Attention
          </Link>
          <span aria-hidden="true">·</span>
          <span>
            {story.provider === "manual"
              ? "Started in Facility"
              : story.provider === "schedule"
                ? `Scheduled · ${story.externalId}`
                : `GitHub · ${story.externalId.replace(":", " #")}`}
          </span>
          {safeExternalUrl(story.pullRequestUrl) ? (
            <>
              <span aria-hidden="true">·</span>
              <a
                href={story.pullRequestUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center text-(--info) hover:underline"
              >
                Source pull request #{story.pullRequestNumber} ↗
              </a>
            </>
          ) : null}
        </p>
        <h1 className="text-[clamp(22px,2.6vw,28px)] font-semibold leading-tight tracking-tight">
          {story.title}
        </h1>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-(--mut)">
          <StatusDot tone={activity.active ? "agent" : "machine"} pulse={activity.active} />
          <span className="text-(--ink)">{activity.label}</span>
          {/attention/i.test(activity.label) && story.status === "attention" ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span>{phaseLabel(story.status)}</span>
            </>
          )}
          {bundle.progress?.latest ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="min-w-0 break-words">
                {bundle.progress.latest.turn.agentName}: {bundle.progress.latest.activity.title}
              </span>
            </>
          ) : null}
        </p>
      </header>

      {openAttention.length > 0 ? (
        <section id="story-attention" aria-label="Needs your attention" className="flex flex-col">
          {openAttention.map((item) => {
            const reviewNotice = isReviewNotice(item.kind);
            const deliveryNotice = ["delivery_integration", "delivery_completion"].includes(
              item.kind,
            );
            const failure = !reviewNotice && !deliveryNotice && item.kind !== "agent_waiting";
            return (
              <div key={item.id} className="flex gap-3 border-b border-(--line) py-4 first:pt-0">
                <span
                  aria-hidden="true"
                  className={`mt-2 size-2 shrink-0 rounded-full ${failure ? "bg-(--bad)" : "bg-(--human)"}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.title}</p>
                  <p className="mt-1 text-sm text-(--mut)">
                    {failure
                      ? errorSummary(item.detail)
                      : (item.detail ??
                        (reviewNotice ? "Review the recorded candidate and findings." : null))}
                  </p>
                  {reviewNotice ? (
                    <Link
                      href="#story-section-workflow"
                      className="inline-flex min-h-11 items-center text-sm text-(--info) underline"
                    >
                      Review the candidate and findings
                    </Link>
                  ) : null}
                  {reviewNotice ? (
                    <p className="text-xs text-(--mut)">
                      Dismissing this notice does not approve changes or restart work.
                    </p>
                  ) : null}
                  {failure && item.detail ? (
                    <details className="text-sm">
                      <summary className="min-h-11 cursor-pointer py-3 text-(--mut)">
                        Technical details
                      </summary>
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
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
              </div>
            );
          })}
        </section>
      ) : null}

      {!workflow.ok ? (
        <ErrorNotice message={`Workflow status unavailable: ${workflow.message}`} />
      ) : null}

      <StorySections
        key={JSON.stringify([me.ok ? me.data.principal?.id : null, projectId, story.id])}
        scope={{ projectId, storyId }}
        navigationKey={JSON.stringify([
          selection?.revision,
          selection?.digest,
          selection?.error,
          messageId,
          messageError,
        ])}
        focus={focus}
        conversation={
          <section id="conversation" className="scroll-mt-6 flex flex-col gap-4">
            <h2 className="text-sm font-medium text-(--mut)">Conversation</h2>
            {canExecute && !agents.ok ? (
              <ErrorNotice message={`Couldn't load .agents — ${agents.message}`} />
            ) : null}
            {!conversation.ok || focusError ? (
              <div className="flex flex-col gap-3">
                <ErrorNotice
                  message={
                    focusError ??
                    `Couldn't load conversation — ${!conversation.ok ? conversation.message : ""}`
                  }
                />
                <Link
                  href={storyReviewHref(projectId, storyId, selection, undefined, "conversation")}
                  className="inline-flex min-h-11 items-center text-(--info) underline"
                >
                  Open latest conversation
                </Link>
              </div>
            ) : (
              <StoryConversation
                key={messageId ?? "latest"}
                projectId={projectId}
                storyId={story.id}
                initial={conversation.data}
                latestHref={storyReviewHref(
                  projectId,
                  storyId,
                  selection,
                  undefined,
                  "conversation",
                )}
                waitingTurnIds={waitingTurnIds}
                canExecute={canExecute && story.deletedAt === null}
                canProposePlan={!selection && canWrite && story.deletedAt === null}
              />
            )}
            <StoryActions
              key={JSON.stringify([me.ok ? me.data.principal?.id : null, projectId, story.id])}
              projectId={projectId}
              draftOwnerId={
                me.ok && me.data.principal?.type === "user"
                  ? `${me.data.principal.orgId}:${me.data.principal.userId ?? me.data.principal.id}`
                  : undefined
              }
              story={story}
              workspace={bundle.workspace}
              agents={agentRows}
              canExecute={canExecute}
              canPreview={canExecute || can(permissions, "previews:read")}
              canWrite={canWrite}
              computeState={currentEnvironment?.inspection.state}
              activeTurn={activeTurn}
              waitingAgent={waitingAgent}
              artifacts={bundle.artifacts}
            />
          </section>
        }
        sections={[
          {
            key: "plan",
            label: "Plan and decisions",
            content: (
              <StoryPlanPanel
                key={`plan:${JSON.stringify([me.ok ? me.data.principal?.id : null, projectId, story.id])}`}
                projectId={projectId}
                storyId={story.id}
                initial={bundle.plans}
                selection={selection}
                latestPlanHref={storyReviewHref(projectId, storyId, undefined, messageId)}
                agents={agentRows}
                defaultAgent={agents.ok ? agents.data.defaults.ui : null}
                queuedAgents={
                  workflow.ok && workflow.data.blockedReason ? workflow.data.queuedAgents : []
                }
                blockedReason={workflow.ok ? workflow.data.blockedReason : undefined}
                workflow={workflow.ok ? workflow.data : undefined}
                catalogError={agents.ok ? undefined : agents.message}
                canWrite={canWrite && story.deletedAt === null}
                userId={me.ok ? (me.data.principal?.userId ?? me.data.principal?.id) : undefined}
              />
            ),
          },
          {
            key: "delivery",
            label: "Delivery",
            content: (
              <StoryDeliveryPanel
                key={JSON.stringify([me.ok ? me.data.principal?.id : null, projectId, story.id])}
                projectId={projectId}
                storyId={story.id}
                initial={bundle.delivery}
                canWrite={canWrite && story.deletedAt === null}
                canExecute={canExecute && story.deletedAt === null}
              />
            ),
          },
          {
            key: "workflow",
            label: "Acceptance",
            content: workflow.ok ? (
              <StoryWorkflowPanel
                initial={workflow.data}
                canWrite={canWrite && story.deletedAt === null}
                candidateReady={bundle.delivery?.candidate.state === "recorded"}
              />
            ) : (
              <p className="text-sm text-(--mut)">
                Workflow status is unavailable. Reload before requesting acceptance.
              </p>
            ),
          },
          {
            key: "preview",
            label: "Preview",
            content: bundle.previewConvergence ? (
              <StoryPreviewConvergencePanel
                projectId={projectId}
                storyId={story.id}
                initial={bundle.previewConvergence}
                canExecute={canExecute && story.deletedAt === null}
              />
            ) : (
              <p className="text-sm text-(--mut)">
                {bundle.previewConvergence === undefined
                  ? "Preview delivery is unavailable from this server."
                  : "No preview generation is recorded for this story."}
              </p>
            ),
          },
          {
            key: "completion",
            label: "Completion and retention",
            content: bundle.completion ? (
              <StoryCompletionPanel
                projectId={projectId}
                storyId={story.id}
                initial={bundle.completion}
                canConfigure={canConfigureIntegration && story.deletedAt === null}
                canConfigureNotices={canWrite && story.deletedAt === null}
                canRecord={canRecordIntegration && story.deletedAt === null}
                canComplete={canComplete && story.deletedAt === null}
              />
            ) : (
              <p className="text-sm text-(--mut)">
                Completion and retention details are unavailable from this server.
              </p>
            ),
          },
          {
            key: "progress",
            label: "Activity",
            content: (
              <div className="flex min-w-0 flex-col gap-6">
                <StoryProgress
                  key={`${projectId}:${storyId}`}
                  projectId={projectId}
                  storyId={storyId}
                  progress={bundle.progress}
                />
                <StoryTimeline projectId={projectId} storyId={story.id} />
                {resolvedAttention.length > 0 ? (
                  <details className="text-sm">
                    <summary className="min-h-11 cursor-pointer py-3 text-(--mut)">
                      Resolved and dismissed notices · {resolvedAttention.length}
                    </summary>
                    {resolvedAttention.map((item) => (
                      <div key={item.id} className="border-t border-(--line) py-3">
                        <p>
                          {item.title} · {item.resolution ?? "Resolved"}
                        </p>
                        <p className="text-xs text-(--dim)">
                          {formatTime(item.resolvedAt ?? item.createdAt)}
                        </p>
                        <details>
                          <summary className="mt-2 cursor-pointer text-xs">
                            Original details
                          </summary>
                          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                            {item.detail}
                          </pre>
                        </details>
                      </div>
                    ))}
                  </details>
                ) : null}
              </div>
            ),
          },
          {
            key: "consultation",
            label: "Consultation",
            content: (
              <StoryConsultationPanel
                key={`consultation:${JSON.stringify([me.ok ? me.data.principal?.id : null, projectId, story.id])}`}
                projectId={projectId}
                storyId={story.id}
                initial={consultations.ok ? consultations.data : undefined}
                initialError={consultations.ok ? undefined : consultations.message}
                computeState={currentEnvironment?.inspection.state}
                agents={agentRows}
                defaultAgent={agents.ok ? agents.data.defaults.ui : null}
                canExecute={canExecute && story.deletedAt === null}
                draftOwnerId={
                  me.ok && me.data.principal?.type === "user"
                    ? `${me.data.principal.orgId}:${me.data.principal.userId ?? me.data.principal.id}`
                    : undefined
                }
              />
            ),
          },
          {
            key: "environment",
            label: "Environment",
            content: (
              <section id="workspace" className="scroll-mt-6 flex flex-col gap-4">
                <h2 className="text-base font-semibold">Development environment</h2>
                <dl className="flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-(--mut)">
                  <div className="inline-flex gap-1.5">
                    <dt>Environment:</dt>
                    <dd className="text-(--ink)">{computeLabel(currentEnvironment)}</dd>
                  </div>
                  {story.branch ? (
                    <div className="inline-flex gap-1.5">
                      <dt>Branch:</dt>
                      <dd className="font-mono">{story.branch}</dd>
                    </div>
                  ) : null}
                  {bundle.assignees.length > 0 ? (
                    <div className="inline-flex gap-1.5">
                      <dt>Working on it:</dt>
                      <dd className="text-(--ink)">
                        {bundle.assignees
                          .map(
                            (person) =>
                              person.name ?? (person.login ? `@${person.login}` : person.subject),
                          )
                          .join(", ")}
                      </dd>
                    </div>
                  ) : null}
                  {titleStatus({ titleSource: story.titleSource, createdAt: story.createdAt }) ? (
                    <div className="inline-flex gap-1.5 text-(--dim)">
                      <dt className="sr-only">Title</dt>
                      <dd>
                        {titleStatus({
                          titleSource: story.titleSource,
                          createdAt: story.createdAt,
                        })}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {bundle.workspace ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="inline-flex items-center gap-2 text-(--mut)">
                        {bundle.workspace.provider === "vercel" ? (
                          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24">
                            <path fill="currentColor" d="M12 3 24 23H0Z" />
                          </svg>
                        ) : null}
                        {bundle.workspace.provider === "vercel"
                          ? "Vercel"
                          : bundle.workspace.provider}
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
                      {currentEnvironment
                        ? formatCost(currentEnvironment.metrics.cost)
                        : "Unavailable"}
                    </p>
                    {bundle.workspace.provider === "vercel" ? (
                      <p className="text-xs leading-relaxed text-(--dim)">
                        Suspended machines incur no CPU or memory usage; retained snapshots can
                        still incur storage charges.{" "}
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
            ),
          },
        ]}
      />

      {bundle.artifacts.length > 3 ? (
        <section id="results" className="scroll-mt-6 flex flex-col gap-3">
          <Eyebrow>results · {bundle.artifacts.length}</Eyebrow>
          <div className="flex flex-col border-t border-(--line)">
            {bundle.artifacts.map((artifact) => (
              <div
                key={artifact.id}
                className="flex items-center gap-3 border-b border-(--line) py-3"
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
