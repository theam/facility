import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentManifest, parseAgentManifest } from "@facility/agents";
import { newId, reservationCents } from "@facility/core";
import {
  attentionItems,
  budgetReservations,
  createDb,
  githubInstallations,
  migrate,
  orgs,
  projectBudgets,
  projectRepositories,
  projects,
  stories,
  turnEvents,
  turns,
  turnUsage,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgentCatalogService, type AgentCatalogSource } from "../src/agents/catalog.js";
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import { CostBudgetService, TURN_LIMIT_ATTENTION } from "../src/insights/costs.js";
import { attentionAction } from "../src/insights/project-overview.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { TurnDispatcher } from "../src/turns/dispatcher.js";
import { AgentEngineRegistry, ClaudeCodeEngine, CodexEngine } from "../src/turns/engines.js";
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

/**
 * The per-turn spending limit, end to end through the dispatcher. The real Claude
 * Code and Codex engine classes run fake CLIs that replay recorded event streams,
 * so admission, the --max-budget-usd argument, the usage journal, billing and the
 * story notice are exercised without provider credentials or network access.
 */
describe("per-turn spending limit", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; per-turn limit tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-turn-limit-"));
  const bin = join(root, "bin");
  const remotes = join(root, "remotes");
  const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
  const suffix = randomUUID().slice(0, 8);
  const owner = "acme";
  const orgId = newId("org");
  const otherOrgId = newId("org");
  const installationRowId = newId("ghi");
  const repositories = new Map<string, string>();
  const originalPath = process.env.PATH;

  const codexBuilder = agent("builder", "codex", "gpt-5.5");
  const claudeBuilder = agent("claude-builder", "claude_code", "claude-sonnet-5-5");
  const unpricedBuilder = agent("private-builder", "codex", "private-unpriced-model");
  const catalogAgents = [codexBuilder, claudeBuilder, unpricedBuilder];

  let storiesService: StoryWorkspaceService;
  let dispatcher: TurnDispatcher;

  beforeAll(async () => {
    await migrate(databaseUrl);
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "claude"), fakeCli("claude"), { mode: 0o755 });
    await writeFile(join(bin, "codex"), fakeCli("codex"), { mode: 0o755 });
    // The fake workspace runtime starts engines with this process's PATH.
    process.env.PATH = `${bin}:${originalPath}`;
    await db.insert(orgs).values([
      { id: orgId, name: "Turn limit", slug: `turn-limit-${suffix}`, settings: {} },
      { id: otherOrgId, name: "Other tenant", slug: `turn-limit-other-${suffix}`, settings: {} },
    ]);
    await db.insert(githubInstallations).values({
      id: installationRowId,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 20_000,
      accountId: 123,
      accountLogin: owner,
      targetType: "Organization",
    });
    storiesService = new StoryWorkspaceService(db, runtime, async () => undefined);
    const catalogSource: AgentCatalogSource = {
      load: async () => ({
        commitSha: "b".repeat(40),
        sources: catalogAgents.map((manifest) => ({
          file: manifest.file,
          source: agentSource(manifest.name, manifest.engine, manifest.model),
        })),
      }),
    };
    const manifestSource: ProjectManifestSource = {
      load: async (_orgId, requestedProjectId) =>
        parseProjectManifest(`
version: 1
repositories:
  primary: github.com/${owner}/${repositories.get(requestedProjectId)}
  related: []
environment:
  setup: printf setup > .setup-complete
  start: mkdir -p .dev && printf running > .dev/status
  ready: test -f .dev/status
`),
    };
    dispatcher = new TurnDispatcher(
      db,
      storiesService,
      new AgentCatalogService(db, catalogSource),
      new GithubWorkspaceCredentialBroker(db, async () => ({
        gitIdentity: { name: "my-app[bot]", email: "12345+my-app[bot]@users.noreply.github.com" },
        token: "secret-installation-token",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })),
      manifestSource,
      new ProjectEnvironmentService(db, runtime, `file://${remotes}`, () => undefined),
      new AgentEngineRegistry([new ClaudeCodeEngine(runtime), new CodexEngine(runtime)]),
      new TurnGitEvidenceService(db, runtime),
      undefined,
      runtime,
    );
  });

  beforeEach(async () => {
    for (const file of ["claude-args", "codex-args"]) await rm(join(bin, file), { force: true });
    await claudeReplies("success", 0.12);
    await codexReplies(100);
  });

  afterAll(async () => {
    process.env.PATH = originalPath;
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  it("admits a Claude Code turn whose estimate fits and stops the CLI at the limit", async () => {
    const story = await storyWithBudget(claudeBuilder, { turnLimitCents: 60 });
    expect(reservationCents(claudeBuilder.model, "turn")).toBeLessThanOrEqual(60);

    await expect(dispatcher.dispatch(story)).resolves.toMatchObject({ state: "succeeded" });

    expect(await cliArgs("claude")).toEqual(
      expect.arrayContaining(["--max-budget-usd", "0.600000"]),
    );
    expect(await usage(story.turnId)).toMatchObject({
      priced: true,
      source: "provider",
      costCents: expect.closeTo(12, 6),
    });
    expect(await openReservations(story.turnId)).toEqual([]);
    expect(await notices(story)).toEqual([]);
  });

  it("bills and explains a Claude Code turn that stopped at the limit", async () => {
    const story = await storyWithBudget(claudeBuilder, { turnLimitCents: 60 });
    await claudeReplies("limit", 0.6275);

    await expect(dispatcher.dispatch(story)).resolves.toMatchObject({
      state: "failed",
      error: expect.stringContaining("per-turn limit of $0.60"),
    });

    // The usage journal saw the final result, so the bill is complete, not a lower bound.
    expect(await usage(story.turnId)).toMatchObject({
      priced: true,
      source: "provider",
      status: "failed",
      costCents: expect.closeTo(62.75, 6),
    });
    expect((await new CostBudgetService(db).budgetState(orgId, story.projectId)).state).toBe("ok");
    // The stop is the turn's failure; it does not also open an overrun notice.
    expect(await notices(story)).toEqual([
      expect.objectContaining({
        kind: "turn_error",
        detail: expect.stringContaining("Claude Code stopped this turn"),
      }),
    ]);
  });

  it("refuses a turn whose estimate exceeds the per-turn limit before any engine starts", async () => {
    const story = await storyWithBudget(codexBuilder, { turnLimitCents: 100 });
    expect(reservationCents(codexBuilder.model, "turn")).toBeGreaterThan(100);

    await expect(dispatcher.dispatch(story)).resolves.toMatchObject({
      state: "failed",
      error: expect.stringContaining("per-turn limit of 100 cents"),
    });

    expect(await cliArgs("codex")).toBeNull();
    expect(await usage(story.turnId)).toBeUndefined();
    expect(
      await db.select().from(budgetReservations).where(eq(budgetReservations.turnId, story.turnId)),
    ).toEqual([]);
    expect(await notices(story)).toEqual([
      expect.objectContaining({
        kind: "turn_error",
        status: "open",
        detail: expect.stringContaining("per-turn limit"),
      }),
    ]);
  });

  it("reports a Codex turn that went over the limit once it ends and never retries it", async () => {
    const story = await storyWithBudget(codexBuilder, { turnLimitCents: 300 });
    expect(reservationCents(codexBuilder.model, "turn")).toBeLessThanOrEqual(300);
    // 400k input tokens on gpt-5.5 cost $4.00, measured only when the Codex turn ends.
    await codexReplies(400_000);

    await expect(dispatcher.dispatch(story)).resolves.toMatchObject({ state: "succeeded" });

    const args = await cliArgs("codex");
    expect(args).not.toBeNull();
    expect(args).not.toContain("--max-budget-usd");
    const bill = await usage(story.turnId);
    expect(bill).toMatchObject({ priced: true, source: "price_book", status: "succeeded" });
    expect(bill?.costCents).toBeGreaterThan(300);

    const [notice, ...others] = await notices(story);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      kind: TURN_LIMIT_ATTENTION,
      status: "open",
      turnId: story.turnId,
      title: "builder went over the per-turn limit",
      detail: expect.stringMatching(/cost \$4\.00, more than .* limit of \$3\.00\. Codex reports/),
    });
    expect(notice?.detail).toContain("did not retry");
    const [recorded] = await db
      .select()
      .from(turnEvents)
      .where(and(eq(turnEvents.turnId, story.turnId), eq(turnEvents.type, "turn.limit_exceeded")));
    expect(recorded?.data).toMatchObject({
      engine: "codex",
      costCents: bill?.costCents,
      turnLimitCents: 300,
    });
    const [current] = await db.select().from(stories).where(eq(stories.id, story.storyId));
    expect(current?.status).toBe("attention");

    // Retrying would spend again: the notice is dismiss-only and nothing was queued.
    if (!notice) throw new Error("expected the overrun notice");
    expect(attentionAction(notice)).toBe("dismiss");
    await expect(
      storiesService.retryAttention({
        ...story,
        attentionId: notice.id,
        actor: { type: "user", id: "user_test" },
      }),
    ).rejects.toMatchObject({ code: "attention_not_retryable" });
    expect(await storyTurns(story)).toEqual([expect.objectContaining({ id: story.turnId })]);
  });

  it("does not report a Codex turn whose measured cost stays within the limit", async () => {
    const story = await storyWithBudget(codexBuilder, { turnLimitCents: 300 });

    await expect(dispatcher.dispatch(story)).resolves.toMatchObject({ state: "succeeded" });

    expect((await usage(story.turnId))?.costCents).toBeLessThanOrEqual(300);
    expect(await notices(story)).toEqual([]);
  });

  it("leaves turns unlimited while the budget is not enforced", async () => {
    const claude = await storyWithBudget(claudeBuilder, { turnLimitCents: 1, enabled: false });
    await expect(dispatcher.dispatch(claude)).resolves.toMatchObject({ state: "succeeded" });
    expect(await cliArgs("claude")).not.toContain("--max-budget-usd");

    const codex = await storyWithBudget(codexBuilder, { turnLimitCents: 1, enabled: false });
    await codexReplies(400_000);
    await expect(dispatcher.dispatch(codex)).resolves.toMatchObject({ state: "succeeded" });
    expect(await notices(codex)).toEqual([]);
  });

  it("refuses an unpriced model under an enforced per-turn limit", async () => {
    const story = await storyWithBudget(unpricedBuilder, { turnLimitCents: 10_000 });

    await expect(dispatcher.dispatch(story)).resolves.toMatchObject({
      state: "failed",
      error: expect.stringContaining("has no price entry"),
    });

    expect(await cliArgs("codex")).toBeNull();
    expect(await usage(story.turnId)).toBeUndefined();
  });

  it("keeps a per-turn limit and its notices inside their own tenant", async () => {
    const limited = await storyWithBudget(codexBuilder, { turnLimitCents: 100 });

    // Another tenant cannot claim this project's turn or read its limit.
    await expect(
      dispatcher.dispatch({
        orgId: otherOrgId,
        projectId: limited.projectId,
        turnId: limited.turnId,
      }),
    ).resolves.toMatchObject({ claimed: false });
    expect(await cliArgs("codex")).toBeNull();
    await expect(
      db.transaction((tx) =>
        new CostBudgetService(db).reserveTurn(tx as unknown as typeof db, {
          orgId: otherOrgId,
          projectId: limited.projectId,
          storyId: limited.storyId,
          turnId: limited.turnId,
          model: codexBuilder.model,
        }),
      ),
    ).resolves.toEqual({ reservationId: null, turnLimitCents: null });
    const [stillQueued] = await db.select().from(turns).where(eq(turns.id, limited.turnId));
    expect(stillQueued?.state).toBe("queued");

    // Nor open an overrun notice on another tenant's story.
    await expect(
      storiesService.reportTurnLimitOverrun({
        orgId: otherOrgId,
        projectId: limited.projectId,
        storyId: limited.storyId,
        turnId: limited.turnId,
        agentName: "builder",
        engine: "codex",
        costCents: 500,
        turnLimitCents: 100,
      }),
    ).rejects.toThrow();
    expect(await notices(limited)).toEqual([]);

    // A project without a budget is unaffected by the other project's limit.
    const unlimited = await storyWithBudget(codexBuilder, null);
    await expect(dispatcher.dispatch(unlimited)).resolves.toMatchObject({ state: "succeeded" });
    expect(await cliArgs("codex")).not.toContain("--max-budget-usd");
  });

  async function storyWithBudget(
    manifest: AgentManifest,
    budget: { turnLimitCents: number; enabled?: boolean } | null,
  ) {
    const projectId = newId("proj");
    const repository = `limit-${projectId.slice(-10)}`;
    await createBareRepository(remotes, owner, repository);
    repositories.set(projectId, repository);
    await db.insert(projects).values({ id: projectId, orgId, name: "Limit", slug: projectId });
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
    if (budget)
      await db.insert(projectBudgets).values({
        id: newId("bud"),
        orgId,
        projectId,
        monthlyLimitCents: 100_000,
        turnLimitCents: budget.turnLimitCents,
        enabled: budget.enabled ?? true,
      });
    const started = await storiesService.start({
      orgId,
      projectId,
      provider: "manual",
      externalId: newId("evt"),
      title: "Respect the per-turn limit",
      agent: manifest,
      message: "Do the work",
      messageDedupeKey: newId("evt"),
      actor: { type: "user", id: "user_test" },
      workspace: { image: "facility-runner:test", ports: [] },
    });
    if (!started.queued.turn) throw new Error("expected a queued turn");
    return { orgId, projectId, storyId: started.story.id, turnId: started.queued.turn.id };
  }

  async function claudeReplies(outcome: "success" | "limit", costUsd: number) {
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const result =
      outcome === "success"
        ? {
            type: "result",
            subtype: "success",
            session_id: "claude-limit",
            result: "done",
            total_cost_usd: costUsd,
            usage,
          }
        : {
            // Recorded shape of a real --max-budget-usd stop: exit 1, zeroed counters.
            type: "result",
            subtype: "error_max_budget_usd",
            is_error: true,
            session_id: "claude-limit",
            total_cost_usd: costUsd,
            usage: { ...usage, input_tokens: 0, output_tokens: 0 },
            errors: ["Reached maximum budget"],
          };
    await writeFile(join(bin, "claude-result"), `${JSON.stringify(result)}\n`);
    await writeFile(join(bin, "claude-exit"), outcome === "success" ? "0" : "1");
  }

  async function codexReplies(inputTokens: number) {
    await writeFile(
      join(bin, "codex-completed"),
      `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: 20 } })}\n`,
    );
  }

  async function cliArgs(cli: "claude" | "codex") {
    try {
      return (await readFile(join(bin, `${cli}-args`), "utf8")).split("\n");
    } catch {
      return null;
    }
  }

  async function usage(turnId: string) {
    return (await db.select().from(turnUsage).where(eq(turnUsage.turnId, turnId)))[0];
  }

  async function openReservations(turnId: string) {
    return db
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.turnId, turnId), eq(budgetReservations.state, "open")));
  }

  async function notices(scope: { projectId: string; storyId: string }) {
    return db
      .select()
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.projectId, scope.projectId),
          eq(attentionItems.storyId, scope.storyId),
        ),
      );
  }

  async function storyTurns(scope: { projectId: string; storyId: string }) {
    return db
      .select()
      .from(turns)
      .where(and(eq(turns.projectId, scope.projectId), eq(turns.storyId, scope.storyId)));
  }
});

/** A stand-in CLI that records its arguments and replays the configured events. */
function fakeCli(cli: "claude" | "codex") {
  const opening =
    cli === "claude"
      ? [
          {
            type: "system",
            subtype: "init",
            session_id: "claude-limit",
            model: "claude-sonnet-5-5",
          },
        ]
      : [
          { type: "thread.started", thread_id: "codex-limit" },
          { type: "item.completed", item: { type: "agent_message", text: "implemented" } },
        ];
  const lines = opening.map((event) => `printf '%s\\n' '${JSON.stringify(event)}'`).join("\n");
  return cli === "claude"
    ? `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$@" > "$dir/claude-args"
${lines}
cat "$dir/claude-result"
exit "$(cat "$dir/claude-exit")"
`
    : `#!/bin/sh
dir=$(dirname "$0")
printf '%s\\n' "$@" > "$dir/codex-args"
${lines}
cat "$dir/codex-completed"
`;
}

function agent(name: string, engine: "claude_code" | "codex", model: string) {
  return parseAgentManifest(agentSource(name, engine, model), `.agents/${name}.md`);
}

function agentSource(name: string, engine: string, model: string) {
  return `---
name: ${name}
description: Implements stories.
engine: ${engine}
model: ${model}
enabled: true
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
  await writeFile(join(work, "README.md"), "# turn limit\n");
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
