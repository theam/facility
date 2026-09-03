import { createHmac } from "node:crypto";
import { newId } from "@facility/core";
import {
  agentDefs,
  createDb,
  githubInstallations,
  inboundEvents,
  integrations,
  migrate,
  orgs,
  platformIssues,
  projects,
  registryItems,
  repos,
  runs,
  seed,
} from "@facility/db";
import { and, asc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { FacilityGithubClient } from "../src/github/client.js";
import { parseFacilityRepoManifest, syncRepoFacilityConfig } from "../src/github/kickstart.js";
import { githubEventMatches, processGithubWebhook } from "../src/github/processor.js";
import {
  assertGithubRequestContextSize,
  githubRequestContext,
  resolveSlashCommand,
  routeTrigger,
} from "../src/github/router.js";
import { createPreviewRecord } from "../src/previews.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const masterKey = Buffer.alloc(32, 8).toString("base64");

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("FacilityGithubClient", () => {
  it("maps issue creation through Octokit", async () => {
    let args: Record<string, unknown> | undefined;
    const octokit = {
      rest: {
        issues: {
          create: async (input: Record<string, unknown>) => {
            args = input;
            return { data: { number: 42, html_url: "https://github.com/octo/repo/issues/42" } };
          },
        },
      },
    } as never;
    const client = new FacilityGithubClient(octokit, {
      owner: "octo",
      repo: "repo",
      defaultBranch: "main",
    });

    await expect(
      client.createIssue({ title: "Task", body: "Body", labels: ["type:task"] }),
    ).resolves.toEqual({ number: 42, url: "https://github.com/octo/repo/issues/42" });
    expect(args).toEqual({
      owner: "octo",
      repo: "repo",
      title: "Task",
      body: "Body",
      labels: ["type:task"],
    });
  });

  it("updates the existing run-progress comment in place", async () => {
    let args: Record<string, unknown> | undefined;
    const client = new FacilityGithubClient(
      {
        rest: {
          issues: {
            updateComment: async (input: Record<string, unknown>) => {
              args = input;
              return { data: { id: 77 } };
            },
          },
        },
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    await client.updateIssueComment(77, "completed");
    expect(args).toEqual({ owner: "octo", repo: "repo", comment_id: 77, body: "completed" });
  });

  it("creates draft pull requests explicitly", async () => {
    let args: Record<string, unknown> | undefined;
    const client = new FacilityGithubClient(
      {
        rest: {
          pulls: {
            create: async (input: Record<string, unknown>) => {
              args = input;
              return { data: { number: 8, html_url: "https://github.test/octo/repo/pull/8" } };
            },
          },
        },
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    await client.createPullRequest({
      title: "feat: retain delivery",
      body: "Body",
      head: "feature/retain-delivery",
      draft: true,
    });
    expect(args).toMatchObject({ head: "feature/retain-delivery", base: "main", draft: true });
  });

  it("marks only the expected draft head ready for review", async () => {
    const mutations: Record<string, unknown>[] = [];
    const client = new FacilityGithubClient(
      {
        graphql: async (_query: string, variables: Record<string, unknown>) => {
          mutations.push(variables);
          return {};
        },
        rest: {
          pulls: {
            get: async () => ({
              data: {
                number: 8,
                title: "feat: retain delivery",
                state: "open",
                draft: true,
                html_url: "https://github.test/octo/repo/pull/8",
                node_id: "PR_node",
                head: { sha: "current-sha" },
              },
            }),
          },
        },
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    await expect(client.markPullRequestReadyForReview(8, "stale-sha")).resolves.toBe(false);
    await expect(client.markPullRequestReadyForReview(8, "current-sha")).resolves.toBe(true);
    expect(mutations).toEqual([{ pullRequestId: "PR_node" }]);
  });

  it("collects bounded CI-doctor evidence without job logs and paginates comments", async () => {
    const pages: number[] = [];
    const evidencePages: number[] = [];
    const client = new FacilityGithubClient(
      {
        rest: {
          pulls: {
            get: async () => ({
              data: {
                number: 8,
                title: "fix: repair CI",
                state: "open",
                draft: true,
                html_url: "https://github.test/octo/repo/pull/8",
                head: {
                  ref: "feature/repair",
                  sha: "a".repeat(40),
                  repo: { full_name: "octo/repo" },
                },
                base: { ref: "main", repo: { full_name: "octo/repo" } },
              },
            }),
            listFiles: async (input: Record<string, unknown>) => {
              const page = Number(input.page);
              evidencePages.push(page);
              const count = page === 1 ? 100 : 1;
              return {
                data: Array.from({ length: count }, (_, index) => ({
                  filename: `src/file-${page}-${index}.ts`,
                })),
              };
            },
          },
          checks: {
            listForRef: async () => ({
              data: {
                check_runs: [
                  {
                    id: 9,
                    name: "typecheck",
                    status: "completed",
                    conclusion: "failure",
                    details_url: "https://github.test/actions/runs/99/job/9",
                    output: { title: "failed", summary: "untrusted raw output" },
                    app: { slug: "github-actions" },
                  },
                ],
              },
            }),
          },
          actions: {
            listWorkflowRunsForRepo: async () => ({
              data: { workflow_runs: [{ id: 99, name: "facility-doctor" }] },
            }),
          },
          issues: {
            listComments: async (input: Record<string, unknown>) => {
              const page = Number(input.page);
              pages.push(page);
              const count = page === 1 ? 100 : 1;
              return {
                data: Array.from({ length: count }, (_, index) => ({
                  id: (page - 1) * 100 + index + 1,
                  user: { login: "octocat", type: "User" },
                  body: `comment ${index + 1}`,
                  created_at: "2026-08-01T00:00:00Z",
                  html_url: `https://github.test/comments/${index + 1}`,
                })),
              };
            },
          },
        },
      } as never,
      { owner: "octo", repo: "repo", defaultBranch: "main" },
    );
    const evidence = await client.getCiDoctorEvidence(8, "a".repeat(40));
    expect(evidence).toMatchObject({
      pullRequest: {
        number: 8,
        head: { ref: "feature/repair", sha: "a".repeat(40) },
        changedFiles: expect.arrayContaining(["src/file-2-0.ts"]),
      },
      checks: [{ name: "typecheck", conclusion: "failure" }],
      doctorRunIds: [99],
    });
    expect(evidence.pullRequest.changedFiles).toHaveLength(101);
    expect(evidencePages).toEqual([1, 2]);
    expect(JSON.stringify(evidence)).not.toContain("job logs");
    await expect(client.listIssueComments(42)).resolves.toHaveLength(101);
    expect(pages).toEqual([1, 2]);
    await expect(client.listIssueComments(42, 100)).rejects.toThrow(
      "GitHub issue comments exceed the governed context limit",
    );
  });
});

describe("github integration", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; GitHub integration tests skipped", () =>
      undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4400,
    publicUrl: "http://localhost:4400",
    sandboxApiUrl: "http://localhost:4400",
    sandboxGatewayUrl: "http://localhost:4410",
    gatewayUrl: "http://localhost:4410",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    githubAppWebhookSecret: "webhook-secret",
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    // Pre-bind installation 123 to an org — the install-callback flow does this
    // in production; an unknown installation is deliberately NOT auto-bound.
    const org = (await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1))[0];
    if (org) {
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId: org.id,
          installationId: 123,
          accountLogin: "octo",
          targetType: "Organization",
        })
        .onConflictDoNothing();
    }
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("verifies GitHub HMAC before storing and no-ops replayed deliveries", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        installation: { id: 123, account: { id: 456, login: "octo", type: "Organization" } },
        repository: { name: "repo", owner: { login: "octo" } },
      }),
    );
    const bad = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": newId("evt"),
        "x-hub-signature-256": "sha256=bad",
      },
      payload,
    });
    expect(bad.statusCode).toBe(401);
    const delivery = newId("evt");
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(payload).digest("hex")}`;
    const valid = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": delivery,
        "x-hub-signature-256": signature,
      },
      payload,
    });
    expect(valid.statusCode).toBe(202);
    const replay = await app.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-event": "installation",
        "x-github-delivery": delivery,
        "x-hub-signature-256": signature,
      },
      payload,
    });
    expect(replay.json()).toEqual({ ok: true, replayed: true });
    const rows = await db
      .select()
      .from(inboundEvents)
      .where(eq(inboundEvents.id, `gh_${delivery}`));
    expect(rows).toHaveLength(1);
  });

  it("accepts signed GitHub bursts outside the public API rate limit", async () => {
    const limited = await buildApp(config, { rateLimitMax: 1 });
    try {
      await limited.ready();
      expect((await limited.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
      expect((await limited.inject({ method: "GET", url: "/health" })).statusCode).toBe(429);

      const payload = Buffer.from(
        JSON.stringify({
          action: "requested",
          installation: { id: 123 },
          repository: { name: "repo", owner: { login: "octo" } },
          workflow_run: { head_sha: "burst-sha" },
        }),
      );
      const signature = `sha256=${createHmac("sha256", "webhook-secret").update(payload).digest("hex")}`;
      let lastDelivery = "";
      for (let index = 0; index < 3; index += 1) {
        lastDelivery = newId("evt");
        const response = await limited.inject({
          method: "POST",
          url: "/webhooks/github",
          headers: {
            "content-type": "application/json",
            "x-github-event": "workflow_run",
            "x-github-delivery": lastDelivery,
            "x-hub-signature-256": signature,
          },
          payload,
        });
        expect(response.statusCode).toBe(202);
      }
      const [persisted] = await db
        .select()
        .from(inboundEvents)
        .where(eq(inboundEvents.id, `gh_${lastDelivery}`));
      expect(persisted).toMatchObject({ verified: true, eventType: "workflow_run" });
      expect(persisted?.processedAt).toBeInstanceOf(Date);

      const rejected = await limited.inject({
        method: "POST",
        url: "/webhooks/github",
        headers: {
          "content-type": "application/json",
          "x-github-event": "workflow_run",
          "x-github-delivery": newId("evt"),
          "x-hub-signature-256": "sha256=bad",
        },
        payload,
      });
      expect(rejected.statusCode).toBe(401);
    } finally {
      await limited.close();
    }
  });

  it("routes a webhook to the resolved org's repo when two tenants share a repo name", async () => {
    // repos are per-org unique (migration 0012), so two orgs can register the
    // same owner/name. The processor must select the repo of the webhook's
    // resolved org — a global owner/name lookup would cross tenants.
    const owner = "cross";
    const name = `tenant-${Date.now()}`;
    const setups: { orgId: string; repoId: string; integrationId: string }[] = [];
    for (let i = 0; i < 2; i++) {
      const orgId = newId("org");
      const suffix = `${Date.now()}-${i}`;
      await db.insert(orgs).values({ id: orgId, name: `xorg-${suffix}`, slug: `xorg-${suffix}` });
      const projectId = newId("proj");
      await db
        .insert(projects)
        .values({ id: projectId, orgId, name: "p", slug: `p-${suffix}`, settings: {} });
      const inst = (
        await db
          .insert(githubInstallations)
          .values({
            id: newId("int"),
            orgId,
            installationId: Date.now() * 10 + i,
            accountLogin: owner,
            targetType: "Organization",
          })
          .returning()
      )[0];
      const repoId = newId("repo");
      await db.insert(repos).values({
        id: repoId,
        orgId,
        projectId,
        installationId: inst?.id,
        owner,
        name,
        defaultBranch: "main",
        fingerprint: { files: [{ path: "managed.md" }] },
      });
      const integrationId = newId("int");
      await db
        .insert(integrations)
        .values({ id: integrationId, orgId, kind: "github", name: "gh" });
      setups.push({ orgId, repoId, integrationId });
    }
    const [target, other] = setups;
    if (!target || !other) throw new Error("two-org setup failed");
    const eventId = `gh_${newId("evt")}`;
    await db.insert(inboundEvents).values({
      id: eventId,
      orgId: target.orgId,
      integrationId: target.integrationId,
      verified: true,
      eventType: "push",
      payload: {
        repository: { owner: { login: owner }, name },
        ref: "refs/heads/main",
        commits: [{ modified: ["managed.md"] }],
      },
    });
    const enqueued: { queue: string; data: Record<string, unknown> }[] = [];
    await processGithubWebhook(db, config, { inboundEventId: eventId }, undefined, async (q, d) => {
      enqueued.push({ queue: q, data: d });
      return null;
    });
    const verify = enqueued.find((e) => e.queue === "fingerprints.verify");
    expect(verify?.data.repoId).toBe(target.repoId);
    expect(verify?.data.repoId).not.toBe(other.repoId);
  });

  it("adapts GitHub deployment telemetry into a recoverable project signal", async () => {
    const org = (await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1))[0];
    if (!org) throw new Error("seeded org missing");
    const suffix = newId("evt");
    const projectId = newId("proj");
    const repoId = newId("repo");
    const repoName = `deploy-${suffix}`;
    await db.insert(projects).values({
      id: projectId,
      orgId: org.id,
      name: "Deploy signals",
      slug: `deploy-signals-${suffix}`,
      settings: {},
    });
    await db.insert(repos).values({
      id: repoId,
      orgId: org.id,
      projectId,
      owner: "octo",
      name: repoName,
      defaultBranch: "main",
    });
    const integration = (
      await db
        .insert(integrations)
        .values({ id: newId("int"), orgId: org.id, kind: "github", name: suffix })
        .returning()
    )[0];
    if (!integration) throw new Error("integration fixture missing");

    const deliver = async (state: string) => {
      const id = newId("evt");
      await db.insert(inboundEvents).values({
        id,
        orgId: org.id,
        integrationId: integration.id,
        verified: true,
        eventType: "deployment_status",
        payload: {
          repository: { owner: { login: "octo" }, name: repoName },
          deployment_status: {
            state,
            environment: "production",
            target_url: "https://example.test/deployment",
          },
        },
      });
      await processGithubWebhook(db, config, { inboundEventId: id });
    };

    await deliver("failure");
    const fingerprint = `deployment:${repoId}:production`;
    let issue = (
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fingerprint))
    )[0];
    expect(issue).toMatchObject({ projectId, state: "open", severity: "error" });
    await deliver("success");
    issue = (
      await db.select().from(platformIssues).where(eq(platformIssues.fingerprint, fingerprint))
    )[0];
    expect(issue?.state).toBe("resolved");

    const preview = await createPreviewRecord(db, {
      orgId: org.id,
      projectId,
      repoId,
      prNumber: 17,
      image: "ghcr.io/example/app:sha",
      port: 3000,
      ttlHours: 24,
      createdBy: { type: "system", id: "test" },
    });
    if (!preview) throw new Error("preview fixture missing");
    const closedId = newId("evt");
    await db.insert(inboundEvents).values({
      id: closedId,
      orgId: org.id,
      integrationId: integration.id,
      verified: true,
      eventType: "pull_request",
      payload: {
        action: "closed",
        repository: { owner: { login: "octo" }, name: repoName },
        pull_request: {
          number: 17,
          merged: true,
          head: { ref: "feature/semantic-preview-branch" },
          created_at: "2026-07-19T00:00:00Z",
          closed_at: "2026-07-19T01:00:00Z",
        },
      },
    });
    const lifecycleJobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
    await processGithubWebhook(
      db,
      config,
      { inboundEventId: closedId },
      async () =>
        ({
          rest: {
            pulls: {
              listReviews: async () => ({ data: [] }),
              listCommits: async () => ({ data: [] }),
            },
          },
        }) as never,
      async (queue, data) => {
        lifecycleJobs.push({ queue, data });
        return null;
      },
    );
    expect(lifecycleJobs).toContainEqual({
      queue: "previews.destroy",
      data: { previewId: preview.id },
    });
  });

  it("dispatches the configured review agent for a newly opened non-draft PR", async () => {
    const org = (await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1))[0];
    if (!org) throw new Error("seeded org missing");
    const installation = (
      await db
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.orgId, org.id))
        .limit(1)
    )[0];
    const contract = (
      await db
        .select()
        .from(registryItems)
        .where(and(eq(registryItems.orgId, org.id), eq(registryItems.name, "prompts/review")))
        .limit(1)
    )[0];
    if (!installation || !contract) throw new Error("review fixtures missing");
    const suffix = newId("evt");
    const projectId = newId("proj");
    const repoName = `review-${suffix}`;
    await db.insert(projects).values({
      id: projectId,
      orgId: org.id,
      name: "Review dispatch",
      slug: `review-dispatch-${suffix}`,
      settings: {},
    });
    await db.insert(repos).values({
      id: newId("repo"),
      orgId: org.id,
      projectId,
      installationId: installation.id,
      owner: "octo",
      name: repoName,
      defaultBranch: "main",
      renderAnswers: { execution_lane: { review: "platform" } },
    });
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId: org.id,
          projectId,
          name: "review",
          engine: "codex",
          model: { primary: "gpt-test" },
          contractItemId: contract.id,
          triggers: [{ type: "github", event: "pull_request", action: "ready_for_review" }],
          permissions: ["runs:read"],
        })
        .returning()
    )[0];
    if (!agent) throw new Error("review agent fixture missing");
    const producingRunId = newId("run");
    await db.insert(runs).values({
      id: producingRunId,
      orgId: org.id,
      projectId,
      mode: "builder",
      engine: "codex",
      status: "succeeded",
      trigger: {
        source: "plan_acceptance",
        approvedPlan: "1. Add subtract.\n2. Prove it with the configured checks.",
        architectTrigger: {
          request: {
            title: "Add integer subtraction",
            body: "Support negative results.",
            comment: "/codex-architect",
          },
        },
      },
      gh: { owner: "octo", repo: repoName, branch: "feature/2-subtraction" },
      createdBy: { type: "github", id: "facility-bot" },
    });
    await db.insert(runs).values({
      id: newId("run"),
      orgId: org.id,
      projectId,
      mode: "review",
      engine: "codex",
      status: "succeeded",
      trigger: { type: "github_event", event: "pull_request", action: "opened" },
      gh: { owner: "octo", repo: repoName, branch: "feature/2-subtraction" },
      createdBy: { type: "github", id: "facility-bot" },
      createdAt: new Date(Date.now() + 1_000),
    });
    const repairRunId = newId("run");
    await db.insert(runs).values({
      id: repairRunId,
      orgId: org.id,
      projectId,
      mode: "address_review",
      engine: "codex",
      status: "succeeded",
      trigger: {
        type: "github_event",
        event: "pull_request_review",
        action: "submitted",
        review: { id: 77, body: "Add negative and zero cases.", state: "changes_requested" },
      },
      receipt: {
        result: "succeeded",
        checks: [{ name: "pnpm test", status: "passed" }],
        integrity: { payload_sha256: "repair-sha" },
      },
      gh: { owner: "octo", repo: repoName, branch: "feature/2-subtraction" },
      createdBy: { type: "github", id: "facility-bot" },
      createdAt: new Date(Date.now() + 2_000),
    });
    const integration = (
      await db
        .insert(integrations)
        .values({ id: newId("int"), orgId: org.id, kind: "github", name: suffix })
        .returning()
    )[0];
    if (!integration) throw new Error("integration fixture missing");
    const eventId = newId("evt");
    await db.insert(inboundEvents).values({
      id: eventId,
      orgId: org.id,
      integrationId: integration.id,
      verified: true,
      eventType: "pull_request",
      payload: {
        action: "opened",
        installation: { id: installation.installationId },
        sender: { login: "facility-bot", type: "Bot" },
        repository: { owner: { login: "octo" }, name: repoName },
        pull_request: {
          number: 4,
          title: "feat: subtraction",
          body: "Closes #2",
          draft: false,
          html_url: `https://github.com/octo/${repoName}/pull/4`,
          base: { ref: "main" },
          head: { ref: "feature/2-subtraction", sha: "abc123" },
        },
      },
    });
    const jobs: Array<{ queue: string; data: Record<string, unknown> }> = [];
    await processGithubWebhook(
      db,
      config,
      { inboundEventId: eventId },
      async () =>
        ({
          rest: {
            issues: {
              createComment: async () => ({
                data: { id: 91, html_url: `https://github.com/octo/${repoName}/pull/4#comment-91` },
              }),
            },
          },
        }) as never,
      async (queue, data) => {
        jobs.push({ queue, data });
        return null;
      },
    );
    const [run] = await db.select().from(runs).where(eq(runs.agentDefId, agent.id));
    expect(run).toMatchObject({
      mode: "review",
      engine: "codex",
      gh: {
        owner: "octo",
        repo: repoName,
        issueNumber: 4,
        branch: "feature/2-subtraction",
        progressComment: { id: 91 },
      },
      trigger: {
        type: "github_event",
        event: "pull_request",
        action: "opened",
        pullRequest: { number: 4, head: "feature/2-subtraction", headSha: "abc123" },
        deliveryContext: {
          producingRunId,
          originalRequest: {
            title: "Add integer subtraction",
            body: "Support negative results.",
            comment: "/codex-architect",
          },
          approvedPlan: "1. Add subtract.\n2. Prove it with the configured checks.",
          followUpRuns: [
            {
              runId: repairRunId,
              mode: "address_review",
              review: {
                id: 77,
                body: "Add negative and zero cases.",
                state: "changes_requested",
              },
              workflowRun: {},
              receipt: {
                result: "succeeded",
                checks: [{ name: "pnpm test", status: "passed" }],
                payloadSha256: "repair-sha",
              },
            },
          ],
        },
      },
    });
    expect(jobs).toContainEqual({
      queue: "runs.dispatch",
      data: { runId: run?.id, orgId: org.id },
    });
  });

  it("matches only start-of-line slash commands and detects ambiguity", () => {
    expect(resolveSlashCommand("please ask /architect")).toEqual({ ambiguous: false });
    expect(resolveSlashCommand("/architect\n\ncontext")).toEqual({
      command: "architect",
      agentCommand: "architect",
      ambiguous: false,
    });
    expect(resolveSlashCommand("/architect\n/builder")).toEqual({ ambiguous: true });
    expect(resolveSlashCommand("/codex-builder: go")).toEqual({
      command: "builder",
      agentCommand: "codex-builder",
      ambiguous: false,
    });
    expect(resolveSlashCommand("/builder prop_plan_75389e0c0f8f42e0a2c33ae410a7cb9f")).toEqual({
      command: "builder",
      agentCommand: "builder",
      proposalId: "prop_plan_75389e0c0f8f42e0a2c33ae410a7cb9f",
      ambiguous: false,
    });
    expect(resolveSlashCommand("/architect")).toEqual({
      command: "architect",
      agentCommand: "architect",
      ambiguous: false,
    });
    expect(resolveSlashCommand("/builder prop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual({
      command: "builder",
      agentCommand: "builder",
      proposalId: "prop_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ambiguous: false,
    });
    expect(resolveSlashCommand("/builder prop_a\n/builder prop_b")).toEqual({ ambiguous: true });
  });

  it("routes only creation actions and denies replay-prone GitHub updates", async () => {
    const issue = {
      issue: { number: 42, title: "/architect", body: "Plan it" },
      repository: { owner: { login: "octo" }, name: "repo" },
      sender: { login: "writer", type: "User" },
    };
    await expect(
      routeTrigger({} as never, "org_test", {} as never, { ...issue, action: "edited" }),
    ).resolves.toEqual({ routed: false, reason: "unsupported_action" });
    await expect(
      routeTrigger({} as never, "org_test", {} as never, {
        ...issue,
        action: "edited",
        comment: { id: 7, body: "/architect" },
      }),
    ).resolves.toEqual({ routed: false, reason: "unsupported_action" });
  });

  it("validates the repository-owned platform lane manifest", () => {
    expect(
      parseFacilityRepoManifest(
        JSON.stringify({
          packageInstall: "pnpm install --frozen-lockfile",
          provision: "pnpm run local:setup:ui",
          checks: ["pnpm verify"],
          models: { build: "opusplan", plan: "claude-fable-5" },
          executionLane: {
            architect: "platform",
            builder: "platform",
            review: "repo",
          },
        }),
      ),
    ).toEqual({
      packageInstall: "pnpm install --frozen-lockfile",
      provision: "pnpm run local:setup:ui",
      checks: ["pnpm verify"],
      models: { build: "opusplan", plan: "claude-fable-5" },
      executionLane: { architect: "platform", builder: "platform", review: "repo" },
    });
    expect(() =>
      parseFacilityRepoManifest(JSON.stringify({ executionLane: { review: "sometimes" } })),
    ).toThrow("executionLane values must be repo or platform");
  });

  it("reconciles the repository manifest at handoff time and fails closed when removed", async () => {
    const org = (await db.select().from(orgs).orderBy(asc(orgs.createdAt)).limit(1))[0];
    if (!org) throw new Error("seeded org missing");
    const suffix = newId("evt");
    const projectId = newId("proj");
    const repoId = newId("repo");
    await db.insert(projects).values({
      id: projectId,
      orgId: org.id,
      name: "Manifest handoff",
      slug: `manifest-handoff-${suffix}`,
      settings: {},
    });
    const [repo] = await db
      .insert(repos)
      .values({
        id: repoId,
        orgId: org.id,
        projectId,
        owner: "octo",
        name: `manifest-${suffix}`,
        defaultBranch: "main",
        renderAnswers: { execution_lane: { architect: "repo" }, preserved: true },
      })
      .returning();
    if (!repo) throw new Error("manifest repo missing");
    const manifest = JSON.stringify({
      packageInstall: "pnpm install --frozen-lockfile",
      provision: "pnpm run local:setup:ui",
      checks: ["pnpm verify"],
      executionLane: { architect: "platform", builder: "platform" },
    });
    const facilityClient = new FacilityGithubClient(
      {
        rest: {
          repos: {
            getContent: async () => ({
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(manifest).toString("base64"),
              },
            }),
          },
        },
      } as never,
      { owner: repo.owner, repo: repo.name, defaultBranch: repo.defaultBranch },
    );

    await expect(
      syncRepoFacilityConfig({ db, client: facilityClient, repo }),
    ).resolves.toMatchObject({
      packageInstallCmd: "pnpm install --frozen-lockfile",
      provisionCmd: "pnpm run local:setup:ui",
      checkCmds: ["pnpm verify"],
      execution_lane: { architect: "platform", builder: "platform" },
      preserved: true,
    });
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project?.settings).toEqual({});

    const [syncedRepo] = await db.select().from(repos).where(eq(repos.id, repoId));
    if (!syncedRepo) throw new Error("synced repo missing");
    const laneOnlyClient = new FacilityGithubClient(
      {
        rest: {
          repos: {
            getContent: async () => ({
              data: {
                type: "file",
                encoding: "base64",
                content: Buffer.from(
                  JSON.stringify({ executionLane: { architect: "platform" } }),
                ).toString("base64"),
              },
            }),
          },
        },
      } as never,
      { owner: repo.owner, repo: repo.name, defaultBranch: repo.defaultBranch },
    );
    await syncRepoFacilityConfig({ db, client: laneOnlyClient, repo: syncedRepo });
    const [clearedRepo] = await db.select().from(repos).where(eq(repos.id, repoId));
    expect(clearedRepo?.renderAnswers).toMatchObject({
      packageInstallCmd: null,
      provisionCmd: null,
      checkCmds: [],
      models: {},
      execution_lane: { architect: "platform" },
      preserved: true,
    });
    if (!clearedRepo) throw new Error("cleared repo missing");
    const missingClient = new FacilityGithubClient(
      {
        rest: {
          repos: {
            getContent: async () => {
              throw Object.assign(new Error("not found"), { status: 404 });
            },
          },
        },
      } as never,
      { owner: repo.owner, repo: repo.name, defaultBranch: repo.defaultBranch },
    );
    await syncRepoFacilityConfig({ db, client: missingClient, repo: clearedRepo });
    const [optedOutRepo] = await db.select().from(repos).where(eq(repos.id, repoId));
    expect(optedOutRepo?.renderAnswers).toMatchObject({
      packageInstallCmd: null,
      provisionCmd: null,
      checkCmds: [],
      models: {},
      execution_lane: {},
      preserved: true,
    });
  });

  it("preserves the end-user GitHub request for the platform agent", () => {
    expect(
      githubRequestContext(
        {
          issue: {
            number: 42,
            title: "Add subtraction",
            body: "Support negative results.",
            user: { login: "ada" },
            labels: [{ name: "delivery" }, "platform"],
            html_url: "https://github.test/octo/repo/issues/42",
          },
          comment: { id: 7, body: "/codex-architect\nKeep the public API stable." },
        },
        [
          {
            id: 6,
            author: "grace",
            authorType: "User",
            body: "Preserve compatibility.",
            createdAt: "2026-08-01T00:00:00Z",
            url: "https://github.test/comments/6",
          },
        ],
      ),
    ).toEqual({
      title: "Add subtraction",
      body: "Support negative results.",
      comment: "/codex-architect\nKeep the public API stable.",
      author: "ada",
      url: "https://github.test/octo/repo/issues/42",
      labels: ["delivery", "platform"],
      comments: [
        {
          id: 6,
          author: "grace",
          authorType: "User",
          body: "Preserve compatibility.",
          createdAt: "2026-08-01T00:00:00Z",
          url: "https://github.test/comments/6",
        },
      ],
    });
    expect(() => assertGithubRequestContextSize({ body: "x".repeat(512 * 1024) })).toThrow(
      "complete GitHub issue context is too large",
    );
  });

  it("reviews every current non-draft PR head while leaving drafts alone", () => {
    const triggers = [{ type: "github", event: "pull_request", action: "ready_for_review" }];
    for (const action of ["opened", "reopened", "synchronize", "ready_for_review"]) {
      expect(
        githubEventMatches(triggers, "pull_request", {
          action,
          pull_request: { draft: false },
        }),
      ).toBe(true);
    }
    expect(
      githubEventMatches(triggers, "pull_request", {
        action: "synchronize",
        pull_request: { draft: true },
      }),
    ).toBe(false);
    expect(
      githubEventMatches(triggers, "pull_request", {
        action: "closed",
        pull_request: { draft: false },
      }),
    ).toBe(false);
  });

  it("refuses write operations against the default branch", async () => {
    const octokit = {
      rest: {
        git: {
          createRef: async () => ({ data: {} }),
          updateRef: async () => ({ data: {} }),
        },
        pulls: {
          create: async () => ({ data: { number: 1, html_url: "https://example.test/pr/1" } }),
        },
      },
    } as never;
    const client = new FacilityGithubClient(octokit, {
      owner: "octo",
      repo: "repo",
      defaultBranch: "main",
    });
    await expect(client.createBranch("main", "abc")).rejects.toThrow(/default branch/);
    await expect(client.updateBranch("refs/heads/main", "abc")).rejects.toThrow(/default branch/);
    await expect(client.createPullRequest({ title: "x", body: "x", head: "main" })).rejects.toThrow(
      /default branch/,
    );
  });
});
