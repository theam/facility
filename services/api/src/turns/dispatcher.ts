import { type AgentManifest, AgentManifestSchema } from "@facility/agents";
import { newId } from "@facility/core";
import {
  engineSessions,
  type FacilityDb,
  stories,
  storyConversations,
  storyMessages,
  turns,
  workspaces,
} from "@facility/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { type AgentCatalogService, manifestFromProjection } from "../agents/catalog.js";
import type { GithubWorkspaceCredentialBroker } from "../github/workspace-credentials.js";
import { CostBudgetService } from "../insights/costs.js";
import type { StoryWorkspaceService } from "../stories/service.js";
import type {
  ProjectEnvironmentService,
  ProjectManifestSource,
} from "../workspaces/project-environment.js";
import type { WorkspaceLocator } from "../workspaces/runtime.js";
import type { AgentEngineRegistry, AgentTurnResult } from "./engines.js";
import { AgentEngineError } from "./engines.js";
import { appendTurnEvent } from "./events.js";
import type { StartedGitEvidence, TurnGitEvidenceService } from "./git-evidence.js";
import { buildPrompt } from "./prompt.js";

export class TurnDispatcher {
  constructor(
    private readonly db: FacilityDb,
    private readonly storiesService: StoryWorkspaceService,
    private readonly catalog: AgentCatalogService,
    private readonly credentials: GithubWorkspaceCredentialBroker,
    private readonly projectManifests: ProjectManifestSource,
    private readonly environment: ProjectEnvironmentService,
    private readonly engines: AgentEngineRegistry,
    private readonly evidence: TurnGitEvidenceService,
    private readonly costs = new CostBudgetService(db),
  ) {}

  async dispatch(input: { orgId: string; projectId: string; turnId: string }) {
    const turn = (
      await this.db
        .update(turns)
        .set({ state: "running", startedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(turns.orgId, input.orgId),
            eq(turns.projectId, input.projectId),
            eq(turns.id, input.turnId),
            eq(turns.state, "queued"),
          ),
        )
        .returning()
    )[0];
    if (!turn) {
      const unclaimed = await this.turn(input.orgId, input.projectId, input.turnId);
      if (unclaimed?.state === "canceled") {
        await this.activateQueuedSuccessor({
          ...input,
          storyId: unclaimed.storyId,
        });
      }
      return { claimed: false as const };
    }

    const cancellation = new AbortController();
    let leaseCheckPending = false;
    const leaseHeartbeat = setInterval(() => {
      if (leaseCheckPending) return;
      leaseCheckPending = true;
      void this.heartbeat(input.orgId, input.projectId, input.turnId)
        .then((alive) => {
          if (!alive) cancellation.abort();
        })
        .catch(() => undefined)
        .finally(() => {
          leaseCheckPending = false;
        });
    }, 2_000);
    leaseHeartbeat.unref();

    const eventBase = {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: turn.storyId,
      turnId: turn.id,
    };
    let secrets: string[] = [];
    let startedGitEvidence: StartedGitEvidence | undefined;
    let gitEvidenceCompleted = false;
    try {
      await this.storiesService.resolveAttention({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: turn.storyId,
        kind: "queued_turn_dispatch_error",
      });
      if (["manual", "mcp", "ui"].includes(turn.triggerType)) {
        await this.storiesService.resolveAttention({
          orgId: input.orgId,
          projectId: input.projectId,
          storyId: turn.storyId,
          kind: "agent_waiting",
          resolution: "replied",
          actor: turn.createdBy as { type: "user" | "service" | "system"; id: string },
        });
      }
      await appendTurnEvent(this.db, { ...eventBase, type: "turn.started", data: {} });
      const [story, workspace, conversation, messages] = await Promise.all([
        this.scopedStory(input.orgId, input.projectId, turn.storyId),
        this.activeWorkspace(input.orgId, input.projectId, turn.storyId),
        this.db
          .select()
          .from(storyConversations)
          .where(
            and(
              eq(storyConversations.orgId, input.orgId),
              eq(storyConversations.projectId, input.projectId),
              eq(storyConversations.storyId, turn.storyId),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        this.db
          .select()
          .from(storyMessages)
          .where(
            and(
              eq(storyMessages.orgId, input.orgId),
              eq(storyMessages.projectId, input.projectId),
              eq(storyMessages.storyId, turn.storyId),
            ),
          )
          .orderBy(asc(storyMessages.seq)),
      ]);
      if (!workspace || !conversation)
        throw new Error("story workspace or conversation is missing");
      const manifest = AgentManifestSchema.parse(turn.manifest);
      if (manifest.hash !== turn.manifestHash || manifest.name !== turn.agentName) {
        throw new Error("turn agent manifest snapshot does not match its recorded identity");
      }
      await this.costs.assertTurnAllowed(input.orgId, input.projectId, manifest.model);
      const [credential, projectManifest] = await Promise.all([
        this.credentials.issue(input.orgId, input.projectId),
        this.projectManifests.load(input.orgId, input.projectId),
      ]);
      const branch = story.branch ?? storyBranch(story.title, story.id);
      if (!story.branch) {
        await this.db
          .update(stories)
          .set({ branch, updatedAt: new Date() })
          .where(and(eq(stories.orgId, input.orgId), eq(stories.id, story.id)));
      }
      const prepared = await this.environment.prepare({
        orgId: input.orgId,
        projectId: input.projectId,
        workspace: workspaceLocator(workspace),
        manifest: projectManifest,
        credentials: credential,
        branch,
        previousSetupChecksum: workspace.setupChecksum,
      });
      secrets = credentialSecrets(prepared.processEnvironment, projectManifest.environment.secrets);
      const session = (
        await this.db
          .select()
          .from(engineSessions)
          .where(
            and(
              eq(engineSessions.orgId, input.orgId),
              eq(engineSessions.projectId, input.projectId),
              eq(engineSessions.storyId, story.id),
              eq(engineSessions.workspaceId, workspace.id),
              eq(engineSessions.agentName, manifest.name),
              eq(engineSessions.engine, manifest.engine),
              eq(engineSessions.model, manifest.model),
              eq(engineSessions.status, "active"),
            ),
          )
          .limit(1)
      )[0];
      const engineSessionId = session?.id ?? newId("esess");
      startedGitEvidence = await this.evidence.start({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: story.id,
        turnId: turn.id,
        workspace: workspaceLocator(workspace),
        workspaceProvider: workspace.provider,
        cwd: prepared.primaryCwd,
        environment: prepared.processEnvironment,
        engineSessionId,
        nativeSessionId: session?.nativeSessionId,
        agentName: manifest.name,
        engine: manifest.engine,
        model: manifest.model,
      });
      const engine = this.engines.get(manifest.engine);
      const engineRequest = {
        turnId: turn.id,
        manifest,
        workspace: workspaceLocator(workspace),
        prompt: buildPrompt(manifest, story, conversation.summary, messages, turn.id),
        cwd: prepared.primaryCwd,
        nativeSessionId: session?.nativeSessionId,
        environment: prepared.processEnvironment,
        signal: cancellation.signal,
      };
      let result: AgentTurnResult;
      try {
        result = await engine.run(engineRequest);
      } catch (error) {
        if (
          !(error instanceof AgentEngineError) ||
          error.code !== "agent_session_corrupt" ||
          !session
        ) {
          throw error;
        }
        await this.persistFailedEngineEvents(error, eventBase, secrets);
        await this.db
          .update(engineSessions)
          .set({ status: "corrupt", updatedAt: new Date() })
          .where(and(eq(engineSessions.orgId, input.orgId), eq(engineSessions.id, session.id)));
        await appendTurnEvent(this.db, {
          ...eventBase,
          type: "engine.session_corrupt",
          data: { engine: manifest.engine, sessionId: session.nativeSessionId },
        });
        throw new AgentEngineError(
          "agent_session_corrupt",
          "The native session could not be resumed. Its files were retained; retry the attention item to start a replacement session in the same worktree.",
          error.details,
        );
      }
      await this.evidence.complete(startedGitEvidence);
      gitEvidenceCompleted = true;
      for (const event of result.events) {
        await appendTurnEvent(this.db, {
          ...eventBase,
          type: `engine.${event.type}`,
          data: boundedEvent(redact(event.data, secrets)),
        });
      }
      const outcome = agentOutcome(result.output);
      await this.costs.record({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: story.id,
        turnId: turn.id,
        agentName: manifest.name,
        engine: manifest.engine,
        model: manifest.model,
        usage: result.usage,
        durationMs: result.durationMs,
        status: "succeeded",
      });
      await this.persistSession({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: story.id,
        workspaceId: workspace.id,
        turnId: turn.id,
        manifest,
        nativeSessionId: result.nativeSessionId,
        existingId: session?.id,
        sessionId: engineSessionId,
      });
      await this.storiesService.completeTurn({
        orgId: input.orgId,
        projectId: input.projectId,
        turnId: turn.id,
        output: redactString(
          outcome.output || `${manifest.name} completed without a text response.`,
          secrets,
        ),
        actor: { type: "system", id: `${manifest.engine}:${result.nativeSessionId}` },
      });
      if (outcome.attention) {
        await this.storiesService.flagAttention({
          orgId: input.orgId,
          projectId: input.projectId,
          storyId: story.id,
          turnId: turn.id,
          kind: "agent_waiting",
          title: `${manifest.name} needs a reply`,
          detail: redactString(outcome.attention, secrets),
        });
      } else {
        const retriedAttentionId = turn.triggerKey?.match(
          /^attention-retry:(attn_[a-z0-9]+)$/,
        )?.[1];
        if (retriedAttentionId) {
          await this.storiesService.resolveAttentionItem({
            orgId: input.orgId,
            projectId: input.projectId,
            storyId: story.id,
            attentionId: retriedAttentionId,
            resolution: "successful_retry",
            actor: { type: "system", id: "turn-dispatcher" },
          });
        }
      }
      await appendTurnEvent(this.db, {
        ...eventBase,
        type: "turn.succeeded",
        data: { durationMs: result.durationMs },
      });
      await this.activateQueuedSuccessor({ ...input, storyId: story.id });
      return { claimed: true as const, state: "succeeded" as const, result };
    } catch (error) {
      if (startedGitEvidence && !gitEvidenceCompleted) {
        await this.evidence.complete(startedGitEvidence).catch(() => undefined);
        gitEvidenceCompleted = true;
      }
      if (await this.isCanceled(input.orgId, input.projectId, input.turnId)) {
        await appendTurnEvent(this.db, {
          ...eventBase,
          type: "turn.canceled",
          data: {},
        });
        await this.activateQueuedSuccessor({ ...input, storyId: turn.storyId });
        return { claimed: true as const, state: "canceled" as const };
      }
      if (error instanceof AgentEngineError) {
        await this.costs
          .record({
            orgId: input.orgId,
            projectId: input.projectId,
            storyId: turn.storyId,
            turnId: turn.id,
            agentName: turn.agentName,
            engine: turn.engine,
            model: turn.model,
            usage: asUsage(error.details.usage),
            durationMs: numberValue(error.details.durationMs) ?? 0,
            status: "failed",
          })
          .catch(() => undefined);
      }
      const detail = redactString(error instanceof Error ? error.message : String(error), secrets);
      await this.storiesService.failTurn({ ...input, error: detail });
      await appendTurnEvent(this.db, {
        ...eventBase,
        type: "turn.failed",
        data: { error: detail.slice(0, 8_000) },
      });
      await this.activateQueuedSuccessor({ ...input, storyId: turn.storyId });
      return { claimed: true as const, state: "failed" as const, error: detail };
    } finally {
      clearInterval(leaseHeartbeat);
    }
  }

  private async isCanceled(orgId: string, projectId: string, turnId: string) {
    const current = (
      await this.db
        .select({ state: turns.state })
        .from(turns)
        .where(and(eq(turns.orgId, orgId), eq(turns.projectId, projectId), eq(turns.id, turnId)))
        .limit(1)
    )[0];
    return current?.state === "canceled";
  }

  private async heartbeat(orgId: string, projectId: string, turnId: string) {
    const alive = await this.db
      .update(turns)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(turns.orgId, orgId),
          eq(turns.projectId, projectId),
          eq(turns.id, turnId),
          eq(turns.state, "running"),
        ),
      )
      .returning({ id: turns.id });
    return alive.length > 0;
  }

  private async turn(orgId: string, projectId: string, turnId: string) {
    return (
      await this.db
        .select()
        .from(turns)
        .where(and(eq(turns.orgId, orgId), eq(turns.projectId, projectId), eq(turns.id, turnId)))
        .limit(1)
    )[0];
  }

  async activateQueuedSuccessor(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    turnId: string;
  }) {
    const next = await this.nextQueuedMessage(input.orgId, input.projectId, input.storyId);
    if (!next?.requestedAgentName) return;
    try {
      const projected = await this.catalog.get(
        input.orgId,
        input.projectId,
        next.requestedAgentName,
      );
      await this.storiesService.activateNextMessage({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        agent: manifestFromProjection(projected),
        actor: (next.actor ?? { type: "system", id: "queued-message" }) as {
          type: "user" | "service" | "system";
          id: string;
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.storiesService.flagAttention({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        turnId: input.turnId,
        kind: "queued_turn_dispatch_error",
        title: `Could not dispatch queued ${next.requestedAgentName} turn`,
        detail,
      });
      await appendTurnEvent(this.db, {
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: input.storyId,
        turnId: input.turnId,
        type: "queue.activation_failed",
        data: { agentName: next.requestedAgentName, error: detail.slice(0, 8_000) },
      });
    }
  }

  private async scopedStory(orgId: string, projectId: string, storyId: string) {
    const row = (
      await this.db
        .select()
        .from(stories)
        .where(
          and(eq(stories.orgId, orgId), eq(stories.projectId, projectId), eq(stories.id, storyId)),
        )
        .limit(1)
    )[0];
    if (!row) throw new Error("story not found");
    return row;
  }

  private async activeWorkspace(orgId: string, projectId: string, storyId: string) {
    return (
      await this.db
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.orgId, orgId),
            eq(workspaces.projectId, projectId),
            eq(workspaces.storyId, storyId),
            inArray(workspaces.state, ["creating", "running", "sleeping", "error"]),
          ),
        )
        .limit(1)
    )[0];
  }

  private nextQueuedMessage(orgId: string, projectId: string, storyId: string) {
    return this.db
      .select()
      .from(storyMessages)
      .where(
        and(
          eq(storyMessages.orgId, orgId),
          eq(storyMessages.projectId, projectId),
          eq(storyMessages.storyId, storyId),
          isNull(storyMessages.turnId),
        ),
      )
      .orderBy(asc(storyMessages.seq))
      .limit(1)
      .then((rows) => rows[0]);
  }

  private async persistSession(input: {
    orgId: string;
    projectId: string;
    storyId: string;
    workspaceId: string;
    turnId: string;
    manifest: AgentManifest;
    nativeSessionId: string;
    existingId?: string;
    sessionId: string;
  }) {
    const values = {
      nativeSessionId: input.nativeSessionId,
      lastTurnId: input.turnId,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    };
    if (input.existingId) {
      await this.db
        .update(engineSessions)
        .set(values)
        .where(and(eq(engineSessions.orgId, input.orgId), eq(engineSessions.id, input.existingId)));
      return;
    }
    await this.db.insert(engineSessions).values({
      id: input.sessionId,
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: input.storyId,
      workspaceId: input.workspaceId,
      agentName: input.manifest.name,
      engine: input.manifest.engine,
      model: input.manifest.model,
      nativeSessionId: input.nativeSessionId,
      statePath:
        input.manifest.engine === "claude_code"
          ? "/workspace/.facility/claude"
          : "/workspace/.facility/codex",
      lastTurnId: input.turnId,
    });
  }

  private async persistFailedEngineEvents(
    error: AgentEngineError,
    eventBase: { orgId: string; projectId: string; storyId: string; turnId: string },
    secrets: string[],
  ) {
    const events = Array.isArray(error.details.events) ? error.details.events : [];
    for (const candidate of events) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const event = candidate as Partial<AgentTurnResult["events"][number]>;
      if (typeof event.type !== "string" || !event.data || typeof event.data !== "object") continue;
      await appendTurnEvent(this.db, {
        ...eventBase,
        type: `engine.${event.type}`,
        data: boundedEvent(redact(event.data as Record<string, unknown>, secrets)),
      });
    }
  }
}

function asUsage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const usage = value as Record<string, unknown>;
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];
  if (fields.some((field) => numberValue(usage[field]) === undefined)) return undefined;
  return {
    inputTokens: numberValue(usage.inputTokens) ?? 0,
    outputTokens: numberValue(usage.outputTokens) ?? 0,
    cacheReadTokens: numberValue(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: numberValue(usage.cacheWriteTokens) ?? 0,
    reportedCostCents: numberValue(usage.reportedCostCents),
  };
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function workspaceLocator(row: typeof workspaces.$inferSelect): WorkspaceLocator {
  const environment = row.environment as {
    image?: unknown;
    variables?: unknown;
    ports?: WorkspaceLocator["ports"];
    resources?: WorkspaceLocator["resources"];
  };
  if (!row.externalRef || typeof environment.image !== "string") {
    throw new Error("workspace provider reference or image is missing");
  }
  return {
    id: row.id,
    image: environment.image,
    environment:
      environment.variables && typeof environment.variables === "object"
        ? (environment.variables as Record<string, string>)
        : {},
    ports: Array.isArray(environment.ports) ? environment.ports : [],
    resources: environment.resources,
    externalRef: row.externalRef,
    volumeRef: row.volumeRef,
  };
}

function storyBranch(title: string, storyId: string) {
  const slug =
    title
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 72) || "story";
  return `facility/${slug}-${storyId.slice(-8)}`;
}

function credentialSecrets(environment: Record<string, string>, sensitiveNames: string[] = []) {
  const secrets = new Set<string>();
  if (environment.GH_TOKEN) secrets.add(environment.GH_TOKEN);
  for (const name of sensitiveNames) {
    const value = environment[name];
    if (value) secrets.add(value);
  }
  try {
    for (const value of Object.values(
      JSON.parse(environment.FACILITY_GITHUB_CREDENTIALS ?? "{}"),
    )) {
      if (typeof value === "string") secrets.add(value);
    }
  } catch {
    // The credential broker validates this value before dispatch.
  }
  return [...secrets].filter(Boolean);
}

function redact(value: unknown, secrets: string[]): Record<string, unknown> {
  return JSON.parse(redactString(JSON.stringify(value), secrets)) as Record<string, unknown>;
}

function redactString(value: string, secrets: string[]) {
  return secrets.reduce((current, secret) => current.replaceAll(secret, "[REDACTED]"), value);
}

function boundedEvent(value: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  return serialized.length <= 64_000
    ? value
    : { truncated: true, payload: `${serialized.slice(0, 63_900)}…` };
}

function agentOutcome(output: string): { output: string; attention?: string } {
  const match = /<facility-needs-attention>([\s\S]*?)<\/facility-needs-attention>\s*$/.exec(output);
  if (!match) return { output };
  const attention = match[1]?.trim();
  if (!attention) return { output };
  return { output: output.slice(0, match.index).trim(), attention };
}
