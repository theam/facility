import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  attentionItems,
  budgetReservations,
  createDb,
  engineSessions,
  githubInstallations,
  migrate,
  orgs,
  projectBudgets,
  projectRepositories,
  projects,
  storyEvidenceEvents,
  turnEvents,
  turnGitEvidence,
  turns,
  turnUsage,
  workspaces,
} from "@facility/db";
import { and, asc, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentCatalogService, type AgentCatalogSource } from "../src/agents/catalog.js";
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import { CostBudgetService } from "../src/insights/costs.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { TurnDispatcher } from "../src/turns/dispatcher.js";
import {
  type AgentEngine,
  AgentEngineError,
  AgentEngineRegistry,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "../src/turns/engines.js";
import { TurnGitEvidenceService } from "../src/turns/git-evidence.js";
import { LiveTurnEvents } from "../src/turns/live-events.js";
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
  const budgetHandoffRepositories = new Map<string, string>();
  let rejectEnqueue = false;
  let credentialFailure: unknown;
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

  const reviewer = parseAgentManifest(agentSource("pr-reviewer"), ".agents/pr-reviewer.md");

  class FakeCodexEngine implements AgentEngine {
    readonly name = "codex" as const;
    requests: AgentTurnRequest[] = [];
    outputOverride?: string;
    renameNextBranch?: string;
    corruptResumeOnce = false;
    failNextRun = false;
    liveFailureGate?: Promise<void>;
    throttleDuringRun = false;
    replacementPending = false;
    blockUntilCanceled = false;
    blockingStarted = false;
    observedCancellation = false;
    async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
      this.requests.push(request);
      if (this.liveFailureGate) {
        const gate = this.liveFailureGate;
        this.liveFailureGate = undefined;
        const events = [
          {
            engine: "codex" as const,
            type: "thread.started",
            data: { thread_id: "native-before-failure" },
          },
          {
            engine: "codex" as const,
            type: "item.completed",
            data: { message: request.environment?.FACILITY_DISPATCH_SECRET },
          },
        ];
        for (const event of events) request.onEvent?.(event);
        await gate;
        throw new AgentEngineError("agent_observation_failed", "Workspace session lost", {
          events,
          failure: {
            category: "workspace_session_lost",
            httpStatus: 410,
            responseBody: "provider-private-secret",
          },
        });
      }
      if (this.throttleDuringRun) {
        this.throttleDuringRun = false;
        throw Object.assign(new Error("API rate limit exceeded after execution began"), {
          status: 429,
        });
      }
      if (this.failNextRun) {
        this.failNextRun = false;
        throw new AgentEngineError("agent_engine_failed", "codex exited with status 1", {
          engine: "codex",
          exitCode: 1,
          events: [
            {
              engine: "codex",
              type: "result.error",
              data: {
                error: "authentication_failed",
                message: "API key is invalid.",
                projectSecret: request.environment?.FACILITY_DISPATCH_SECRET,
              },
            },
          ],
        });
      }
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
      if (this.renameNextBranch) {
        const branch = this.renameNextBranch;
        this.renameNextBranch = undefined;
        const renamed = await runtime.exec(request.workspace, {
          command: "git",
          args: ["branch", "-m", branch],
          cwd: request.cwd,
        });
        if (renamed.exitCode !== 0) throw new Error("branch rename failed");
      }
      // This fixture exercises redaction; real gh execution has dedicated integration coverage.
      const credentialDirectory = request.environment?.GH_CONFIG_DIR;
      if (!credentialDirectory)
        throw new Error("renewable GitHub credential scope was unavailable");
      const secret = JSON.parse(await readFile(join(credentialDirectory, "hosts.yml"), "utf8"))[
        "github.com"
      ].oauth_token;
      const projectSecret = request.environment?.FACILITY_DISPATCH_SECRET ?? "missing";
      const nativeSessionId = this.replacementPending
        ? "codex-replacement-session"
        : (request.nativeSessionId ??
          (request.manifest.name === "builder"
            ? "codex-native-session"
            : `codex-${request.manifest.name}-session`));
      this.replacementPending = false;
      return {
        nativeSessionId,
        output: this.outputOverride ?? `completed with ${secret} and ${projectSecret}`,
        progress: [],
        events: [
          {
            engine: "codex",
            type: "item.completed",
            data: {
              output: secret,
              projectSecret,
              exitCode: 0,
              ok: true,
              configured: `0 true a"b`,
            },
          },
        ],
        exitCode: 0,
        stderr: "",
        durationMs: result.durationMs,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
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
        sources: [builder, reviewer].map((agent) => ({
          file: agent.file,
          source: agentSource(agent.name),
        })),
      }),
    };
    const manifestSource: ProjectManifestSource = {
      load: async (_orgId, requestedProjectId) => {
        const isolatedRepository = budgetHandoffRepositories.get(requestedProjectId);
        return isolatedRepository
          ? parseProjectManifest(`
version: 1
repositories:
  primary: github.com/${owner}/${isolatedRepository}
  related: []
environment:
  setup: printf setup > .setup-complete
  start: mkdir -p .dev && printf running > .dev/status
  ready: test -f .dev/status
  secrets: [FACILITY_DISPATCH_SECRET]
`)
          : projectManifest;
      },
    };
    dispatcher = new TurnDispatcher(
      db,
      storiesService,
      new AgentCatalogService(db, catalogSource),
      new GithubWorkspaceCredentialBroker(db, async () => {
        if (credentialFailure) throw credentialFailure;
        return {
          gitIdentity: { name: "my-app[bot]", email: "12345+my-app[bot]@users.noreply.github.com" },
          token: "secret-installation-token",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      }),
      manifestSource,
      new ProjectEnvironmentService(
        db,
        runtime,
        `file://${remotes}`,
        (_projectId, name) => (name === "FACILITY_DISPATCH_SECRET" ? "project-secret" : undefined),
        async () => ({ SHORT_VALUE: "0", FLAG_VALUE: "true", QUOTED_VALUE: 'a"b' }),
      ),
      new AgentEngineRegistry([engine]),
      new TurnGitEvidenceService(db, runtime),
      undefined,
      runtime,
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
    if (!started.workspace) throw new Error("expected story workspace");
    const gitEvidence = (
      await db.select().from(turnGitEvidence).where(eq(turnGitEvidence.turnId, initialTurn.id))
    )[0];
    expect(gitEvidence).toMatchObject({
      workspaceId: started.workspace.id,
      initialSha: expect.stringMatching(/^[a-f0-9]{40}$/),
      finalSha: expect.stringMatching(/^[a-f0-9]{40}$/),
      dirty: true,
      captureError: null,
    });
    expect(gitEvidence?.changedFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "?", path: "agent-work" })]),
    );
    const session = (
      await db.select().from(engineSessions).where(eq(engineSessions.storyId, started.story.id))
    )[0];
    expect(gitEvidence?.engineSessionId).toBe(session?.id);
    expect(
      await db
        .select({ type: storyEvidenceEvents.type, turnId: storyEvidenceEvents.turnId })
        .from(storyEvidenceEvents)
        .where(eq(storyEvidenceEvents.turnId, initialTurn.id))
        .orderBy(asc(storyEvidenceEvents.occurredAt)),
    ).toEqual([
      { type: "turn.context_recorded", turnId: initialTurn.id },
      { type: "git.changes_recorded", turnId: initialTurn.id },
    ]);
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, initialTurn.id))).toEqual([
      expect.objectContaining({
        agentName: "builder",
        engine: "codex",
        model: "gpt-5.5",
        inputTokens: 100,
        outputTokens: 20,
        priced: true,
        source: "price_book",
        status: "succeeded",
      }),
    ]);
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
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            exitCode: 0,
            ok: true,
            configured: "[REDACTED] [REDACTED] [REDACTED]",
          }),
        }),
      ]),
    );

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

  it("blocks an exhausted project budget before invoking the agent engine", async () => {
    await db
      .insert(projectBudgets)
      .values({
        id: newId("bud"),
        orgId,
        projectId,
        monthlyLimitCents: 0,
        warningPercent: 80,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: projectBudgets.projectId,
        set: { monthlyLimitCents: 0, enabled: true },
      });
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `budget-${suffix}`,
      title: "Respect the project budget",
      agent: builder,
      message: "This must not reach the provider",
      messageDedupeKey: `budget-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected budget turn");
    const requestsBefore = engine.requests.length;

    const dispatch = await dispatcher.dispatch({
      orgId,
      projectId,
      turnId: started.queued.turn.id,
    });
    await db
      .update(projectBudgets)
      .set({ enabled: false })
      .where(eq(projectBudgets.projectId, projectId));

    expect(dispatch).toMatchObject({ claimed: true, state: "failed" });
    expect(engine.requests).toHaveLength(requestsBefore);
    expect(
      await db.select().from(turnUsage).where(eq(turnUsage.turnId, started.queued.turn.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.turnId, started.queued.turn.id)),
    ).toEqual([]);
    await expect(storiesService.get(orgId, projectId, started.story.id)).resolves.toMatchObject({
      story: { status: "attention" },
      attention: [
        expect.objectContaining({
          kind: "turn_error",
          status: "open",
          detail: expect.stringContaining("monthly budget is exhausted"),
        }),
      ],
    });
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

  it("carries the asked question into a prompt rebuilt for a different agent", async () => {
    const reviewer = parseAgentManifest(
      `---
name: reviewer
description: Reviews stories.
engine: codex
model: gpt-5.5-codex
enabled: true
triggers:
  - type: manual
---
Review the request.
`,
      ".agents/reviewer.md",
    );
    engine.outputOverride =
      "Blocked on one decision.\n\n<facility-needs-attention>Should existing JSON exports remain available?</facility-needs-attention>";
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "github",
      externalId: `handoff-${suffix}`,
      title: "Decide the export policy",
      agent: builder,
      message: "Plan the export change",
      messageDedupeKey: `handoff-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    const askingTurn = started.queued.turn;
    if (!askingTurn) throw new Error("expected the asking turn");
    await dispatcher.dispatch({ orgId, projectId, turnId: askingTurn.id });

    engine.outputOverride = undefined;
    // A different agent has no engine session of its own, so the engine is handed a
    // rebuilt prompt rather than resuming native context.
    const reply = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "No, continue.",
      dedupeKey: `handoff-reply-${suffix}`,
      agent: reviewer,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    if (!reply.turn) throw new Error("expected the reply turn");
    await dispatcher.dispatch({ orgId, projectId, turnId: reply.turn.id });

    const rebuilt = engine.requests.at(-1);
    expect(rebuilt?.nativeSessionId).toBeUndefined();
    expect(rebuilt?.prompt).toContain("Should existing JSON exports remain available?");
    expect(rebuilt?.prompt).toContain("No, continue.");
    // The question belongs to the agent turn that asked it, once.
    expect(rebuilt?.prompt.match(/Should existing JSON exports remain available\?/g)?.length).toBe(
      1,
    );
    const askedIndex =
      rebuilt?.prompt.indexOf("Should existing JSON exports remain available?") ?? -1;
    const repliedIndex = rebuilt?.prompt.indexOf("No, continue.") ?? -1;
    expect(askedIndex).toBeGreaterThan(-1);
    expect(repliedIndex).toBeGreaterThan(askedIndex);
  });

  it("retains a predecessor question before a completed turn becomes available to a successor", async () => {
    const freshReviewer = parseAgentManifest(
      agentSource("race-reviewer"),
      ".agents/race-reviewer.md",
    );
    let attentionEntered!: () => void;
    let releaseAttention!: () => void;
    const entered = new Promise<void>((resolve) => {
      attentionEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAttention = resolve;
    });
    const originalComplete = storiesService.completeTurn.bind(storiesService);
    let held = false;
    const flag = vi.spyOn(storiesService, "completeTurn").mockImplementation(async (input) => {
      const result = await originalComplete(input);
      if (!held) {
        held = true;
        attentionEntered();
        await gate;
      }
      return result;
    });
    engine.outputOverride =
      "One decision is required.\n<facility-needs-attention>RACE_QUESTION: Keep existing JSON exports?</facility-needs-attention>";
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "github",
      externalId: `race-${suffix}`,
      title: "Question persistence race",
      agent: builder,
      message: "Plan the export change",
      messageDedupeKey: `race-start-${suffix}`,
      actor: { type: "user", id: "review_fixture" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected asking turn");
    const asking = dispatcher.dispatch({ orgId, projectId, turnId: started.queued.turn.id });
    let observedPrompt: string | undefined;
    let observedSession: string | undefined;
    try {
      await entered;
      engine.outputOverride = undefined;
      const reply = await storiesService.queueMessage({
        orgId,
        projectId,
        storyId: started.story.id,
        body: "No, continue.",
        dedupeKey: `race-reply-${suffix}`,
        agent: freshReviewer,
        actor: { type: "user", id: "review_fixture" },
        trigger: { type: "manual" },
      });
      if (!reply.turn) throw new Error("expected successor turn after predecessor success");
      expect(await dispatcher.dispatch({ orgId, projectId, turnId: reply.turn.id })).toMatchObject({
        state: "succeeded",
      });
      observedPrompt = engine.requests.at(-1)?.prompt;
      observedSession = engine.requests.at(-1)?.nativeSessionId;
    } finally {
      releaseAttention();
      await asking;
      flag.mockRestore();
    }
    const notices = await db
      .select()
      .from(attentionItems)
      .where(
        and(eq(attentionItems.storyId, started.story.id), eq(attentionItems.kind, "agent_waiting")),
      );
    expect(observedPrompt).toContain("RACE_QUESTION");
    expect(observedSession).toBeUndefined();
    expect(notices.every((notice) => notice.status === "resolved")).toBe(true);
  });

  it("redacts retained blocking-question detail before cross-agent reconstruction", async () => {
    const freshReviewer = parseAgentManifest(
      agentSource("redaction-reviewer"),
      ".agents/redaction-reviewer.md",
    );
    engine.outputOverride =
      "One decision.\n<facility-needs-attention>QUESTION_REDACTION: May project-secret and secret-installation-token be used?</facility-needs-attention>";
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "github",
      externalId: `question-redaction-${suffix}`,
      title: "Question redaction",
      agent: builder,
      message: "Plan the change",
      messageDedupeKey: `redaction-start-${suffix}`,
      actor: { type: "user", id: "review_fixture" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected asking turn");
    expect(
      await dispatcher.dispatch({ orgId, projectId, turnId: started.queued.turn.id }),
    ).toMatchObject({ state: "succeeded" });
    engine.outputOverride = undefined;
    const reply = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "No, continue.",
      dedupeKey: `redaction-reply-${suffix}`,
      agent: freshReviewer,
      actor: { type: "user", id: "review_fixture" },
      trigger: { type: "manual" },
    });
    if (!reply.turn) throw new Error("expected reply turn");
    expect(await dispatcher.dispatch({ orgId, projectId, turnId: reply.turn.id })).toMatchObject({
      state: "succeeded",
    });
    const rebuilt = engine.requests.at(-1);
    expect(rebuilt?.nativeSessionId).toBeUndefined();
    expect(rebuilt?.prompt).toContain("QUESTION_REDACTION: May [REDACTED] and [REDACTED] be used?");
    expect(rebuilt?.prompt).not.toContain("project-secret");
    expect(rebuilt?.prompt).not.toContain("secret-installation-token");
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
          data: { projectSecret: "[REDACTED]", facilityEventIndex: 0 },
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

  it("passes the builder handoff to a queued reviewer without exposing a later request", async () => {
    const handoff = "Implementation complete; integration tests could not run.";
    const reviewRequest = "Review the builder result and its verification limitations.";
    const futureRequest = "FUTURE REQUEST: implement an unrelated feature.";
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `queued-review-${suffix}`,
      title: "Review a queued builder result",
      agent: builder,
      message: "Implement the requested change.",
      messageDedupeKey: `queued-review-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected builder turn");

    const queuedReview = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: reviewRequest,
      dedupeKey: `queued-review-message-${suffix}`,
      agent: reviewer,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    expect(queuedReview).toMatchObject({ queued: true, turn: undefined });
    await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: futureRequest,
      dedupeKey: `queued-future-message-${suffix}`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });

    engine.outputOverride = handoff;
    try {
      await expect(
        dispatcher.dispatch({ orgId, projectId, turnId: started.queued.turn.id }),
      ).resolves.toMatchObject({ state: "succeeded" });
    } finally {
      engine.outputOverride = undefined;
    }
    expect(engine.requests.at(-1)?.prompt).not.toContain(reviewRequest);
    expect(engine.requests.at(-1)?.prompt).not.toContain(futureRequest);

    const afterBuilder = await storiesService.get(orgId, projectId, started.story.id);
    const next = afterBuilder.turns.find((turn) => turn.state === "queued");
    if (!next) throw new Error("expected queued reviewer turn");
    expect(next.agentName).toBe(reviewer.name);
    await expect(dispatcher.dispatch({ orgId, projectId, turnId: next.id })).resolves.toMatchObject(
      { state: "succeeded" },
    );

    const request = engine.requests.at(-1);
    expect(request?.nativeSessionId).toBeUndefined();
    expect(request?.manifest.name).toBe(reviewer.name);
    expect(request?.prompt).toContain(handoff);
    expect(request?.prompt).toContain(reviewRequest);
    expect(request?.prompt).not.toContain(futureRequest);
    expect(request?.prompt.indexOf(handoff)).toBeLessThan(
      request?.prompt.indexOf(reviewRequest) ?? -1,
    );
    const afterReview = await storiesService.get(orgId, projectId, started.story.id);
    const futureTurn = afterReview.turns.find((turn) => turn.state === "queued");
    if (!futureTurn) throw new Error("expected future request to remain queued");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: futureTurn.id }),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(engine.requests.at(-1)?.prompt).toContain(futureRequest);
  });

  it.each([
    "wake",
    "prepare",
  ] as const)("suspends retained compute when %s fails after a sleeping workspace resumes", async (phase) => {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `resume-${phase}-${suffix}`,
      title: "Recover a retained workspace",
      agent: builder,
      message: "Continue the retained work",
      messageDedupeKey: `resume-${phase}-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    const workspace = started.workspace;
    const turn = started.queued.turn;
    if (!workspace?.externalRef || !turn) throw new Error("expected workspace and turn");
    const locator = {
      id: workspace.id,
      image: "facility-runner:test",
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
    };
    await runtime.exec(locator, {
      command: "sh",
      args: ["-lc", "printf retained > retained-work"],
    });
    await runtime.suspend(locator);
    await db.update(workspaces).set({ state: "sleeping" }).where(eq(workspaces.id, workspace.id));
    const requestsBefore = engine.requests.length;
    const originalWake = runtime.wake.bind(runtime);
    const failure =
      phase === "wake"
        ? vi.spyOn(runtime, "wake").mockImplementationOnce(async (input) => {
            await originalWake(input);
            throw new Error("wake acknowledgement lost");
          })
        : vi
            .spyOn(ProjectEnvironmentService.prototype, "prepare")
            .mockRejectedValueOnce(new Error("setup failed"));
    try {
      await expect(
        dispatcher.dispatch({ orgId, projectId, turnId: turn.id }),
      ).resolves.toMatchObject({ state: "failed" });
      expect(engine.requests).toHaveLength(requestsBefore);
      expect((await storiesService.get(orgId, projectId, started.story.id)).workspace?.state).toBe(
        "sleeping",
      );
      expect((await runtime.inspect(locator)).state).toBe("sleeping");
      expect((await runtime.read(locator, "retained-work")).toString()).toBe("retained");
    } finally {
      failure.mockRestore();
    }
  });

  it("closes a failed turn even when its final telemetry flush fails", async () => {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `flush-failure-${suffix}`,
      title: "Retain the primary failure",
      agent: builder,
      message: "Implement the change",
      messageDedupeKey: `flush-failure-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected turn");
    engine.failNextRun = true;
    const original = LiveTurnEvents.prototype.finish;
    const finish = vi.spyOn(LiveTurnEvents.prototype, "finish").mockImplementation(async function (
      this: LiveTurnEvents,
      events,
    ) {
      await original.call(this, events);
      throw new Error("telemetry unavailable");
    });
    try {
      await expect(
        dispatcher.dispatch({ orgId, projectId, turnId: started.queued.turn.id }),
      ).resolves.toMatchObject({ state: "failed" });
      const current = await storiesService.get(orgId, projectId, started.story.id);
      expect(current.turns.find((turn) => turn.id === started.queued.turn?.id)?.state).toBe(
        "failed",
      );
      expect(current.workspace?.state).toBe("sleeping");
    } finally {
      finish.mockRestore();
    }
  });

  it("records engine events when a turn fails, with project secrets redacted", async () => {
    engine.failNextRun = true;
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `engine-failure-${suffix}`,
      title: "Surface the engine failure",
      agent: builder,
      message: "Plan the change",
      messageDedupeKey: `engine-failure-start-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected initial turn");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: started.queued.turn.id }),
    ).resolves.toMatchObject({ state: "failed" });

    const failed = await storiesService.get(orgId, projectId, started.story.id);
    expect(failed.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turnId: started.queued.turn.id,
          type: "engine.result.error",
          data: {
            error: "authentication_failed",
            message: "API key is invalid.",
            projectSecret: "[REDACTED]",
            facilityEventIndex: 0,
          },
        }),
        expect.objectContaining({ turnId: started.queued.turn.id, type: "turn.failed" }),
      ]),
    );
    expect(JSON.stringify(failed)).not.toContain("project-secret");
  });

  it("checkpoints redacted progress and session before failure, then resumes without replaying saved events", async () => {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: `live-recovery-${suffix}`,
      title: "Recover streamed context",
      agent: builder,
      message: "Continue work",
      messageDedupeKey: `live-recovery-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected turn");
    let release: (() => void) | undefined;
    engine.liveFailureGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const turnId = started.queued.turn.id;
    const transact = db.transaction.bind(db);
    let lostAcknowledgement = false;
    const transaction = vi.spyOn(db, "transaction").mockImplementation(async (...args) => {
      const result = await transact(...args);
      const saved = await db.select().from(turnEvents).where(eq(turnEvents.turnId, turnId));
      if (!lostAcknowledgement && saved.some((event) => event.type.startsWith("engine."))) {
        lostAcknowledgement = true;
        throw new Error("commit acknowledgement lost");
      }
      return result;
    });
    const dispatch = dispatcher.dispatch({ orgId, projectId, turnId });
    try {
      await vi.waitFor(
        async () => {
          const stored = await db.select().from(turnEvents).where(eq(turnEvents.turnId, turnId));
          expect(stored.filter((e) => e.type.startsWith("engine."))).toHaveLength(2);
          expect(JSON.stringify(stored)).not.toContain("project-secret");
          const session = await db
            .select()
            .from(engineSessions)
            .where(eq(engineSessions.storyId, started.story.id));
          expect(session[0]?.nativeSessionId).toBe("native-before-failure");
          const turn = await db.select().from(turns).where(eq(turns.id, turnId));
          expect(turn[0]?.state).toBe("running");
        },
        { timeout: 10000 },
      );
    } finally {
      release?.();
    }
    await expect(dispatch).resolves.toMatchObject({ state: "failed" });
    transaction.mockRestore();
    expect(lostAcknowledgement).toBe(true);
    const saved = await db.select().from(turnEvents).where(eq(turnEvents.turnId, turnId));
    expect(saved.filter((e) => e.type.startsWith("engine."))).toHaveLength(2);
    expect(JSON.stringify(saved)).not.toContain("provider-private-secret");
    expect(saved.find((e) => e.type === "turn.failed")?.data).toMatchObject({
      failure: { category: "workspace_session_lost", httpStatus: 410 },
    });
    const next = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "Continue from retained work",
      dedupeKey: `resume-live-${suffix}`,
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    if (!next.turn) throw new Error("expected continuation");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: next.turn.id }),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(engine.requests.at(-1)?.nativeSessionId).toBe("native-before-failure");
  }, 15_000);

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
      (afterCancellation.events ?? []).filter((event) => event.type === "turn.cancel_requested"),
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

  it("keeps the agent's renamed branch and native workspace on the next turn", async () => {
    const branch = `chore/retained-${randomUUID()}`;
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "github",
      externalId: `rename-${randomUUID()}`,
      title: "Follow repository branch rules",
      agent: builder,
      message: "Rename the branch",
      messageDedupeKey: randomUUID(),
      actor: { type: "user", id: "test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("missing turn");
    engine.renameNextBranch = branch;
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: started.queued.turn.id }),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect((await storiesService.get(orgId, projectId, started.story.id)).story.branch).toBe(
      branch,
    );
    const firstRequest = engine.requests.at(-1);
    if (!firstRequest) throw new Error("missing request");
    const next = await storiesService.queueMessage({
      orgId,
      projectId,
      storyId: started.story.id,
      body: "Continue on the same branch",
      dedupeKey: randomUUID(),
      agent: builder,
      actor: { type: "user", id: "test" },
      trigger: { type: "manual" },
    });
    if (!next.turn) throw new Error("missing next turn");
    await expect(
      dispatcher.dispatch({ orgId, projectId, turnId: next.turn.id }),
    ).resolves.toMatchObject({ state: "succeeded" });
    const request = engine.requests.at(-1);
    expect(request?.workspace.id).toBe(firstRequest.workspace.id);
    expect(request?.nativeSessionId).toBe("codex-native-session");
    const actual = await runtime.exec(firstRequest.workspace, {
      command: "git",
      args: ["branch", "--show-current"],
      cwd: firstRequest.cwd,
    });
    expect(actual.stdout.trim()).toBe(branch);
  });
  async function startAdmissionStory() {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: randomUUID(),
      title: "Recover provider admission",
      agent: builder,
      message: "Run after provider capacity recovers",
      messageDedupeKey: randomUUID(),
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected queued admission turn");
    return { storyId: started.story.id, turnId: started.queued.turn.id, orgId, projectId };
  }

  it("durably defers throttled admission, rejects early and cross-tenant claims, then runs the same turn once", async () => {
    const input = await startAdmissionStory();
    const before = engine.requests.length;
    credentialFailure = Object.assign(new Error("API rate limit exceeded"), {
      status: 403,
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
        },
      },
    });
    try {
      await expect(dispatcher.dispatch(input)).resolves.toMatchObject({
        claimed: true,
        state: "queued",
        retryAfter: expect.any(Date),
      });
      expect(engine.requests).toHaveLength(before);
      const [deferred] = await db.select().from(turns).where(eq(turns.id, input.turnId));
      expect(deferred).toMatchObject({
        state: "queued",
        error: null,
        startedAt: null,
        scheduledFor: null,
      });
      expect(deferred?.retryAfter?.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
      await expect(dispatcher.dispatch(input)).resolves.toEqual({ claimed: false });
      const enqueued: unknown[] = [];
      await recoverQueuedTurns(db, async (_queue, data) => {
        if (data.turnId === input.turnId) enqueued.push(data);
      });
      expect(enqueued).toEqual([]);
      expect(
        await db.select().from(attentionItems).where(eq(attentionItems.turnId, input.turnId)),
      ).toEqual([]);
      expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual(
        [],
      );
      await db
        .update(turns)
        .set({ retryAfter: new Date(Date.now() - 1_000) })
        .where(eq(turns.id, input.turnId));
      await expect(dispatcher.dispatch({ ...input, orgId: "org_other" })).resolves.toEqual({
        claimed: false,
      });
      credentialFailure = undefined;
      await recoverQueuedTurns(db, async (_queue, data) => {
        if (data.turnId === input.turnId) enqueued.push(data);
      });
      expect(enqueued).toHaveLength(1);
      await expect(dispatcher.dispatch(input)).resolves.toMatchObject({ state: "succeeded" });
      await expect(dispatcher.dispatch(input)).resolves.toEqual({ claimed: false });
      expect(engine.requests).toHaveLength(before + 1);
    } finally {
      credentialFailure = undefined;
    }
  });

  it.each([
    401, 403,
  ])("fails admission denied with HTTP %s instead of repeatedly deferring it", async (status) => {
    const input = await startAdmissionStory();
    credentialFailure = Object.assign(new Error("access revoked"), { status });
    const before = engine.requests.length;
    try {
      await expect(dispatcher.dispatch(input)).resolves.toMatchObject({ state: "failed" });
      expect(engine.requests).toHaveLength(before);
      const [turn] = await db.select().from(turns).where(eq(turns.id, input.turnId));
      expect(turn).toMatchObject({ state: "failed", retryAfter: null });
    } finally {
      credentialFailure = undefined;
    }
  });

  it("never automatically repeats a turn after its engine has started", async () => {
    const input = await startAdmissionStory();
    const before = engine.requests.length;
    engine.throttleDuringRun = true;
    await expect(dispatcher.dispatch(input)).resolves.toMatchObject({ state: "failed" });
    expect(engine.requests).toHaveLength(before + 1);
    const [turn] = await db.select().from(turns).where(eq(turns.id, input.turnId));
    expect(turn).toMatchObject({ state: "failed", retryAfter: null });
  });

  async function budgetHandoffStory() {
    const isolatedProjectId = newId("proj");
    const isolatedRepository = `${repository}-${isolatedProjectId.slice(-8)}`;
    await createBareRepository(remotes, owner, isolatedRepository);
    budgetHandoffRepositories.set(isolatedProjectId, isolatedRepository);
    await db
      .insert(projects)
      .values({ id: isolatedProjectId, orgId, name: "Budget handoff", slug: isolatedProjectId });
    await db.insert(projectRepositories).values({
      id: newId("repo"),
      orgId,
      projectId: isolatedProjectId,
      installationId: installationRowId,
      owner,
      name: isolatedRepository,
      defaultBranch: "main",
      role: "primary",
    });
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId: isolatedProjectId,
      monthlyLimitCents: 100_000,
      enabled: true,
    });
    const started = await storiesService.start({
      orgId,
      projectId: isolatedProjectId,
      provider: "manual",
      externalId: newId("evt"),
      title: "Settle before the next request",
      agent: builder,
      message: "First request",
      messageDedupeKey: newId("evt"),
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected first turn");
    await storiesService.queueMessage({
      orgId,
      projectId: isolatedProjectId,
      storyId: started.story.id,
      body: "Next request",
      dedupeKey: newId("evt"),
      agent: builder,
      actor: { type: "user", id: "user_test" },
      trigger: { type: "manual" },
    });
    return {
      orgId,
      projectId: isolatedProjectId,
      storyId: started.story.id,
      turnId: started.queued.turn.id,
    };
  }

  it("releases a pre-provider hold before activating its queued successor", async () => {
    const input = await budgetHandoffStory();
    const activate = dispatcher.activateQueuedSuccessor.bind(dispatcher);
    const checked = vi
      .spyOn(dispatcher, "activateQueuedSuccessor")
      .mockImplementation(async (scope) => {
        if (scope.turnId === input.turnId) {
          expect(
            await db
              .select()
              .from(budgetReservations)
              .where(eq(budgetReservations.turnId, input.turnId)),
          ).toEqual([]);
          expect(
            await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId)),
          ).toEqual([]);
        }
        return activate(scope);
      });
    credentialFailure = Object.assign(new Error("access revoked"), { status: 403 });
    try {
      await expect(dispatcher.dispatch(input)).resolves.toMatchObject({ state: "failed" });
      expect(checked).toHaveBeenCalled();
    } finally {
      checked.mockRestore();
      credentialFailure = undefined;
    }
  });

  it.each([
    "failed",
    "canceled",
  ] as const)("books missing %s usage before handoff and reconciles a late final journal without rerunning", async (outcome) => {
    const input = await budgetHandoffStory();
    const activate = dispatcher.activateQueuedSuccessor.bind(dispatcher);
    const checked = vi
      .spyOn(dispatcher, "activateQueuedSuccessor")
      .mockImplementation(async (scope) => {
        if (scope.turnId === input.turnId) {
          const failed = (await db.select().from(turns).where(eq(turns.id, input.turnId)))[0];
          expect(
            engine.requests.some((request) => request.turnId === input.turnId),
            failed?.error ?? "fake engine did not run",
          ).toBe(true);
          expect(
            await db
              .select()
              .from(budgetReservations)
              .where(eq(budgetReservations.turnId, input.turnId)),
          ).toEqual([]);
          expect(
            (await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId)))[0],
          ).toMatchObject({ priced: false, source: "unpriced" });
        }
        return activate(scope);
      });
    engine.failNextRun = outcome === "failed";
    engine.blockUntilCanceled = outcome === "canceled";
    engine.blockingStarted = false;
    try {
      const dispatch = dispatcher.dispatch(input);
      if (outcome === "canceled") {
        await waitFor(() => engine.blockingStarted);
        await storiesService.cancelTurn({ ...input, actor: { type: "user", id: "user_test" } });
      }
      await expect(dispatch).resolves.toMatchObject({ state: outcome });
    } finally {
      checked.mockRestore();
      engine.blockUntilCanceled = false;
    }
    const costs = new CostBudgetService(db);
    expect((await costs.budgetState(input.orgId, input.projectId)).state).toBe("unconfirmed");
    const workspace = (await storiesService.get(input.orgId, input.projectId, input.storyId))
      .workspace;
    if (!workspace) throw new Error("missing retained workspace");
    const dir = join(workspace.volumeRef, ".facility", "engine-usage");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${input.turnId}.json`),
      JSON.stringify({
        version: 1,
        turnId: input.turnId,
        engine: "codex",
        complete: true,
        usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    );
    const calls = engine.requests.length;
    await recoverInterruptedTurns(db, storiesService);
    expect(engine.requests).toHaveLength(calls);
    expect((await costs.budgetState(input.orgId, input.projectId)).state).toBe("ok");
  });

  it("retains the hold and stops handoff when live accounting cannot be persisted", async () => {
    const input = await budgetHandoffStory();
    const original = CostBudgetService.prototype.record;
    const accounting = vi
      .spyOn(CostBudgetService.prototype, "record")
      .mockImplementation(async function (this: CostBudgetService, bill) {
        if (bill.turnId === input.turnId) throw new Error("accounting unavailable");
        return original.call(this, bill);
      });
    const activation = vi.spyOn(dispatcher, "activateQueuedSuccessor");
    engine.failNextRun = true;
    try {
      await expect(dispatcher.dispatch(input)).rejects.toThrow("accounting unavailable");
      expect(activation).not.toHaveBeenCalled();
      expect(
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.turnId, input.turnId)),
      ).toHaveLength(1);
      expect((await db.select().from(turns).where(eq(turns.id, input.turnId)))[0]?.state).toBe(
        "running",
      );
    } finally {
      accounting.mockRestore();
      activation.mockRestore();
    }
    await storiesService.recoverInterruptedTurn({
      ...input,
      staleBefore: new Date(Date.now() + 1000),
    });
    expect(
      await db.select().from(budgetReservations).where(eq(budgetReservations.turnId, input.turnId)),
    ).toEqual([]);
    expect((await new CostBudgetService(db).budgetState(input.orgId, input.projectId)).state).toBe(
      "unconfirmed",
    );
  });

  it("does not revive a canceled deferred turn after its deadline", async () => {
    const input = await startAdmissionStory();
    credentialFailure = Object.assign(new Error("API rate limit exceeded"), { status: 429 });
    try {
      await expect(dispatcher.dispatch(input)).resolves.toMatchObject({ state: "queued" });
    } finally {
      credentialFailure = undefined;
    }
    await storiesService.cancelTurn({ ...input, actor: { type: "user", id: "user_test" } });
    await db
      .update(turns)
      .set({ retryAfter: new Date(Date.now() - 1_000) })
      .where(eq(turns.id, input.turnId));
    const enqueued: unknown[] = [];
    await recoverQueuedTurns(db, async (_queue, data) => {
      if (data.turnId === input.turnId) enqueued.push(data);
    });
    expect(enqueued).toEqual([]);
    await expect(dispatcher.dispatch(input)).resolves.toEqual({ claimed: false });
  });
  it("retains the writer while native stop is pending and rolls back a failed stop", async () => {
    const input = await budgetHandoffStory();
    const admitted = await (
      dispatcher as unknown as { admit: (i: typeof input) => Promise<{ kind: string }> }
    ).admit(input);
    expect(admitted.kind).toBe("running");
    const stale = new Date(Date.now() - 300000);
    await db.update(turns).set({ updatedAt: stale }).where(eq(turns.id, input.turnId));
    let entered!: () => void;
    let finish!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const cleanup = vi.spyOn(runtime, "exec").mockImplementation(async (_workspace, command) => {
      if (command.env?.FACILITY_INTERRUPTED_TURN_ID === input.turnId) {
        entered();
        await gate;
        return { exitCode: 1, stdout: "", stderr: "stop unconfirmed", durationMs: 1 };
      }
      throw Error("Unexpected recovery command");
    });
    const onRecovered = vi.fn(async (_turn: { turnId: string }) => undefined);
    const recovering = recoverInterruptedTurns(db, storiesService, new Date(), 60000, onRecovered);
    try {
      await inside;
      expect((await db.select().from(turns).where(eq(turns.id, input.turnId)))[0]?.state).toBe(
        "running",
      );
      expect(onRecovered.mock.calls.some(([turn]) => turn.turnId === input.turnId)).toBe(false);
      finish();
      await recovering;
      expect((await db.select().from(turns).where(eq(turns.id, input.turnId)))[0]?.state).toBe(
        "running",
      );
      expect(
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.turnId, input.turnId)),
      ).toHaveLength(1);
      expect(onRecovered.mock.calls.some(([turn]) => turn.turnId === input.turnId)).toBe(false);
    } finally {
      finish();
      cleanup.mockRestore();
      await recovering.catch(() => undefined);
      await db
        .update(turns)
        .set({ state: "canceled", updatedAt: new Date() })
        .where(eq(turns.id, input.turnId));
      await db.delete(budgetReservations).where(eq(budgetReservations.turnId, input.turnId));
    }
  });

  it("keeps a promoted provider reservation when cancellation waits for the story lock", async () => {
    const input = await budgetHandoffStory();
    const costs = new CostBudgetService(db);
    let releaseStory!: () => void;
    let signalLocked!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseStory = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const lock = db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`facility:story:${input.orgId}:${input.projectId}:${input.storyId}`}))`,
      );
      signalLocked();
      await gate;
    });
    await locked;
    const canceled = storiesService.cancelTurn({ ...input, actor: { type: "user", id: "test" } });
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const result = await db.execute<{ blocked: boolean }>(
        sql`select exists(select 1 from pg_locks where locktype = 'advisory' and not granted) as blocked`,
      );
      if (result[0]?.blocked) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    engine.blockUntilCanceled = true;
    engine.blockingStarted = false;
    const running = dispatcher.dispatch(input);
    const escaped = running.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    let accounting: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await waitFor(() => engine.blockingStarted);
      const [hold] = await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.turnId, input.turnId));
      expect(hold).toBeDefined();
      if (!hold) throw Error("Expected admitted provider reservation");
      const cap = Math.ceil(hold.reservedCents);
      await db
        .update(projectBudgets)
        .set({ monthlyLimitCents: cap })
        .where(eq(projectBudgets.projectId, input.projectId));
      const workspace = (await storiesService.get(input.orgId, input.projectId, input.storyId))
        .workspace;
      if (!workspace) throw Error("Missing retained workspace");
      const dir = join(workspace.volumeRef, ".facility", "engine-usage");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${input.turnId}.json`),
        JSON.stringify({
          version: 1,
          turnId: input.turnId,
          engine: "codex",
          complete: true,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reportedCostCents: cap + 1,
          },
        }),
      );
      const original = CostBudgetService.prototype.record;
      accounting = vi
        .spyOn(CostBudgetService.prototype, "record")
        .mockImplementation(async function (this: CostBudgetService, bill) {
          if (bill.turnId === input.turnId) throw Error("review accounting unavailable");
          return original.call(this, bill);
        });
      releaseStory();
      await lock;
      await canceled;
      expect((await db.select().from(turns).where(eq(turns.id, input.turnId)))[0]?.state).toBe(
        "canceled",
      );
      expect(
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.turnId, input.turnId)),
      ).toHaveLength(1);
      expect(await escaped).toMatchObject({
        error: expect.objectContaining({ message: "review accounting unavailable" }),
      });
      accounting.mockRestore();
      accounting = undefined;
      await recoverInterruptedTurns(db, storiesService);
      expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, input.turnId))).toEqual([
        expect.objectContaining({ priced: true }),
      ]);
      expect(await costs.budgetState(input.orgId, input.projectId)).toMatchObject({
        state: "exceeded",
      });
      await dispatcher.activateQueuedSuccessor(input);
      const next = (
        await storiesService.get(input.orgId, input.projectId, input.storyId)
      ).turns.find((t) => t.state === "queued");
      if (!next) throw Error("Missing queued successor");
      engine.blockUntilCanceled = false;
      const before = engine.requests.length;
      await expect(dispatcher.dispatch({ ...input, turnId: next.id })).resolves.toMatchObject({
        state: "failed",
      });
      expect(engine.requests).toHaveLength(before);
    } finally {
      releaseStory();
      await lock;
      accounting?.mockRestore();
      engine.blockUntilCanceled = false;
      await escaped;
    }
  }, 15000);
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
