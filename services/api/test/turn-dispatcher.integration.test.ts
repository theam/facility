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
  AgentEngineRegistry,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "../src/turns/engines.js";
import { recoverQueuedTurns } from "../src/worker.js";
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
  services:
    app:
      port: 3000
`);

  class FakeCodexEngine implements AgentEngine {
    readonly name = "codex" as const;
    requests: AgentTurnRequest[] = [];
    async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
      this.requests.push(request);
      const result = await runtime.exec(request.workspace, {
        command: "sh",
        args: [
          "-lc",
          `printf '%s' ${JSON.stringify(`turn-${this.requests.length}`)} >> agent-work`,
        ],
        cwd: request.cwd,
      });
      const secret = request.environment?.GH_TOKEN ?? "missing";
      return {
        nativeSessionId: request.nativeSessionId ?? "codex-native-session",
        output: `completed with ${secret}`,
        events: [{ engine: "codex", type: "item.completed", data: { output: secret } }],
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
      new ProjectEnvironmentService(db, runtime, `file://${remotes}`),
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
    expect(messages.at(-1)).toMatchObject({ role: "agent", body: "completed with [REDACTED]" });
    const events = await db
      .select()
      .from(turnEvents)
      .where(eq(turnEvents.turnId, initialTurn.id))
      .orderBy(asc(turnEvents.seq));
    expect(JSON.stringify(events)).not.toContain("secret-installation-token");

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
      attention: [],
    });
  });
});

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
