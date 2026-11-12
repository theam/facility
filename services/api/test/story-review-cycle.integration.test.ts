import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseAgentManifest } from "@facility/agents";
import {
  type DeliveryReviewResult,
  generateApiKey,
  newId,
  type ReviewCandidate,
  type StoryWorkflowStatus,
} from "@facility/core";
import {
  apiKeys,
  attentionItems,
  createDb,
  githubChecks,
  githubInstallations,
  githubPullRequests,
  migrate,
  projectBudgets,
  projectRepositories,
  projects,
  seed,
  storyPreviewConvergences,
  storyPreviewGenerations,
  storyReviewCycles,
  turns,
} from "@facility/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentCatalogService } from "../src/agents/catalog.js";
import { buildApp, mintSessionCookie } from "../src/app.js";
import type { GithubClientFactory, Octokit } from "../src/github/client.js";
import { StoryReviewCycles } from "../src/stories/review-cycle.js";
import { REVIEW_TRIGGER } from "../src/stories/review-cycle-rules.js";
import { ReviewCycleSource } from "../src/stories/review-cycle-source.js";
import { lockWorkflowStory } from "../src/stories/workflow-policy.js";
import { createStoryDomain } from "../src/story-domain.js";
import { TurnDispatcher } from "../src/turns/dispatcher.js";
import type { AgentTurnRequest, AgentTurnResult } from "../src/turns/engines.js";
import type { AppConfig } from "../src/types.js";
import { recoverInterruptedTurns } from "../src/worker.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { parseProjectManifest } from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
const initial = "1".repeat(40);
const base = "2".repeat(40);
const delivered = "3".repeat(40);
const corrected = "4".repeat(40);
const external = "5".repeat(40);
const user = { type: "user", id: "user_local_admin" } as const;
const orgId = "org_local";

function fixture<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

function latch() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const agentSource = (name: string, engine: string, model: string) =>
  "---\nname: " +
  name +
  "\ndescription: Test " +
  name +
  "\nengine: " +
  engine +
  "\nmodel: " +
  model +
  "\ntriggers:\n  - type: manual\n  - type: ui\n  - type: mcp\n---\nUse the fixture contract.\n";
const architect = parseAgentManifest(
  agentSource("architect", "codex", "gpt-5.6-luna"),
  ".agents/architect.md",
);
const builderSource = agentSource("builder", "codex", "gpt-5.6-luna");
const reviewerSource = agentSource("pr-reviewer", "claude_code", "claude-sonnet-5");
const builder = parseAgentManifest(builderSource, ".agents/builder.md");

type Pull = {
  repositoryId: string;
  repo: string;
  repository: string;
  number: number;
  branch: string;
  head: string;
  base: string;
  labels: string[];
};
type Scenario =
  | "minor"
  | "fixed"
  | "persistent"
  | "invalid"
  | "missing"
  | "failed-fix"
  | "no-progress"
  | "external-after-review"
  | "undeclared"
  | "writes";

describe("bounded review cycle with real storage and the existing dispatcher", () => {
  const { db, client } = createDb(databaseUrl);
  const projectId = newId("proj");
  const owner = `review-${randomUUID().slice(0, 8)}`;
  const repositoryNames = [`${owner}/app`, `${owner}/consumer`];
  const repositoryIds = [newId("repo"), newId("repo")];
  const installation = newId("ghi");
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 87).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    workspaceImage: "facility-runner:review-test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const pulls = new Map<number, Pull>();
  const scenarios = new Map<string, Scenario>();
  const workspaceGit = new Map<
    string,
    { branch: string; head: string; storyId: string; pulls: Pull[] }
  >();
  let nextPull = 1;
  let root: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;
  let token: string;
  let tokenId: string;
  let mcp: Client;
  let domain: ReturnType<typeof createStoryDomain>;
  let dispatcher: TurnDispatcher;
  let cycles: StoryReviewCycles;
  let catalog: AgentCatalogService;
  let source: ReviewCycleSource;
  const policy = {
    planApprovalAgents: ["builder"],
    holdAfterFailure: true,
    requireDeliveryAcceptance: true,
    requirePreviewForAcceptance: false,
    reviewCycle: {
      builderAgent: "builder",
      reviewerAgent: "pr-reviewer",
      timeoutMinutes: 10,
    },
  };
  const policyPath = `/v1/projects/${projectId}/workflow-policy`;
  const path = (storyId: string) => `/v1/projects/${projectId}/workspace-stories/${storyId}`;
  const enqueue = vi.fn(async (_queue: string, _input: Record<string, unknown>) => null);
  // Reviews Facility leaves on the fixture pull requests.
  const publishedReviews: Array<{
    repo: string;
    pull: number;
    commit_id: string;
    event: string;
    body: string;
    html_url: string;
  }> = [];
  // Simulated GitHub conditions for the pull reads the cycle makes.
  const github: { down?: boolean; hold?: { entered: () => void; released: Promise<void> } } = {};
  const request = vi.fn(async (route: string, args: Record<string, unknown>) => {
    if (route.startsWith("GET ") && route.endsWith("/pulls/{pull_number}")) {
      if (github.down) throw Object.assign(new Error("Service unavailable"), { status: 503 });
      if (github.hold) {
        github.hold.entered();
        await github.hold.released;
      }
      const pull = pulls.get(Number(args.pull_number));
      if (!pull || args.repo !== pull.repo || args.owner !== owner)
        throw new Error("wrong repository");
      return {
        data: {
          number: pull.number,
          state: "open",
          draft: false,
          changed_files: 1,
          labels: pull.labels.map((name) => ({ name })),
          head: { sha: pull.head, ref: pull.branch, repo: { full_name: pull.repository } },
          base: { sha: pull.base, ref: "main", repo: { full_name: pull.repository } },
        },
      };
    }
    if (route.startsWith("GET ") && route.endsWith("/compare/{basehead}")) {
      const [left, right] = String(args.basehead).split("...");
      const file =
        args.repo === "consumer"
          ? { filename: "consumer.ts", patch: "@@ -1 +1 @@\n-read(oldName);\n+read(fieldName);" }
          : {
              filename: "api.ts",
              patch: "@@ -1 +1 @@\n-export const oldName = 1;\n+export const fieldName = 1;",
            };
      return {
        data: {
          base_commit: { sha: left },
          merge_base_commit: { sha: left },
          status: left === right ? "identical" : "ahead",
          files: [{ ...file, status: "modified", additions: 1, deletions: 1 }],
        },
      };
    }
    if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews")
      return {
        data: publishedReviews.filter(
          (review) => review.repo === args.repo && review.pull === Number(args.pull_number),
        ),
      };
    if (route === "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews") {
      const review = {
        repo: String(args.repo),
        pull: Number(args.pull_number),
        commit_id: String(args.commit_id),
        event: String(args.event),
        body: String(args.body),
        html_url: `https://github.com/${owner}/${args.repo}/pull/${args.pull_number}#review-${publishedReviews.length + 1}`,
      };
      publishedReviews.push(review);
      return { data: review };
    }
    throw new Error("Forbidden operation in the GitHub review fake");
  });
  const githubFactory: GithubClientFactory = async () => ({ request }) as unknown as Octokit;
  // The native Reviewer turn: a read-only Claude Code run in the story workspace.
  const section = (prompt: string, heading: string) => {
    const parts = prompt.split("\n\n");
    const index = parts.findIndex((part) => part.startsWith(heading));
    return index < 0 ? undefined : parts[index + 1];
  };
  const inference = vi.fn(async (run: AgentTurnRequest): Promise<AgentTurnResult> => {
    expect(run.readOnly).toBe(true);
    expect(run.nativeSessionId).toBeUndefined();
    expect(run.prompt).not.toContain("synthetic-maintainer-secret");
    expect(run.environment?.GH_TOKEN).toBeUndefined();
    const git = workspaceGit.get(run.workspace.id);
    if (!git) throw new Error("Missing Reviewer workspace");
    const scenario = scenarios.get(git.storyId);
    // A Reviewer that ignores its read-only tools and commits in the checkout.
    if (scenario === "writes") git.head = "9".repeat(40);
    const candidate = JSON.parse(section(run.prompt, "### Candidate") ?? "") as ReviewCandidate;
    const previousText = section(run.prompt, "### Previous review result");
    const payload = {
      previous: previousText ? (JSON.parse(previousText) as DeliveryReviewResult) : undefined,
    };
    const consumer = candidate.pullRequests.find((pull) => pull.repository.endsWith("/consumer"));
    if (!consumer) throw new Error("Consumer PR missing");
    const resolved = scenario === "fixed" && !!payload.previous;
    const result: DeliveryReviewResult = {
      candidateId: scenario === "invalid" ? "0".repeat(64) : candidate.id,
      reviewedPulls: candidate.pullRequests.map(({ repository, number, baseSha, headSha }) => ({
        repository,
        number,
        baseSha,
        headSha,
      })),
      acceptance: [
        {
          id: "consumer-contract",
          criterion: "The downstream consumer can read the delivered field.",
          state: scenario === "missing" ? "unverified" : "verified",
          evidence: "Compared API export and the consumer read.",
        },
      ],
      findings: [
        {
          id: "consumer-name",
          priority: scenario === "minor" ? "P3" : "P2",
          category: scenario === "minor" ? "suggestion" : "correctness",
          requirement: "consumer-contract",
          repository: consumer.repository,
          number: consumer.number,
          path: "consumer.ts",
          line: 1,
          evidence: "Exact downstream read on the registered consumer commit.",
          impact: "The dependent read must use the published field.",
          fix: "Update the read on the existing branch.",
          disposition: resolved ? "resolved" : "open",
          correction: "within_plan",
        },
      ],
      missingEvidence: scenario === "missing" ? ["A required reproduction is unavailable."] : [],
    };
    if (scenario === "external-after-review") {
      const pull = pulls.get(consumer.number);
      if (pull) pull.head = external;
    }
    return {
      nativeSessionId: `review-${run.turnId}`,
      progress: [],
      events: [],
      durationMs: 10,
      exitCode: 0,
      stderr: "",
      output: `Reviewed both pull requests.\n<facility-review>${JSON.stringify(result)}</facility-review>`,
      usage: { inputTokens: 4_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  });

  async function post(
    url: string,
    data: Record<string, unknown>,
    headers: Record<string, string> = { cookie },
  ) {
    const idempotency_key = randomUUID();
    const response = await app.inject({
      method: "POST",
      url,
      headers: { ...headers, "idempotency-key": idempotency_key },
      payload: { ...data, idempotency_key },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  }
  async function state(storyId: string) {
    const response = await app.inject({ url: `${path(storyId)}/workflow`, headers: { cookie } });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<StoryWorkflowStatus>().reviewCycle;
  }
  async function savePolicy(next: Record<string, unknown>) {
    const saved = await app.inject({ url: policyPath, headers: { cookie } });
    expect(saved.statusCode, saved.body).toBe(200);
    const expected_revision = saved.json().revision;
    const review = await post(policyPath + "/review", { expected_revision, policy: next });
    await post(policyPath + "/confirm", {
      expected_revision,
      policy: review.policy,
      proof: review.proof,
      nonce: review.nonce,
      expires_at: review.expiresAt,
    });
  }
  const scope = (storyId: string) => ({ orgId, projectId, storyId });
  const dispatch = (turnId: string) => dispatcher.dispatch({ orgId, projectId, turnId });
  const active = async (storyId: string) => {
    const turnId = (await state(storyId))?.activeTurnId;
    if (!turnId) throw new Error(`No cycle turn is queued for ${storyId}`);
    return turnId;
  };
  async function mirror(pull: Pull, ciState: "pending" | "success" = "success") {
    const now = new Date();
    await db
      .update(githubPullRequests)
      .set({
        headSha: pull.head,
        ciHeadSha: pull.head,
        ciState,
        ciUpdatedAt: now,
        syncedAt: now,
      })
      .where(
        and(
          eq(githubPullRequests.repositoryId, pull.repositoryId),
          eq(githubPullRequests.number, pull.number),
        ),
      );
  }

  async function story(scenario: Scenario, pending = false, labels: string[] = []) {
    const externalId = randomUUID();
    const branch = `feature/${externalId}`;
    scenarios.set(externalId, scenario);
    const started = await domain.stories.start({
      orgId,
      projectId,
      provider: "manual",
      externalId,
      title: "Deliver one API and its consumer",
      branch,
      agent: architect,
      message: "Change the field and verify the downstream consumer.",
      messageDedupeKey: externalId,
      actor: user,
      trigger: { type: "ui" },
      workspace: { image: config.workspaceImage, ports: [] },
    });
    const storyId = started.story.id;
    const planningTurn = started.queued.turn;
    if (!planningTurn || !started.workspace) throw new Error("Planning was not queued");
    await domain.stories.completeTurn({
      orgId,
      projectId,
      turnId: planningTurn.id,
      actor: { type: "system", id: "fixture-architect" },
      output: "Plan the API and its consumer together.",
    });
    const items = repositoryNames.map((repository, index) => ({
      repositoryId: fixture(repositoryIds[index]),
      repository,
      number: nextPull++,
      repo: fixture(repository.split("/")[1]),
      branch,
      base,
      head: delivered,
      labels,
    }));
    for (const item of items) {
      pulls.set(item.number, item);
      await db.insert(githubPullRequests).values({
        id: newId("ghp"),
        orgId,
        projectId,
        repositoryId: item.repositoryId,
        number: item.number,
        title: "Fixture PR",
        state: "open",
        headRef: branch,
        baseRef: "main",
        headSha: delivered,
        htmlUrl: `https://github.com/${item.repository}/pull/${item.number}`,
        ciState: pending ? "pending" : "success",
        ciHeadSha: delivered,
        ciUpdatedAt: new Date(),
      });
    }
    workspaceGit.set(started.workspace.id, {
      branch,
      head: initial,
      storyId: externalId,
      pulls: items,
    });
    await post(`${path(storyId)}/delivery`, {
      expected_revision: 0,
      declared_complete: true,
      pull_requests: items.map(({ repository, number }, index) => ({
        repository,
        number,
        required: true,
        primary: index === 0,
      })),
    });
    const plans = `${path(storyId)}/plan`;
    const proposed = await post(plans, {
      expected_revision: 0,
      markdown: "Acceptance: the downstream consumer reads the delivered field.",
      repositories: repositoryNames,
      agents: ["builder", "pr-reviewer"],
    });
    const decision = await post(`${plans}/decisions`, {
      expected_revision: proposed.state.revision,
      expected_decision_revision: 0,
      intent: "approve",
    });
    const confirmation = `${plans}/decisions/${decision.request.id}`;
    const review = await app.inject({ url: confirmation, headers: { cookie } });
    expect(review.statusCode, review.body).toBe(200);
    await post(`${confirmation}/confirm`, { proof: review.json().proof });
    const { turn: builderTurn } = await domain.stories.queueMessage({
      ...scope(storyId),
      body: "Build the approved plan.",
      dedupeKey: `build-${externalId}`,
      agent: builder,
      actor: user,
      trigger: { type: "ui" },
    });
    if (!builderTurn) throw new Error("Builder was not queued");
    expect(await dispatch(builderTurn.id)).toMatchObject({ state: "succeeded" });
    return { storyId, items, builderTurnId: builderTurn.id };
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    root = await mkdtemp(join(tmpdir(), "facility-f11-"));
    const runtime = new FakeWorkspaceRuntime(root);
    await db
      .insert(projects)
      .values({ id: projectId, orgId, slug: projectId, name: "F11 fixture" });
    await db.insert(githubInstallations).values({
      id: installation,
      orgId,
      installationId: Date.now(),
      accountId: 1,
      accountLogin: owner,
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values(
      repositoryNames.map((_, index) => ({
        id: fixture(repositoryIds[index]),
        orgId,
        projectId,
        owner,
        name: index === 0 ? "app" : "consumer",
        role: index === 0 ? "primary" : "related",
        defaultBranch: "main",
        installationId: installation,
      })),
    );
    const generated = await generateApiKey("fak");
    token = generated.secret;
    tokenId = generated.id;
    await db.insert(apiKeys).values({
      id: tokenId,
      orgId,
      name: "F11 project reader",
      prefix: generated.lookup,
      hash: generated.hash,
      last4: generated.last4,
      scopeType: "project",
      projectId,
      roleId: "role_bundled_owner",
    });
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", resolve);
    });
    const bound = probe.address();
    if (!bound || typeof bound === "string") throw new Error("Loopback port is unavailable");
    await new Promise<void>((resolve, reject) =>
      probe.close((error) => (error ? reject(error) : resolve())),
    );
    config.port = bound.port;
    config.publicUrl = `http://127.0.0.1:${bound.port}`;
    domain = createStoryDomain({ db, config, runtime, enqueue, githubFactory });
    catalog = new AgentCatalogService(db, {
      load: async () => ({
        repositoryId: repositoryIds[0],
        commitSha: base,
        sources: [
          { file: ".agents/builder.md", source: builderSource },
          { file: ".agents/pr-reviewer.md", source: reviewerSource },
        ],
      }),
    });
    domain.catalog = catalog;
    source = new ReviewCycleSource(db, githubFactory);
    cycles = new StoryReviewCycles(db, domain.stories, catalog, source, enqueue);
    dispatcher = new TurnDispatcher(
      db,
      domain.stories,
      catalog,
      domain.credentials,
      domain.projectManifests,
      domain.environment,
      domain.engines,
      domain.evidence,
      domain.costs,
      undefined,
      { cycles },
    );
    domain.dispatcher = dispatcher;
    domain.reviewCycles = cycles;
    vi.spyOn(domain.credentials, "issue").mockResolvedValue({
      repositories: [
        { owner, name: "app", role: "primary", defaultBranch: "main" },
        { owner, name: "consumer", role: "related", defaultBranch: "main" },
      ],
      environment: { GH_TOKEN: "synthetic-maintainer-secret" },
      expiresAt: new Date(Date.now() + 3_600_000),
      gitIdentity: { name: "Fixture", email: "fixture@example.test" },
    });
    vi.spyOn(domain.projectManifests, "load").mockResolvedValue(
      parseProjectManifest(
        [
          "version: 1",
          "repositories:",
          `  primary: github.com/${owner}/app`,
          `  related: [github.com/${owner}/consumer]`,
          "environment:",
          "  start: true",
          "  services:",
          "    app:",
          "      port: 3000",
        ]
          .join("\n")
          .replace("start: true", 'start: "true"'),
      ),
    );
    vi.spyOn(domain.environment, "prepare").mockResolvedValue({
      endpoints: [],
      primaryCwd: `repos/${owner}/app`,
      setupChecksum: "fixture",
      processEnvironment: { GH_TOKEN: "synthetic-maintainer-secret" },
      secretNames: ["GH_TOKEN"],
    });
    vi.spyOn(runtime, "exec").mockImplementation(async (workspace, command) => {
      const git = workspaceGit.get(workspace.id);
      // Interrupted-turn recovery stops the native engine process; none is running here.
      if (git && command.command === "node")
        return { exitCode: 0, stderr: "", durationMs: 1, stdout: "absent" };
      if (!git || command.command !== "git") throw new Error("Unexpected workspace command");
      const operation = command.args?.[0];
      return {
        exitCode: 0,
        stderr: "",
        durationMs: 1,
        stdout: operation === "rev-parse" ? git.head : operation === "branch" ? git.branch : "",
      };
    });
    vi.spyOn(domain.engines.get("claude_code"), "run").mockImplementation(inference);
    vi.spyOn(domain.engines.get("codex"), "run").mockImplementation(async (run) => {
      const git = workspaceGit.get(run.workspace.id);
      if (!git) throw new Error("Missing Builder workspace");
      const scenario = scenarios.get(git.storyId);
      const correction = run.prompt.includes("Correct these blocking findings");
      if (correction) {
        expect(run.nativeSessionId).toBe(`native-${git.storyId}`);
        if (scenario === "failed-fix") throw new Error("Synthetic Builder correction failure");
        if (scenario !== "no-progress") {
          git.head = corrected;
          for (const pull of git.pulls) {
            pull.head = corrected;
            await mirror(pull);
          }
        }
      } else {
        expect(run.prompt).toContain("declare the complete required PR set");
        git.head = delivered;
      }
      const heads = git.pulls.map(({ repository, number, head }) => ({
        repository,
        number,
        headSha: head,
      }));
      return {
        nativeSessionId: `native-${git.storyId}`,
        progress: [],
        events: [],
        durationMs: 10,
        exitCode: 0,
        stderr: "",
        output:
          scenario === "undeclared"
            ? "Implemented part of the plan; the delivery is not ready yet."
            : `<facility-delivery-heads>${JSON.stringify(heads)}</facility-delivery-heads>`,
        usage: { inputTokens: 800, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });
    app = await buildApp(config, { rateLimitMax: 10000, storyDomain: domain });
    vi.spyOn(app, "enqueue").mockImplementation(enqueue);
    cookie = `facility_session=${await mintSessionCookie(config, user.id, orgId)}`;
    await app.listen({ host: "127.0.0.1", port: config.port });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("Test API did not listen");
    mcp = new Client({ name: "f11-local-pilot", version: "1.0.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const review = await post(`${policyPath}/review`, { expected_revision: 0, policy });
    await post(`${policyPath}/confirm`, {
      expected_revision: 0,
      policy: review.policy,
      proof: review.proof,
      nonce: review.nonce,
      expires_at: review.expiresAt,
    });
  }, 30_000);

  afterAll(async () => {
    await mcp?.close();
    await app?.close();
    await client.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("waits for exact CI, deduplicates observations and concurrent dispatch, and exposes identical MCP evidence", async () => {
    const { storyId, items } = await story("minor", true);
    expect(await state(storyId)).toMatchObject({
      phase: "waiting_for_evidence",
      reviewsStarted: 0,
    });
    const requestAcceptance = await app.inject({
      method: "POST",
      url: `${path(storyId)}/delivery-acceptance`,
      headers: { cookie, "idempotency-key": "review-running" },
      payload: {
        expected_candidate_revision: (await state(storyId))?.candidate?.deliveryRevision,
        expected_plan_revision: 1,
        expected_decision_revision: 1,
        idempotency_key: "review-running",
      },
    });
    expect(requestAcceptance.statusCode).toBe(409);
    for (const pull of items) await mirror(pull);
    const restarted = new StoryReviewCycles(db, domain.stories, catalog, source, enqueue);
    const [primary] = items;
    if (!primary) throw new Error("Fixture has no primary PR");
    await Promise.all([
      restarted.recover(),
      cycles.observePull(primary.repositoryId, primary.number),
      cycles.observePull(primary.repositoryId, primary.number),
    ]);
    const turnId = await active(storyId);
    const previous = inference.mock.calls.length;
    await Promise.all([dispatch(turnId), dispatch(turnId)]);
    expect(inference.mock.calls).toHaveLength(previous + 1);
    // The Reviewer worked with a read-only GitHub token.
    expect(vi.mocked(domain.credentials.issue).mock.calls.at(-1)).toEqual([
      orgId,
      projectId,
      { readOnly: true },
    ]);
    const api = await state(storyId);
    expect(api).toMatchObject({ phase: "human_review", reviewsStarted: 1, correctionsStarted: 0 });
    // Facility left the report on each pull request as a comment review of the exact head.
    const ours = () =>
      publishedReviews.filter((review) => items.some((pull) => pull.number === review.pull));
    expect(ours()).toHaveLength(2);
    for (const pull of items)
      expect(ours().find((review) => review.pull === pull.number)).toMatchObject({
        event: "COMMENT",
        commit_id: pull.head,
        body: expect.stringContaining("Facility automatic review"),
      });
    expect(api?.reviews[0]?.publication).toEqual(
      items.map((pull) =>
        expect.objectContaining({
          number: pull.number,
          state: "published",
          url: expect.any(String),
        }),
      ),
    );
    // A retry that lost the record finds its marker on GitHub instead of posting again.
    const [stored] = await db
      .select()
      .from(storyReviewCycles)
      .where(eq(storyReviewCycles.storyId, storyId));
    if (!stored) throw new Error("Missing review cycle");
    const unrecorded = structuredClone(stored.data) as {
      status: { reviews: Array<{ publication?: unknown }> };
    };
    delete unrecorded.status.reviews[0]?.publication;
    await db
      .update(storyReviewCycles)
      .set({ data: unrecorded as typeof stored.data })
      .where(eq(storyReviewCycles.storyId, storyId));
    await cycles.reconcile(scope(storyId));
    expect(ours()).toHaveLength(2);
    expect((await state(storyId))?.reviews[0]?.publication).toHaveLength(2);
    expect(api?.reviews[0]?.candidate.pullRequests).toHaveLength(2);
    const response = await mcp.callTool({
      name: "facility_get_story_workflow",
      arguments: { projectId, storyId },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    const data = (response.structuredContent as { data: StoryWorkflowStatus }).data;
    expect(data.reviewCycle).toEqual(api);
    const [gate] = await db
      .select()
      .from(attentionItems)
      .where(
        and(eq(attentionItems.storyId, storyId), eq(attentionItems.kind, "review_cycle_ready")),
      );
    if (!gate) throw new Error("The human review notice was not stored");
    await expect(
      domain.stories.dismissAttention({
        ...scope(storyId),
        attentionId: gate.id,
        actor: { type: "service", id: tokenId },
      }),
    ).rejects.toMatchObject({ code: "review_human_required" });
  });

  it.each([
    ["fixed", "human_review"],
    ["persistent", "decision_required"],
  ] as const)("resumes the same Builder and reviews the corrected candidate for %s", async (scenario, phase) => {
    const { storyId } = await story(scenario);
    await dispatch(await active(storyId));
    expect(await state(storyId)).toMatchObject({
      phase: "correction",
      reviewsStarted: 1,
      correctionsStarted: 0,
    });
    await dispatch(await active(storyId));
    await dispatch(await active(storyId));
    await cycles.recover();
    const cycle = await state(storyId);
    expect(cycle).toMatchObject({
      phase,
      reviewsStarted: 2,
      correctionsStarted: 1,
      activeTurnId: null,
    });
    expect(cycle?.reviews.map((report) => report.candidate.pullRequests[0]?.headSha)).toEqual([
      delivered,
      corrected,
    ]);
    expect(cycle?.reviews[1]?.result.findings[0]?.disposition).toBe(
      scenario === "fixed" ? "resolved" : "open",
    );
    const automatic = await db
      .select()
      .from(turns)
      .where(and(eq(turns.storyId, storyId), eq(turns.triggerType, REVIEW_TRIGGER)));
    expect(automatic).toHaveLength(3);
  });

  it.each([
    "invalid",
    "missing",
    "external-after-review",
  ] as const)("stops for %s review evidence", async (scenario) => {
    const { storyId } = await story(scenario);
    await dispatch(await active(storyId));
    expect(await state(storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 1,
      correctionsStarted: 0,
    });
  });

  it.each(["failed-fix", "no-progress"] as const)("stops after %s", async (scenario) => {
    const { storyId } = await story(scenario);
    await dispatch(await active(storyId));
    await dispatch(await active(storyId));
    expect(await state(storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 1,
      correctionsStarted: 1,
    });
  });

  it("discards a Reviewer's change to the workspace and stops for a person", async () => {
    const { storyId } = await story("writes");
    const reviewed = (await state(storyId))?.candidate?.pullRequests.find((pull) => pull.primary);
    const exec = vi.mocked(domain.runtime.exec);
    const before = exec.mock.calls.length;
    await dispatch(await active(storyId));
    expect(await state(storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 1,
      reason: expect.stringContaining("changed the workspace"),
    });
    const restored = exec.mock.calls
      .slice(before)
      .map(([, command]) => command.args?.join(" "))
      .filter((args) => args?.startsWith("reset --hard"));
    expect(restored).toContain(`reset --hard ${reviewed?.headSha}`);
  });

  it("releases a message the cycle held once a person dismisses its stop", async () => {
    const { storyId, items } = await story("minor", true);
    // A message sent while the cycle waits for evidence is held without a turn.
    const { turn: held } = await domain.stories.queueMessage({
      ...scope(storyId),
      body: "Also update the changelog.",
      dedupeKey: `held-${storyId}`,
      agent: builder,
      actor: user,
      trigger: { type: "ui" },
    });
    expect(held).toBeUndefined();
    await db
      .update(storyReviewCycles)
      .set({ deadline: new Date(Date.now() - 1_000) })
      .where(eq(storyReviewCycles.storyId, storyId));
    for (const pull of items) await mirror(pull);
    await cycles.reconcile(scope(storyId));
    expect(await state(storyId)).toMatchObject({ phase: "decision_required" });
    const [stop] = await db
      .select()
      .from(attentionItems)
      .where(
        and(
          eq(attentionItems.storyId, storyId),
          eq(attentionItems.kind, "review_cycle_decision"),
          eq(attentionItems.status, "open"),
        ),
      );
    if (!stop) throw new Error("The stop did not ask for a decision");
    const pendingTurns = async () =>
      db
        .select()
        .from(turns)
        .where(and(eq(turns.storyId, storyId), eq(turns.state, "queued")));
    expect(await pendingTurns()).toHaveLength(0);
    const dismissed = await app.inject({
      method: "POST",
      url: `${path(storyId)}/attention/${stop.id}/dismiss`,
      headers: { cookie, "idempotency-key": `dismiss-${stop.id}` },
    });
    expect(dismissed.statusCode, dismissed.body).toBe(200);
    expect(await pendingTurns()).toMatchObject([{ agentName: "builder" }]);
  });

  it("starts no cycle for a Builder turn that does not declare its delivery", async () => {
    const { storyId } = await story("undeclared");
    expect(await state(storyId)).toBeUndefined();
    expect(
      await db.select().from(storyReviewCycles).where(eq(storyReviewCycles.storyId, storyId)),
    ).toHaveLength(0);
  });

  it("keeps waiting while GitHub evidence is temporarily unavailable, until the deadline", async () => {
    const { storyId, items } = await story("minor", true);
    for (const pull of items) await mirror(pull);
    github.down = true;
    try {
      await cycles.reconcile(scope(storyId));
      expect(await state(storyId)).toMatchObject({
        phase: "waiting_for_evidence",
        reviewsStarted: 0,
        reason: expect.stringContaining("temporarily unavailable"),
      });
      github.down = false;
      await cycles.reconcile(scope(storyId));
      const turnId = await active(storyId);
      expect(await state(storyId)).toMatchObject({ phase: "review", reviewsStarted: 0 });
      // Admission keeps the turn queued for a retry instead of stopping the cycle.
      github.down = true;
      expect(await dispatch(turnId)).toMatchObject({
        claimed: false,
        state: "held",
        code: "review_evidence_unavailable",
      });
      const [held] = await db.select().from(turns).where(eq(turns.id, turnId));
      expect(held?.state).toBe("queued");
      expect(held?.retryAfter?.getTime()).toBeGreaterThan(Date.now());
      expect(await state(storyId)).toMatchObject({ phase: "review", reviewsStarted: 0 });
      // Past the deadline the cycle stops for a person.
      await db
        .update(storyReviewCycles)
        .set({ deadline: new Date(Date.now() - 1_000) })
        .where(eq(storyReviewCycles.storyId, storyId));
      await db.update(turns).set({ retryAfter: null }).where(eq(turns.id, turnId));
      await dispatch(turnId);
      expect(await state(storyId)).toMatchObject({
        phase: "decision_required",
        reason: expect.stringContaining("time limit"),
      });
    } finally {
      github.down = false;
    }
  });

  it("reads GitHub evidence without holding the story lock", async () => {
    const { storyId, items } = await story("minor", true);
    for (const pull of items) await mirror(pull);
    let entered = () => {};
    const inFlight = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    github.hold = {
      entered: () => entered(),
      released: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    const reconciling = cycles.reconcile(scope(storyId));
    try {
      await inFlight;
      const lock = await Promise.race([
        db.transaction(async (tx) => {
          await lockWorkflowStory(tx as unknown as typeof db, scope(storyId));
          return "acquired" as const;
        }),
        sleep(3_000).then(() => "blocked" as const),
      ]);
      expect(lock).toBe("acquired");
    } finally {
      github.hold = undefined;
      release();
      await reconciling;
    }
    expect(await state(storyId)).toMatchObject({ phase: "review" });
  });

  it("denies external heads and bases before inference", async () => {
    const before = inference.mock.calls.length;
    const head = await story("minor");
    fixture(head.items[1]).head = external;
    await dispatch(await active(head.storyId));
    expect(await state(head.storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 0,
    });
    const changedBase = await story("minor", true);
    fixture(changedBase.items[0]).base = external;
    await mirror(fixture(changedBase.items[0]));
    await cycles.reconcile(scope(changedBase.storyId));
    expect(await state(changedBase.storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 0,
    });
    expect(inference.mock.calls).toHaveLength(before);
  });

  it("denies a superseded plan or expired cycle before inference", async () => {
    const first = await story("minor");
    await post(`${path(first.storyId)}/plan`, {
      expected_revision: 1,
      markdown: "A later plan revision.",
      repositories: repositoryNames,
      agents: ["builder", "pr-reviewer"],
    });
    await dispatch(await active(first.storyId));
    expect(await state(first.storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 0,
    });
    const expired = await story("minor");
    await db
      .update(storyReviewCycles)
      .set({ deadline: new Date(Date.now() - 1_000) })
      .where(eq(storyReviewCycles.storyId, expired.storyId));
    await dispatch(await active(expired.storyId));
    expect(await state(expired.storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 0,
    });
  });

  it("stops on the project budget gate without starting an unaffordable turn", async () => {
    const monthly = await story("minor");
    await db
      .insert(projectBudgets)
      .values({ id: newId("bud"), orgId, projectId, monthlyLimitCents: 1, enabled: true });
    try {
      await dispatch(await active(monthly.storyId));
      expect(await state(monthly.storyId)).toMatchObject({
        phase: "decision_required",
        reviewsStarted: 0,
        reason: expect.stringContaining("budget"),
      });
    } finally {
      await db.delete(projectBudgets).where(eq(projectBudgets.projectId, projectId));
    }
  });

  it("requires exclusive review ownership, exact-head named CI and the exact preview generation", async () => {
    const label = "facility-review-cycle";
    await savePolicy({
      ...policy,
      requirePreviewForAcceptance: true,
      reviewCycle: {
        ...policy.reviewCycle,
        requiredPullLabel: label,
        requiredChecks: [{ repository: repositoryNames[0], name: "test-build" }],
      },
    });
    try {
      const unlabelled = await story("minor");
      expect(await state(unlabelled.storyId)).toMatchObject({
        phase: "decision_required",
        reviewsStarted: 0,
        reason: expect.stringContaining("label"),
      });
      const candidate = await story("minor", false, [label]);
      const primary = candidate.items[0];
      if (!primary) throw new Error("No primary fixture");
      for (const headSha of [external, primary.head]) {
        await db.insert(githubChecks).values({
          id: newId("evt"),
          orgId,
          projectId,
          repositoryId: primary.repositoryId,
          checkId: newId("evt"),
          headSha,
          pullNumber: primary.number,
          name: "test-build",
          status: "completed",
          conclusion: "success",
        });
        await cycles.reconcile(scope(candidate.storyId));
        expect(await state(candidate.storyId)).toMatchObject({
          phase: "waiting_for_evidence",
          reviewsStarted: 0,
          reason: expect.stringContaining(headSha === external ? "required checks" : "preview"),
        });
      }
      const revision = (await state(candidate.storyId))?.candidate?.deliveryRevision;
      if (!revision) throw new Error("Candidate revision not available");
      const now = new Date();
      const otherGeneration = "9".repeat(64);
      for (const generation of [otherGeneration, revision])
        await db
          .insert(storyPreviewGenerations)
          .values({
            ...scope(candidate.storyId),
            generation,
            deliveryRevision: generation,
            repositories: candidate.items.map((pull, index) => ({
              repositoryId: pull.repositoryId,
              repository: pull.repository,
              pullNumber: pull.number,
              headRef: pull.branch,
              headSha: pull.head,
              primary: index === 0,
            })),
            sourceObservedAt: now,
          })
          .onConflictDoNothing();
      await db
        .update(storyPreviewConvergences)
        .set({
          state: "ready",
          deployedGeneration: otherGeneration,
        })
        .where(eq(storyPreviewConvergences.storyId, candidate.storyId));
      await cycles.reconcile(scope(candidate.storyId));
      expect(await state(candidate.storyId)).toMatchObject({ phase: "waiting_for_evidence" });
      await db
        .update(storyPreviewConvergences)
        .set({ deployedGeneration: revision })
        .where(eq(storyPreviewConvergences.storyId, candidate.storyId));
      await cycles.reconcile(scope(candidate.storyId));
      await dispatch(await active(candidate.storyId));
      expect(await state(candidate.storyId)).toMatchObject({
        phase: "human_review",
        candidate: { preview: { generation: revision } },
      });
    } finally {
      await savePolicy(policy);
    }
  });

  it("retains consumed review admission after a crash and refuses a replacement review", async () => {
    const { storyId } = await story("minor");
    const turnId = await active(storyId);
    const entered = latch();
    const release = latch();
    inference.mockImplementationOnce(async (run) => {
      entered.resolve();
      await release.promise;
      return {
        nativeSessionId: `review-${run.turnId}`,
        progress: [],
        events: [],
        durationMs: 10,
        exitCode: 0,
        stderr: "",
        output: "",
        usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    });
    const running = dispatch(turnId);
    await Promise.race([
      entered.promise,
      running.then(() => {
        throw new Error("Reviewer did not enter inference");
      }),
    ]);
    const future = new Date(Date.now() + 180_000);
    expect(
      await recoverInterruptedTurns(db, domain.stories, future, 120_000, (turn) =>
        dispatcher.activateQueuedSuccessor(turn),
      ),
    ).toBeGreaterThan(0);
    release.resolve();
    await running;
    await cycles.recover();
    expect(await state(storyId)).toMatchObject({
      phase: "decision_required",
      reviewsStarted: 1,
      correctionsStarted: 0,
    });
    expect(await dispatch(turnId)).toEqual({ claimed: false });
  });
});
