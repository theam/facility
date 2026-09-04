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
  githubInstallations,
  githubPullRequests,
  migrate,
  orgs,
  projectRepositories,
  projects,
  stories,
  storyEvidenceEvents,
  turnEvents,
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
import { TurnGitEvidenceService } from "../src/turns/git-evidence.js";
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

describe("cross-story collision guard", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; collision tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-collisions-"));
  const remotes = join(root, "remotes");
  const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
  const suffix = randomUUID().slice(0, 8);
  const owner = "acme";
  const repository = `app-${suffix}`;
  const orgId = newId("org");
  const projectId = newId("proj");
  const installationRowId = newId("ghi");
  const repositoryId = newId("repo");
  const builderSource = `---
name: builder
description: Implements stories.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
---
Implement the request and verify it.
`;
  const builder = parseAgentManifest(builderSource, ".agents/builder.md");
  const projectManifest = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/${owner}/${repository}
  related: []
environment:
  setup: "true"
  start: "true"
  ready: "true"
`);

  /** Writes the files requested for the next turn so Git evidence records exactly those paths. */
  class FileWritingEngine implements AgentEngine {
    readonly name = "codex" as const;
    requests: AgentTurnRequest[] = [];
    nextFiles: string[] = [];
    async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
      this.requests.push(request);
      const script = this.nextFiles
        .map(
          (path) =>
            `mkdir -p "$(dirname ${JSON.stringify(path)})" && printf 'x' >> ${JSON.stringify(path)}`,
        )
        .join(" && ");
      const result = await runtime.exec(request.workspace, {
        command: "sh",
        args: ["-lc", script || "true"],
        cwd: request.cwd,
        signal: request.signal,
      });
      return {
        nativeSessionId: request.nativeSessionId ?? `session-${this.requests.length}`,
        output: "done",
        events: [],
        exitCode: 0,
        stderr: "",
        durationMs: result.durationMs,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }
  }
  const engine = new FileWritingEngine();

  let storiesService: StoryWorkspaceService;
  let dispatcher: TurnDispatcher;

  async function startStory(name: string) {
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "github",
      externalId: `${name}-${suffix}`,
      title: `Story ${name}`,
      agent: builder,
      message: `Work on ${name}`,
      messageDedupeKey: `start-${name}-${suffix}`,
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected initial queued turn");
    return { story: started.story, turnId: started.queued.turn.id };
  }

  async function runTurn(storyId: string, files: string[], turnId?: string) {
    let id = turnId;
    if (!id) {
      const queued = await storiesService.queueMessage({
        orgId,
        projectId,
        storyId,
        body: `Touch ${files.join(", ")}`,
        dedupeKey: `msg-${randomUUID()}`,
        agent: builder,
        actor: { type: "user", id: "user_test" },
        trigger: { type: "manual" },
      });
      if (!queued.turn) throw new Error("expected a queued turn");
      id = queued.turn.id;
    }
    engine.nextFiles = files;
    const result = await dispatcher.dispatch({ orgId, projectId, turnId: id });
    expect(result).toMatchObject({ claimed: true, state: "succeeded" });
    const request = engine.requests.at(-1);
    if (!request) throw new Error("expected an engine request");
    return { turnId: id, prompt: request.prompt };
  }

  async function collisionFacts(turnId: string) {
    return db
      .select({
        type: storyEvidenceEvents.type,
        externalKey: storyEvidenceEvents.externalKey,
        data: storyEvidenceEvents.data,
      })
      .from(storyEvidenceEvents)
      .where(
        and(
          eq(storyEvidenceEvents.turnId, turnId),
          eq(storyEvidenceEvents.type, "story.collision_detected"),
        ),
      )
      .orderBy(asc(storyEvidenceEvents.externalKey));
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await createBareRepository(remotes, owner, repository);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Collisions", slug: `collisions-${suffix}`, settings: {} });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Collisions",
      slug: `collisions-${suffix}`,
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
      id: repositoryId,
      orgId,
      projectId,
      installationId: installationRowId,
      owner,
      name: repository,
      defaultBranch: "main",
      role: "primary",
    });
    storiesService = new StoryWorkspaceService(db, runtime, async () => undefined);
    const catalogSource: AgentCatalogSource = {
      load: async () => ({
        commitSha: "a".repeat(40),
        sources: [{ file: builder.file, source: builderSource }],
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
      new ProjectEnvironmentService(db, runtime, `file://${remotes}`, () => undefined),
      new AgentEngineRegistry([engine]),
      new TurnGitEvidenceService(db, runtime),
    );
  });

  afterAll(async () => {
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  it("warns a story whose recorded files overlap another open story, without blocking or attention", async () => {
    const alpha = await startStory("alpha");
    const beta = await startStory("beta");

    const alphaFirst = await runTurn(
      alpha.story.id,
      ["src/shared.ts", "src/alpha.ts"],
      alpha.turnId,
    );
    expect(alphaFirst.prompt).not.toContain("Other active stories touch files you changed");
    expect(await collisionFacts(alphaFirst.turnId)).toEqual([]);

    // Beta has no completed evidence yet, so its first turn cannot collide.
    const betaFirst = await runTurn(beta.story.id, ["src/shared.ts", "src/beta.ts"], beta.turnId);
    expect(betaFirst.prompt).not.toContain("Other active stories touch files you changed");
    expect(await collisionFacts(betaFirst.turnId)).toEqual([]);

    const betaSecond = await runTurn(beta.story.id, ["src/beta.ts"]);
    expect(betaSecond.prompt).toContain("# Other active stories touch files you changed");
    expect(betaSecond.prompt).toContain(`"Story alpha" (github:alpha-${suffix}, branch `);
    expect(betaSecond.prompt).toContain("src/shared.ts");
    expect(betaSecond.prompt).not.toContain("src/alpha.ts");
    const facts = await collisionFacts(betaSecond.turnId);
    expect(facts).toEqual([
      {
        type: "story.collision_detected",
        externalKey: `turn:${betaSecond.turnId}:collision:${alpha.story.id}`,
        data: expect.objectContaining({
          storyId: alpha.story.id,
          title: "Story alpha",
          overlappingPaths: ["src/shared.ts"],
          overlapCount: 1,
          truncated: false,
        }),
      },
    ]);
    expect(
      await db
        .select({ type: turnEvents.type })
        .from(turnEvents)
        .where(
          and(
            eq(turnEvents.turnId, betaSecond.turnId),
            eq(turnEvents.type, "turn.collisions_detected"),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await db.select().from(attentionItems).where(eq(attentionItems.storyId, beta.story.id)),
    ).toEqual([]);
    const betaRow = (await db.select().from(stories).where(eq(stories.id, beta.story.id)))[0];
    expect(betaRow?.status).not.toBe("attention");

    // The overlap is symmetric: alpha's next turn learns about beta.
    const alphaSecond = await runTurn(alpha.story.id, ["src/alpha.ts"]);
    expect(alphaSecond.prompt).toContain(`"Story beta"`);
    expect(await collisionFacts(alphaSecond.turnId)).toHaveLength(1);
  });

  it("ignores archived stories and branches whose pull request already merged", async () => {
    const gamma = await startStory("gamma");
    const delta = await startStory("delta");
    const epsilon = await startStory("epsilon");
    await runTurn(gamma.story.id, ["lib/core.ts"], gamma.turnId);
    await runTurn(delta.story.id, ["lib/core.ts"], delta.turnId);
    await runTurn(epsilon.story.id, ["lib/core.ts"], epsilon.turnId);

    const before = await runTurn(gamma.story.id, ["lib/core.ts"]);
    expect(before.prompt).toContain(`"Story delta"`);
    expect(before.prompt).toContain(`"Story epsilon"`);
    expect(await collisionFacts(before.turnId)).toHaveLength(2);

    await storiesService.archive(orgId, projectId, delta.story.id);
    const epsilonRow = (await db.select().from(stories).where(eq(stories.id, epsilon.story.id)))[0];
    if (!epsilonRow?.branch) throw new Error("expected epsilon branch");
    await db.insert(githubPullRequests).values({
      id: newId("ghp"),
      orgId,
      projectId,
      repositoryId,
      number: 77,
      title: "Epsilon",
      state: "merged",
      headRef: epsilonRow.branch,
      headSha: "b".repeat(40),
      baseRef: "main",
      htmlUrl: `https://github.com/${owner}/${repository}/pull/77`,
      mergedAt: new Date(),
    });

    const after = await runTurn(gamma.story.id, ["lib/core.ts"]);
    expect(after.prompt).not.toContain("Other active stories touch files you changed");
    expect(await collisionFacts(after.turnId)).toEqual([]);
  });
});

async function createBareRepository(root: string, owner: string, name: string) {
  const bare = join(root, owner, `${name}.git`);
  const work = join(root, "seed", name);
  await mkdir(join(root, owner), { recursive: true });
  await mkdir(work, { recursive: true });
  await command("git", ["init", "--bare", "--initial-branch=main", bare]);
  await command("git", ["init", "--initial-branch=main"], work);
  await writeFile(join(work, "README.md"), "# collisions\n");
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
