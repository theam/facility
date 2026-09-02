import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  attentionItems,
  createDb,
  engineSessions,
  githubInstallations,
  migrate,
  orgs,
  projectRepositories,
  projects,
  turnEvents,
  turns,
} from "@facility/db";
import { and, asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCatalogService, type AgentCatalogSource } from "../src/agents/catalog.js";
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { TurnDispatcher } from "../src/turns/dispatcher.js";
import {
  type AgentEngine,
  AgentEngineError,
  AgentEngineRegistry,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "../src/turns/engines.js";
import { recoverInterruptedTurns, recoverQueuedTurns } from "../src/worker.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import {
  ProjectEnvironmentService,
  type ProjectManifestSource,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("turn dispatcher end to end", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; dispatcher tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-dispatcher-"));
  const remotes = join(root, "remotes");
  const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
  const suffix = randomUUID().slice(0, 8);
  const owner = "acme";
  const repository = `app-${suffix}`;
  const orgId = newId("org");
  const projectId = newId("proj");
  const installationRowId = newId("ghi");
  const queuedTurns: string[] = [];
  let rejectEnqueue = false;
  const builder = parseAgentManifest(
    `---
name: builder
description: Implements stories.
engine: codex
model: gpt-5.5
enabled: true
options:
  reasoning_effort: high
triggers:
  - type: manual
---
Implement the request and verify it.
`,
    ".agents/builder.md",
  );
  const projectManifest = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/${owner}/${repository}
  related: []
environment:
  setup: printf setup > .setup-complete
  start: mkdir -p .dev && printf running > .dev/status
  ready: test -f .dev/status
  secrets: [FACILITY_DISPATCH_SECRET]
  services:
    app:
      port: 3000
`);

  class FakeCodexEngine implements AgentEngine {
    readonly name = "codex" as const;
    requests: AgentTurnRequest[] = [];
    outputOverride?: string;
    corruptResumeOnce = false;
    replacementPending = false;
    blockUntilCanceled = false;
    blockingStarted = false;
    observedCancellation = false;
    async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
      this.requests.push(request);
      if (this.corruptResumeOnce && request.nativeSessionId) {
        this.corruptResumeOnce = false;
        this.replacementPending = true;
        throw new AgentEngineError("agent_session_corrupt", "thread not found; cannot resume", {
          events: [
            {
              engine: "codex",
              type: "resume.failed",
              data: { projectSecret: request.environment?.FACILITY_DISPATCH_SECRET },
            },
          ],
        });
      }
      let result: Awaited<ReturnType<FakeWorkspaceRuntime["exec"]>>;
      try {
        if (this.blockUntilCanceled) this.blockingStarted = true;
        result = await runtime.exec(request.workspace, {
          command: "sh",
          args: this.blockUntilCanceled
            ? ["-lc", "printf started > cancellation-marker && sleep 30"]
            : [
                "-lc",
                `printf '%s' ${JSON.stringify(`turn-${this.requests.length}`)} >> agent-work`,
              ],
          cwd: request.cwd,
          signal: request.signal,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "workspace_command_canceled") {
          this.observedCancellation = true;
        }
        throw error;
      }
      const secret = request.environment?.GH_TOKEN ?? "missing";
      const projectSecret = request.environment?.FACILITY_DISPATCH_SECRET ?? "missing";
      const nativeSessionId = this.replacementPending
        ? "codex-replacement-session"
        : (request.nativeSessionId ?? "codex-native-session");
      this.replacementPending = false;
      return {
        nativeSessionId,
        output: this.outputOverride ?? `completed with ${secret} and ${projectSecret}`,
        events: [
          { engine: "codex", type: "item.completed", data: { output: secret, projectSecret } },
        ],
        exitCode: 0,
        stderr: "",
        durationMs: result.durationMs,
      };
    }
  }
  const engine = new FakeCodexEngine();

  let storiesService: StoryWorkspaceService;
  let dispatcher: TurnDispatcher;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await createBareRepository(remotes, owner, repository);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Dispatcher", slug: `dispatcher-${suffix}`, settings: {} });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Dispatcher",
      slug: `dispatcher-${suffix}`,
      settings: {},
    });
    await db.insert(githubInstallations).values({
      id: installationRowId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 20_000,
      accountId: 123,
      accountLogin: owner,
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: newId("repo"),
      orgId,
      projectId,
      installationId: installationRowId,
      owner,
      name: repository,
      defaultBranch: "main",
      role: "primary",
    });
    storiesService = new StoryWorkspaceService(db, runtime, async (turn) => {
      if (rejectEnqueue) throw new Error("queue temporarily unavailable");
      queuedTurns.push(turn.id);
    });
    const catalogSource: AgentCatalogSource = {
      load: async () => ({
        commitSha: "a".repeat(40),
        sources: [{ file: builder.file, source: agentSource(builder.name) }],
      }),
    };
    const manifestSource: ProjectManifestSource = { load: async () => projectManifest };
    dispatcher = new TurnDispatcher(
      db,
      storiesService,
      new AgentCatalogService(db, catalogSource),
      new GithubWorkspaceCredentialBroker(db, async () => ({
        token: "secret-installation-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })),
      manifestSource,
      new ProjectEnvironmentService(db, runtime, `file://${remotes}`, (_projectId, name) =>
        name === "FACILITY_DISPATCH_SECRET" ? "project-secret" : undefined,
      ),
      new AgentEngineRegistry([engine]),
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  it("prepares the environment, executes a turn, persists the native session, and resumes it", async () => {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "github",
      externalId: `issue-${suffix}`,
      title: "Implement persistent workspace",
      agent: builder,
      message: "Implement the first part",
      messageDedupeKey: `start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [{ service: "app", port: 3000 }] },
    });
    const initialTurn = started.queued.turn;
    if (!initialTurn) throw new Error("expected initial queued turn");
    expect(queuedTurns).toEqual([initialTurn.id]);
    const first = await dispatcher.dispatch({ orgId, projectId, turnId: initialTurn.id });
    expect(first).toMatchObject({ claimed: true, state: "succeeded" });
    expect(engine.requests[0]).toMatchObject({ nativeSessionId: undefined });
    expect(engine.requests[0]?.prompt).toContain("Implement the first part");
    expect(
      await db.select().from(engineSessions).where(eq(engineSessions.storyId, started.story.id)),
    ).toHaveLength(1);

    const messages = await storiesService.conversation(orgId, projectId, started.story.id);
    expect(messages.at(-1)).toMatchObject({
      role: "agent",
      body: "completed with [REDACTED] and [REDACTED]",
    });
    const events = await db
      .select()
      .from(turnEvents)
      .where(eq(turnEvents.turnId, initialTurn.id))
      .orderBy(asc(turnEvents.seq));
    expect(JSON.stringify(events)).not.toContain("secret-installation-token");
    expect(JSON.stringify(events)).not.toContain("project-secret");

    const followUp = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "Continue with the second part",
      dedupeKey: `follow-up-${suffix}`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    expect(followUp.turn).toBeDefined();
    if (!followUp.turn) throw new Error("expected follow-up turn");
    await dispatcher.dispatch({ orgId, projectId, turnId: followUp.turn.id });
    expect(engine.requests[1]?.nativeSessionId).toBe("codex-native-session");
    expect(engine.requests[1]?.prompt).toContain("Continue with the second part");
    const firstRequest = engine.requests[0];
    if (!firstRequest) throw new Error("expected first engine request");
    expect(
      await runtime.read(firstRequest.workspace, `repos/${owner}/${repository}/agent-work`),
    ).toBe("turn-1turn-2");
  });

  it("turns an agent wait into typed attention and resolves it when a reply starts", async () => {
    engine.outputOverride =
      "I need one decision.\n\n<facility-needs-attention>Should the migration keep the compatibility view?</facility-needs-attention>";
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "github",
      externalId: `attention-${suffix}`,
      title: "Ask for a migration decision",
      agent: builder,
      message: "Prepare the migration",
      messageDedupeKey: `attention-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    const firstTurn = started.queued.turn;
    if (!firstTurn) throw new Error("expected attention turn");
    await dispatcher.dispatch({ orgId, projectId, turnId: firstTurn.id });
    await expect(storiesService.get(orgId, projectId, started.story.id)).resolves.toMatchObject({
      story: { status: "attention" },
      attention: [
        expect.objectContaining({
          kind: "agent_waiting",
          status: "open",
          detail: "Should the migration keep the compatibility view?",
        }),
      ],
    });
    expect(
      (await storiesService.conversation(orgId, projectId, started.story.id)).at(-1),
    ).toMatchObject({
      body: "I need one decision.",
    });

    engine.outputOverride = undefined;
    const reply = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "No. Keep the 0.12 schema clean.",
      dedupeKey: `attention-reply-${suffix}`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    if (!reply.turn) throw new Error("expected reply turn");
    await dispatcher.dispatch({ orgId, projectId, turnId: reply.turn.id });
    const history = (await storiesService.get(orgId, projectId, started.story.id)).attention;
    expect(history).toEqual([
      expect.objectContaining({ status: "resolved", resolution: "replied" }),
    ]);
  });

  it("claims a turn once even when dispatch is repeated", async () => {
    const rows = await db
      .select()
      .from(turns)
      .where(and(eq(turns.projectId, projectId), eq(turns.state, "succeeded")));
    const completedTurn = rows[0];
    if (!completedTurn) throw new Error("expected completed turn");
    const repeated = await dispatcher.dispatch({ orgId, projectId, turnId: completedTurn.id });
    expect(repeated).toEqual({ claimed: false });
  });

  it("requires an explicit retry before replacing a corrupt native session", async () => {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `corrupt-session-${suffix}`,
      title: "Recover a native session",
      agent: builder,
      message: "Create the initial session",
      messageDedupeKey: `corrupt-session-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected initial turn");
    await dispatcher.dispatch({ orgId, projectId, turnId: started.queued.turn.id });

    engine.corruptResumeOnce = true;
    const followUp = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "Continue after the native session was lost",
      dedupeKey: `corrupt-session-follow-up-${suffix}`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    if (!followUp.turn) throw new Error("expected follow-up turn");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: followUp.turn.id }),
    ).resolves.toMatchObject({ state: "failed" });

    const failed = await storiesService.get(orgId, projectId, started.story.id);
    expect(failed.attention).toEqual([
      expect.objectContaining({ kind: "turn_error", status: "open", turnId: followUp.turn.id }),
    ]);
    expect(failed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: followUp.turn.id,
          type: "engine.resume.failed",
          data: { projectSecret: "[REDACTED]" },
        }),
      ]),
    );
    expect(JSON.stringify(failed)).not.toContain("project-secret");
    expect(
      await db.select().from(engineSessions).where(eq(engineSessions.storyId, started.story.id)),
    ).toEqual([
      expect.objectContaining({ nativeSessionId: "codex-native-session", status: "corrupt" }),
    ]);

    const attention = failed.attention[0];
    if (!attention) throw new Error("expected corrupt-session attention");
    const retry = await storiesService.retryAttention({
      orgId,
      projectId,
      storyId: started.story.id,
      attentionId: attention.id,
      actor: { type: "user", id: "user_test" },
    });
    if (!retry.queued.turn) throw new Error("expected explicit retry turn");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: retry.queued.turn.id }),
    ).resolves.toMatchObject({ state: "succeeded" });

    const sessions = await db
      .select()
      .from(engineSessions)
      .where(eq(engineSessions.storyId, started.story.id))
      .orderBy(asc(engineSessions.createdAt));
    expect(sessions).toEqual([
      expect.objectContaining({ nativeSessionId: "codex-native-session", status: "corrupt" }),
      expect.objectContaining({ nativeSessionId: "codex-replacement-session", status: "active" }),
    ]);
    expect(engine.requests.slice(-2).map((request) => request.nativeSessionId)).toEqual([
      "codex-native-session",
      undefined,
    ]);
    expect(
      (await storiesService.conversation(orgId, projectId, started.story.id)).map(
        (row) => row.body,
      ),
    ).toEqual(
      expect.arrayContaining([
        "Create the initial session",
        "Continue after the native session was lost",
      ]),
    );
  });

  it("cancels a running agent process while preserving the workspace and future turns", async () => {
    engine.blockUntilCanceled = true;
    engine.blockingStarted = false;
    engine.observedCancellation = false;
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `cancel-${suffix}`,
      title: "Cancel a running turn",
      agent: builder,
      message: "Wait until canceled",
      messageDedupeKey: `cancel-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected cancelable turn");
    const dispatching = dispatcher.dispatch({
      orgId,
      projectId,
      turnId: started.queued.turn.id,
    });
    await waitFor(() => engine.blockingStarted);
    const waiting = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "Continue from the queued message",
      dedupeKey: `cancel-waiting-${suffix}`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    expect(waiting).toMatchObject({ queued: true, turn: undefined });
    await storiesService.cancelTurn({
      orgId,
      projectId,
      storyId: started.story.id,
      turnId: started.queued.turn.id,
      actor: { type: "user", id: "user_test" },
    });
    await storiesService.cancelTurn({
      orgId,
      projectId,
      storyId: started.story.id,
      turnId: started.queued.turn.id,
      actor: { type: "user", id: "user_test" },
    });
    await expect(dispatching).resolves.toMatchObject({ state: "canceled" });
    expect(engine.observedCancellation).toBe(true);
    const afterCancellation = await storiesService.get(orgId, projectId, started.story.id);
    expect(afterCancellation).toMatchObject({
      story: { status: "working", activeAgentName: "builder" },
      workspace: { state: "running" },
      attention: [],
    });
    expect(afterCancellation.turns.filter((turn) => turn.state === "canceled")).toHaveLength(1);
    expect(
      afterCancellation.events.filter((event) => event.type === "turn.cancel_requested"),
    ).toHaveLength(1);

    engine.blockUntilCanceled = false;
    const next = afterCancellation.turns.find((turn) => turn.state === "queued");
    if (!next) throw new Error("expected queued successor to be activated");
    await expect(dispatcher.dispatch({ orgId, projectId, turnId: next.id })).resolves.toMatchObject(
      { state: "succeeded" },
    );
  });

  it("keeps a completed turn successful and recovers its queued successor after enqueue failure", async () => {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `queue-recovery-${suffix}`,
      title: "Recover a serialized turn",
      agent: builder,
      message: "Complete the first turn",
      messageDedupeKey: `queue-recovery-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [{ service: "app", port: 3000 }] },
    });
    const firstTurn = started.queued.turn;
    if (!firstTurn) throw new Error("expected first recovery turn");
    await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "Run this after the first turn",
      dedupeKey: `queue-recovery-next-${suffix}`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });

    rejectEnqueue = true;
    const completed = await dispatcher.dispatch({ orgId, projectId, turnId: firstTurn.id });
    rejectEnqueue = false;
    expect(completed).toMatchObject({ claimed: true, state: "succeeded" });
    await expect(storiesService.get(orgId, projectId, started.story.id)).resolves.toMatchObject({
      story: { status: "attention" },
      attention: [expect.objectContaining({ kind: "queued_turn_dispatch_error" })],
    });
    const storyTurns = await db
      .select()
      .from(turns)
      .where(eq(turns.storyId, started.story.id))
      .orderBy(asc(turns.createdAt));
    expect(storyTurns.map((turn) => turn.state)).toEqual(["succeeded", "queued"]);

    const recovered: Array<Record<string, unknown>> = [];
    await recoverQueuedTurns(db, async (queue, data) => {
      if (queue === "turns.dispatch") recovered.push(data);
    });
    expect(recovered).toContainEqual({
      orgId,
      projectId,
      turnId: storyTurns[1]?.id,
    });

    const nextTurnId = storyTurns[1]?.id;
    if (!nextTurnId) throw new Error("expected queued recovery turn");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: nextTurnId }),
    ).resolves.toMatchObject({ claimed: true, state: "succeeded" });
    expect(
      await db.select().from(attentionItems).where(eq(attentionItems.storyId, started.story.id)),
    ).toEqual([
      expect.objectContaining({ kind: "queued_turn_dispatch_error", status: "resolved" }),
    ]);
    await expect(storiesService.get(orgId, projectId, started.story.id)).resolves.toMatchObject({
      story: { status: "working" },
      attention: [
        expect.objectContaining({
          kind: "queued_turn_dispatch_error",
          status: "resolved",
          resolution: "recovered",
        }),
      ],
    });
  });

  it("closes a stale running turn, preserves partial work, and makes it retryable", async () => {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `worker-crash-${suffix}`,
      title: "Recover an interrupted worker",
      agent: builder,
      message: "Persist this message before the engine starts",
      messageDedupeKey: `worker-crash-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    const interrupted = started.queued.turn;
    const workspace = started.workspace;
    if (!interrupted || !workspace?.externalRef) {
      throw new Error("expected an active turn and workspace");
    }
    const locator = {
      id: workspace.id,
      image: "facility-runner:test",
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
    };
    await runtime.exec(locator, {
      command: "sh",
      args: ["-lc", "printf partial > partial-worker-change"],
    });
    const orphan = await runtime.exec(locator, {
      command: "sh",
      args: [
        "-lc",
        'mkdir -p .facility/engine-processes; FACILITY_TURN_ID="$FACILITY_TEST_TURN_ID" sh -c \'exec sleep 30\' >/dev/null 2>&1 & printf \'%s\' "$!" > ".facility/engine-processes/$FACILITY_TEST_TURN_ID.pid"',
      ],
      env: { FACILITY_TEST_TURN_ID: interrupted.id },
    });
    expect(orphan.exitCode, orphan.stderr).toBe(0);
    const orphanPid = Number(
      await runtime.read(locator, `.facility/engine-processes/${interrupted.id}.pid`),
    );
    const now = new Date("2026-09-02T12:00:00.000Z");
    const stale = new Date(now.getTime() - 5 * 60_000);
    await expect(
      storiesService.queueMessage({
        orgId,
        projectId,
        storyId: started.story.id,
        body: "Continue after worker recovery",
        dedupeKey: `worker-crash-follow-up-${suffix}`,
        agent: builder,
        actor: { type: "user", id: "user_test" },
        trigger: { type: "manual" },
      }),
    ).resolves.toMatchObject({ queued: true, turn: undefined });
    await db
      .update(turns)
      .set({ state: "running", startedAt: stale, updatedAt: stale })
      .where(eq(turns.id, interrupted.id));

    await expect(
      recoverInterruptedTurns(db, storiesService, now, 60_000, (turn) =>
        dispatcher.activateQueuedSuccessor(turn),
      ),
    ).resolves.toBe(1);
    await expect(recoverInterruptedTurns(db, storiesService, now, 60_000)).resolves.toBe(0);
    if (Number.isInteger(orphanPid)) {
      try {
        process.kill(orphanPid, "SIGTERM");
      } catch {
        // The test process may already have exited.
      }
    }
    expect(await runtime.read(locator, "partial-worker-change")).toBe("partial");
    const recovered = await storiesService.get(orgId, projectId, started.story.id);
    expect(recovered).toMatchObject({
      story: { status: "working", activeAgentName: "builder" },
      workspace: { id: workspace.id, state: "running" },
      turns: expect.arrayContaining([
        expect.objectContaining({ id: interrupted.id, state: "failed" }),
        expect.objectContaining({ state: "queued" }),
      ]),
      attention: [expect.objectContaining({ kind: "worker_interrupted", status: "open" })],
    });
    expect(recovered.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: interrupted.id,
          type: "turn.worker_interrupted",
          // Linux workspaces can verify the marker against /proc before stopping
          // the orphan. Other test hosts deliberately refuse to kill a PID they
          // cannot identify safely.
          data: { processCleanup: process.platform === "linux" ? "stopped" : "stale-marker" },
        }),
      ]),
    );
    const successor = recovered.turns.find((turn) => turn.state === "queued");
    if (!successor) throw new Error("expected queued successor after worker recovery");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: successor.id }),
    ).resolves.toMatchObject({ state: "succeeded" });
    const attention = recovered.attention[0];
    if (!attention) throw new Error("expected interrupted-worker attention");
    const retry = await storiesService.retryAttention({
      orgId,
      projectId,
      storyId: started.story.id,
      attentionId: attention.id,
      actor: { type: "user", id: "user_test" },
    });
    if (!retry.queued.turn) throw new Error("expected retry turn");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: retry.queued.turn.id }),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(
      (await storiesService.conversation(orgId, projectId, started.story.id)).map(
        (message) => message.body,
      ),
    ).toEqual(expect.arrayContaining(["Persist this message before the engine starts"]));
  });
});

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before timeout");
}

function agentSource(name: string) {
  return `---
name: ${name}
description: Implements stories.
engine: codex
model: gpt-5.5
enabled: true
options:
  reasoning_effort: high
triggers:
  - type: manual
---
Implement the request and verify it.
`;
}

async function createBareRepository(root: string, owner: string, name: string) {
  const bare = join(root, owner, `${name}.git`);
  const work = join(root, "seed", name);
  await mkdir(join(root, owner), { recursive: true });
  await mkdir(work, { recursive: true });
  await command("git", ["init", "--bare", "--initial-branch=main", bare]);
  await command("git", ["init", "--initial-branch=main"], work);
  await writeFile(join(work, "README.md"), "# dispatcher\n");
  await command("git", ["add", "README.md"], work);
  await command(
    "git",
    [
      "-c",
      "user.name=Facility Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ],
    work,
  );
  await command("git", ["remote", "add", "origin", bare], work);
  await command("git", ["push", "origin", "main"], work);
}

async function command(executable: string, args: string[], cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    execFile(executable, args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve();
    });
  });
}
