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
import type { StoryWorkspaceService } from "../stories/service.js";
import type {
  ProjectEnvironmentService,
  ProjectManifestSource,
} from "../workspaces/project-environment.js";
import type { WorkspaceLocator } from "../workspaces/runtime.js";
import type { AgentEngineRegistry } from "./engines.js";
import { appendTurnEvent } from "./events.js";

export class TurnDispatcher {
  constructor(
    private readonly db: FacilityDb,
    private readonly storiesService: StoryWorkspaceService,
    private readonly catalog: AgentCatalogService,
    private readonly credentials: GithubWorkspaceCredentialBroker,
    private readonly projectManifests: ProjectManifestSource,
    private readonly environment: ProjectEnvironmentService,
    private readonly engines: AgentEngineRegistry,
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
    if (!turn) return { claimed: false as const };

    const eventBase = {
      orgId: input.orgId,
      projectId: input.projectId,
      storyId: turn.storyId,
      turnId: turn.id,
    };
    try {
      await this.storiesService.resolveAttention({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: turn.storyId,
        kind: "queued_turn_dispatch_error",
      });
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
      const result = await this.engines.get(manifest.engine).run({
        manifest,
        workspace: workspaceLocator(workspace),
        prompt: buildPrompt(manifest, story, conversation.summary, messages, turn.id),
        cwd: prepared.primaryCwd,
        nativeSessionId: session?.nativeSessionId,
        environment: credential.environment,
      });
      const secrets = credentialSecrets(credential.environment);
      for (const event of result.events) {
        await appendTurnEvent(this.db, {
          ...eventBase,
          type: `engine.${event.type}`,
          data: boundedEvent(redact(event.data, secrets)),
        });
      }
      await this.persistSession({
        orgId: input.orgId,
        projectId: input.projectId,
        storyId: story.id,
        workspaceId: workspace.id,
        turnId: turn.id,
        manifest,
        nativeSessionId: result.nativeSessionId,
        existingId: session?.id,
      });
      await this.storiesService.completeTurn({
        orgId: input.orgId,
        projectId: input.projectId,
        turnId: turn.id,
        output: redactString(
          result.output || `${manifest.name} completed without a text response.`,
          secrets,
        ),
        actor: { type: "system", id: `${manifest.engine}:${result.nativeSessionId}` },
      });
      await appendTurnEvent(this.db, {
        ...eventBase,
        type: "turn.succeeded",
        data: { durationMs: result.durationMs },
      });
      const next = await this.nextQueuedMessage(input.orgId, input.projectId, story.id);
      if (next?.requestedAgentName) {
        try {
          const projected = await this.catalog.get(
            input.orgId,
            input.projectId,
            next.requestedAgentName,
          );
          await this.storiesService.activateNextMessage({
            orgId: input.orgId,
            projectId: input.projectId,
            storyId: story.id,
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
            storyId: story.id,
            turnId: turn.id,
            kind: "queued_turn_dispatch_error",
            title: `Could not dispatch queued ${next.requestedAgentName} turn`,
            detail,
          });
          await appendTurnEvent(this.db, {
            ...eventBase,
            type: "queue.activation_failed",
            data: { agentName: next.requestedAgentName, error: detail.slice(0, 8_000) },
          });
        }
      }
      return { claimed: true as const, state: "succeeded" as const, result };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.storiesService.failTurn({ ...input, error: detail });
      await appendTurnEvent(this.db, {
        ...eventBase,
        type: "turn.failed",
        data: { error: detail.slice(0, 8_000) },
      });
      return { claimed: true as const, state: "failed" as const, error: detail };
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
      id: newId("esess"),
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

function buildPrompt(
  manifest: AgentManifest,
  story: typeof stories.$inferSelect,
  summary: string | null,
  messages: Array<typeof storyMessages.$inferSelect>,
  turnId: string,
) {
  const currentSequence = messages.find(
    (message) => message.turnId === turnId && message.role === "user",
  )?.seq;
  const relevant = messages.filter(
    (message) => currentSequence === undefined || message.seq <= currentSequence,
  );
  const transcript = relevant
    .map(
      (message) => `${message.role.toUpperCase()} (${actorLabel(message.actor)}):\n${message.body}`,
    )
    .join("\n\n");
  return [
    manifest.prompt,
    `# Story\n${story.title}\nExternal identity: ${story.provider}:${story.externalId}`,
    summary ? `# Conversation summary\n${summary}` : "",
    `# Shared conversation\n${truncateStart(transcript, 120_000)}`,
    "Continue in the existing worktree. You have full workspace, network, Docker, browser, git, and GitHub maintainer access. Preserve useful uncommitted work. Commit and push coherent changes when the task calls for it. Never merge the pull request or publish packages.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function actorLabel(actor: unknown) {
  if (!actor || typeof actor !== "object") return "unknown";
  const value = actor as { type?: unknown; id?: unknown };
  return `${String(value.type ?? "unknown")}:${String(value.id ?? "unknown")}`;
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

function credentialSecrets(environment: Record<string, string>) {
  const secrets = new Set<string>();
  if (environment.GH_TOKEN) secrets.add(environment.GH_TOKEN);
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

function truncateStart(value: string, limit: number) {
  return value.length <= limit ? value : `[Earlier transcript omitted]\n${value.slice(-limit)}`;
}
