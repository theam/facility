import { createHash } from "node:crypto";
import { generateApiKey, newId, sealFacilityReceipt } from "@facility/core";
import {
  actionTypes,
  agentDefs,
  apiKeys,
  auditEvents,
  createDb,
  type FacilityDb,
  ghIssues,
  migrate,
  orgs,
  projects,
  proposalEvents,
  proposals,
  registryItems,
  registryVersions,
  repos,
  roles,
  runEvents,
  runRepositoryWriteLeases,
  runs,
  sandboxProfiles,
  virtualKeys,
} from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { resolveBuilderPlanFreshnessForProposal } from "../src/builder-plan-freshness.js";
import {
  assertBuilderPlanDispatch,
  lockBuilderPlanPolicy,
  withBuilderPlanPreflight,
} from "../src/builder-plan-policy.js";
import { ApiError } from "../src/errors.js";
import { githubIssueRevisionSha256 } from "../src/github/issue-revision.js";
import { syncRepoFacilityConfig } from "../src/github/kickstart.js";
import { routeTrigger, type TriggerPayload } from "../src/github/router.js";
import {
  createGovernedBuilderRetry,
  validateGovernedRetryForDispatch,
} from "../src/governed-builder-retry.js";
import type { SandboxDriver } from "../src/sandbox/driver.js";
import { dispatchRun } from "../src/sandbox/orchestrator.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";

async function canConnect() {
  const sqlClient = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try {
    await sqlClient`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sqlClient.end().catch(() => undefined);
  }
}

describe("builder plan policy integration", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; Builder plan tests skipped", () => undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);

  beforeAll(async () => {
    await migrate(databaseUrl);
  });

  afterAll(async () => {
    await client.end();
  });

  it("allows one canonical, fresh plan acceptance and rejects a second consumption", async () => {
    const fixture = await canonicalFixture();
    await expect(assertBuilderPlanDispatch(db, fixture.dispatch)).resolves.toEqual({
      mode: "builder",
      isBuilder: true,
    });

    const linkedRunId = newId("run");
    await db.insert(runs).values({
      id: linkedRunId,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      mode: "builder",
      engine: "codex",
      trigger: fixture.dispatch.trigger,
      gh: fixture.dispatch.gh,
      createdBy: { type: "user", id: "approver" },
    });
    await db
      .update(proposals)
      .set({ state: "executed" })
      .where(eq(proposals.id, fixture.proposalId));

    await expect(
      assertBuilderPlanDispatch(db, { ...fixture.dispatch, runId: linkedRunId }),
    ).resolves.toEqual({ mode: "builder", isBuilder: true });
    const before = await projectRuns(fixture.orgId, fixture.projectId);
    await expect(assertBuilderPlanDispatch(db, fixture.dispatch)).rejects.toMatchObject({
      code: "builder_plan_already_consumed",
    });
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
    await expect(lastDenialCode(fixture.orgId)).resolves.toBe("builder_plan_already_consumed");

    const original = (
      await db.select().from(proposals).where(eq(proposals.id, fixture.proposalId)).limit(1)
    )[0];
    if (!original) throw new Error("original proposal fixture missing");
    const duplicateProposalId = newId("prop");
    await db.insert(proposals).values({
      ...original,
      id: duplicateProposalId,
      state: "executing",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(proposalEvents).values([
      {
        orgId: fixture.orgId,
        proposalId: duplicateProposalId,
        seq: 1,
        type: "open",
        actor: { type: "agent", id: original.runId },
        data: { source: "architect_run" },
      },
      {
        orgId: fixture.orgId,
        proposalId: duplicateProposalId,
        seq: 2,
        type: "approved",
        actor: { type: "user", id: "approver" },
        data: {},
      },
    ]);
    await expect(
      assertBuilderPlanDispatch(db, {
        ...fixture.dispatch,
        trigger: { ...fixture.dispatch.trigger, proposalId: duplicateProposalId },
      }),
    ).rejects.toMatchObject({ code: "builder_plan_already_consumed" });
  });

  it("keeps an approved plan fresh across Facility queued-run acknowledgements", async () => {
    const fixture = await canonicalFixture();
    const proposal = (
      await db.select().from(proposals).where(eq(proposals.id, fixture.proposalId)).limit(1)
    )[0];
    if (!proposal) throw new Error("proposal fixture missing");
    const repoName = `plan-${fixture.orgId.replace("org_plan_", "")}`;
    const freshnessEvidence = await resolveBuilderPlanFreshnessForProposal(db, proposal, {
      githubClient: {
        owner: "facility-test",
        repo: repoName,
        client: {
          getDefaultBranchSha: async () => fixture.dispatch.freshnessEvidence.baseSha,
          getIssue: async () => ({
            number: 204,
            title: "Require a plan",
            body: "Implement it",
            state: "open",
            user: { login: "requester" },
            labels: [],
            html_url: `https://github.test/facility-test/${repoName}/issues/204`,
          }),
          listIssueComments: async () => [
            {
              id: 9001,
              author: "facility-agent[bot]",
              authorType: "Bot",
              body: "<!-- facility-run-queued run=run_01slash -->\nFacility queued /architect run run_01slash (triggered from the control plane).",
              createdAt: "2026-08-29T17:46:47Z",
              url: "https://github.test/comments/9001",
            },
            {
              id: 9002,
              author: "facility-agent[bot]",
              authorType: "Bot",
              body: "<!-- facility-run-queued run=run_01custom -->\nFacility queued release planner run run_01custom (triggered through an approved MCP proposal).",
              createdAt: "2026-08-29T17:46:48Z",
              url: "https://github.test/comments/9002",
            },
            {
              id: 9003,
              author: "facility-agent[bot]",
              authorType: "Bot",
              body: "Facility queued architect.v2 run run_01legacy (triggered from the control plane).",
              createdAt: "2026-08-29T17:46:49Z",
              url: "https://github.test/comments/9003",
            },
          ],
        },
      },
    });

    await expect(
      assertBuilderPlanDispatch(db, { ...fixture.dispatch, freshnessEvidence }),
    ).resolves.toEqual({ mode: "builder", isBuilder: true });
  });

  it("recognizes a Builder by agentDefId when the run mode is a surface alias", async () => {
    const fixture = await canonicalFixture();
    const contractId = newId("item");
    const agentDefId = newId("agent");
    await db.insert(registryItems).values({
      id: contractId,
      orgId: fixture.orgId,
      scope: "project",
      projectId: fixture.projectId,
      kind: "contract",
      name: "builder-contract",
    });
    await db.insert(agentDefs).values({
      id: agentDefId,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      name: "codex-builder",
      engine: "codex",
      model: { primary: "gpt-5" },
      contractItemId: contractId,
    });
    const before = await projectRuns(fixture.orgId, fixture.projectId);
    await expect(
      assertBuilderPlanDispatch(db, {
        orgId: fixture.orgId,
        projectId: fixture.projectId,
        mode: "conversation",
        agentDefId,
        trigger: { type: "conversation", message: "try to hide the role" },
        actor: { type: "system", id: "integration-test" },
        source: "integration_test_alias",
      }),
    ).rejects.toMatchObject({ code: "builder_plan_required" });
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
  });

  it("recognizes a renamed Builder from its governed command trigger", async () => {
    const fixture = await canonicalFixture();
    const contractId = newId("item");
    const agentDefId = newId("agent");
    await db.insert(registryItems).values({
      id: contractId,
      orgId: fixture.orgId,
      scope: "project",
      projectId: fixture.projectId,
      kind: "contract",
      name: "renamed-builder-contract",
    });
    await db.insert(agentDefs).values({
      id: agentDefId,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      name: "implementation-agent",
      engine: "codex",
      model: { primary: "gpt-5" },
      contractItemId: contractId,
      triggers: [{ type: "command", handle: "/codex-builder" }],
    });
    await expect(
      assertBuilderPlanDispatch(db, {
        orgId: fixture.orgId,
        projectId: fixture.projectId,
        mode: "conversation",
        agentDefId,
        trigger: { type: "conversation", message: "renamed role bypass" },
        source: "integration_test_trigger_alias",
      }),
    ).rejects.toMatchObject({ code: "builder_plan_required" });
  });

  it("serializes policy activation ahead of preflight and leaves no denied run row", async () => {
    const fixture = await githubRouteFixture("open");
    let releaseActivation!: () => void;
    const holdActivation = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let activationLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      activationLocked = resolve;
    });
    const activation = db.transaction(async (transaction) => {
      const tx = transaction as unknown as FacilityDb;
      await lockBuilderPlanPolicy(tx, fixture.orgId, fixture.projectId);
      await tx
        .update(projects)
        .set({ builderPlanPolicy: "required" })
        .where(eq(projects.id, fixture.projectId));
      activationLocked();
      await holdActivation;
    });
    await locked;
    const before = await projectRuns(fixture.orgId, fixture.projectId);
    const denied = withBuilderPlanPreflight(
      db,
      {
        orgId: fixture.orgId,
        projectId: fixture.projectId,
        mode: "builder",
        agentDefId: fixture.builderAgentId,
        trigger: { type: "manual" },
        source: "activation_race_test",
      },
      (tx) =>
        tx
          .insert(runs)
          .values({
            id: newId("run"),
            orgId: fixture.orgId,
            projectId: fixture.projectId,
            agentDefId: fixture.builderAgentId,
            mode: "builder",
            engine: "codex",
            trigger: { type: "manual" },
            createdBy: { type: "system", id: "activation-race-test" },
          })
          .returning(),
    );
    const denialAssertion = expect(denied).rejects.toMatchObject({
      code: "builder_plan_required",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseActivation();
    await activation;

    await denialAssertion;
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
  });

  it("fails closed when agentDefId belongs to another project", async () => {
    const fixture = await canonicalFixture();
    const otherProjectId = newId("proj");
    await db.insert(projects).values({
      id: otherProjectId,
      orgId: fixture.orgId,
      name: "Other project",
      slug: `other-${crypto.randomUUID()}`,
    });
    const contractId = newId("item");
    const crossProjectAgentId = newId("agent");
    await db.insert(registryItems).values({
      id: contractId,
      orgId: fixture.orgId,
      scope: "project",
      projectId: otherProjectId,
      kind: "contract",
      name: `cross-project-${crypto.randomUUID()}`,
    });
    await db.insert(agentDefs).values({
      id: crossProjectAgentId,
      orgId: fixture.orgId,
      projectId: otherProjectId,
      name: "implementation-agent",
      engine: "codex",
      model: { primary: "gpt-5" },
      contractItemId: contractId,
      triggers: [{ type: "command", handle: "/builder" }],
    });

    await expect(
      assertBuilderPlanDispatch(db, {
        orgId: fixture.orgId,
        projectId: fixture.projectId,
        mode: "conversation",
        agentDefId: crossProjectAgentId,
        trigger: { type: "conversation" },
        source: "integration_test_cross_project_agent",
      }),
    ).rejects.toMatchObject({ code: "builder_plan_context_invalid" });
    await expect(lastDenialCode(fixture.orgId)).resolves.toBe("builder_plan_context_invalid");
  });

  it("does not accept a canonical proposal from another tenant or project", async () => {
    const source = await canonicalFixture();
    const target = await canonicalFixture();
    const before = await projectRuns(target.orgId, target.projectId);
    await expect(
      assertBuilderPlanDispatch(db, {
        ...target.dispatch,
        trigger: source.dispatch.trigger,
      }),
    ).rejects.toMatchObject({ code: "builder_plan_context_invalid" });
    expect(await projectRuns(target.orgId, target.projectId)).toHaveLength(before.length);
  });

  it("marks a required repository drifted before rejecting a malformed manifest", async () => {
    const fixture = await canonicalFixture();
    const repo = (
      await db.select().from(repos).where(eq(repos.projectId, fixture.projectId)).limit(1)
    )[0];
    if (!repo) throw new Error("manifest repo fixture missing");
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
        renderAnswers: {
          execution_lane: { builder: "platform", "codex-builder": "platform" },
        },
      })
      .where(eq(repos.id, repo.id));
    const client = {
      getContent: async () => ({
        type: "file",
        encoding: "base64",
        content: Buffer.from("{invalid").toString("base64"),
      }),
    } as never;

    await expect(syncRepoFacilityConfig({ db, client, repo })).rejects.toMatchObject({
      code: "builder_plan_platform_lane_required",
    });
    const updated = (
      await db
        .select({ status: repos.fingerprintStatus })
        .from(repos)
        .where(eq(repos.id, repo.id))
        .limit(1)
    )[0];
    expect(updated?.status).toBe("drifted");
  });

  it("routes GitHub /builder through the canonical executor and ignores a poisoned proposalId", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const poisonId = newId("run");
    await db.insert(runs).values({
      id: poisonId,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      mode: "project-owner",
      engine: "codex",
      trigger: { source: "manual", proposalId: fixture.proposalId },
      createdBy: { type: "user", id: "poison" },
    });
    const enqueued: Array<{ queue: string; data: Record<string, unknown> }> = [];
    const deliveryId = `delivery_${crypto.randomUUID()}`;

    const result = await routeTrigger(
      db,
      fixture.orgId,
      fixture.client,
      fixture.payload,
      async (queue, data) => {
        enqueued.push({ queue, data });
        return null;
      },
      deliveryId,
    );

    const denial = (
      await db
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, fixture.orgId),
            eq(auditEvents.action, "run.builder_plan_denied"),
          ),
        )
        .orderBy(desc(auditEvents.seq))
        .limit(1)
    )[0];
    const execution = (
      await db
        .select({ data: proposalEvents.data })
        .from(proposalEvents)
        .where(eq(proposalEvents.proposalId, fixture.proposalId))
        .orderBy(desc(proposalEvents.seq))
        .limit(1)
    )[0];
    expect(
      result.routed,
      JSON.stringify({ result, denial: denial?.payload, execution: execution?.data }),
    ).toBe(true);
    expect(result.runId).not.toBe(poisonId);
    const canonical = (
      await db
        .select()
        .from(runs)
        .where(eq(runs.id, result.runId ?? ""))
        .limit(1)
    )[0];
    expect(canonical?.trigger).toMatchObject({
      source: "plan_acceptance",
      proposalId: fixture.proposalId,
      architectRunId: fixture.architectRunId,
    });
    expect(enqueued).toEqual([
      { queue: "runs.dispatch", data: { runId: canonical?.id, orgId: fixture.orgId } },
    ]);
    const storedProposal = (
      await db.select().from(proposals).where(eq(proposals.id, fixture.proposalId)).limit(1)
    )[0];
    expect(storedProposal?.state).toBe("executed");
    const deliveryReplay = await routeTrigger(
      db,
      fixture.orgId,
      fixture.client,
      fixture.payload,
      async () => null,
      deliveryId,
    );
    expect(deliveryReplay).toMatchObject({
      routed: true,
      reason: "delivery_replayed",
      runId: canonical?.id,
    });
    const differentComment = await routeTrigger(db, fixture.orgId, fixture.client, {
      ...fixture.payload,
      comment: { id: 205, body: "/builder" },
    });
    expect(differentComment).toMatchObject({
      routed: false,
      reason: "builder_plan_already_consumed",
      runId: canonical?.id,
    });
    const decisions = (
      await db
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, fixture.orgId), eq(auditEvents.action, "hitl.decided")))
    ).filter((event) => (event.target as { id?: unknown }).id === fixture.proposalId);
    expect(decisions).toHaveLength(1);
  });

  it.each([
    {
      name: "default branch",
      drift: (fixture: Awaited<ReturnType<typeof githubRouteFixture>>) => {
        fixture.live.baseSha = "b".repeat(40);
      },
    },
    {
      name: "issue scope",
      drift: (fixture: Awaited<ReturnType<typeof githubRouteFixture>>) => {
        fixture.live.issueBody = "Implement it, plus a newly-added requirement.";
      },
    },
  ])("rejects a required GitHub approval when the live $name changed", async ({ drift }) => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    drift(fixture);
    const before = await projectRuns(fixture.orgId, fixture.projectId);

    const result = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);

    expect(result).toMatchObject({ routed: false, reason: "builder_plan_stale" });
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
    await expect(lastDenialCode(fixture.orgId)).resolves.toBe("builder_plan_stale");
    const denial = await lastDenialPayload(fixture.orgId);
    const provenance = fixture.dispatch.trigger.planProvenance as Record<string, unknown>;
    const expected = {
      baseSha: provenance.workspaceBaseSha,
      issueRevisionSha256: provenance.issueRevisionSha256,
    };
    const observed = denial.observedPlanInputs as Record<string, unknown>;
    expect(denial).toMatchObject({
      code: "builder_plan_stale",
      expectedPlanInputs: expected,
      observedPlanInputs: { checkedAt: expect.any(String) },
    });
    expect({
      baseSha: observed.baseSha,
      issueRevisionSha256: observed.issueRevisionSha256,
    }).not.toEqual(expected);
  });

  it("fails closed and audits a required approval when GitHub freshness is unavailable", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    fixture.live.issueError = new Error("GitHub fixture unavailable");
    const before = await projectRuns(fixture.orgId, fixture.projectId);

    const result = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);

    expect(result).toMatchObject({
      routed: false,
      reason: "builder_plan_freshness_unavailable",
    });
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
    await expect(lastDenialCode(fixture.orgId)).resolves.toBe("builder_plan_freshness_unavailable");
  });

  it.each([
    {
      name: "issue drift",
      expected: "builder_plan_stale",
      secondIssueBody: "Implement it, plus a requirement added during worker claim.",
      secondIssueError: null,
    },
    {
      name: "GitHub freshness outage",
      expected: "builder_plan_freshness_unavailable",
      secondIssueBody: null,
      secondIssueError: "GitHub fixture unavailable during worker claim",
    },
  ])("revalidates a required plan after the worker claim and launches no sandbox on $name", async ({
    expected,
    secondIssueBody,
    secondIssueError,
  }) => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    expect(routed).toMatchObject({ routed: true });
    if (!routed.runId) throw new Error("required Builder run was not created");

    const repository = fixture.payload.repository;
    const owner = repository?.owner?.login;
    const repo = repository?.name;
    if (!owner || !repo) throw new Error("worker freshness repository fixture missing");
    let issueReads = 0;
    let launches = 0;
    const workerClient = {
      getDefaultBranchSha: async () => fixture.live.baseSha,
      getIssue: async () => {
        issueReads += 1;
        if (issueReads === 2 && secondIssueError) throw new Error(secondIssueError);
        return {
          number: 204,
          title: "Require a plan",
          body: issueReads === 1 ? "Implement it" : secondIssueBody,
          state: "open",
          user: { login: "requester" },
          labels: [],
          html_url: `https://github.test/${owner}/${repo}/issues/204`,
        };
      },
      listIssueComments: async () => [
        {
          id: 204,
          author: "maintainer",
          authorType: "User",
          body: "/builder",
          createdAt: "2026-08-26T10:00:00Z",
          url: "https://github.test/comments/204",
        },
      ],
    };

    await expect(
      dispatchRun(
        { databaseUrl } as AppConfig,
        { runId: routed.runId, orgId: fixture.orgId },
        {
          githubClient: { owner, repo, client: workerClient },
          sandboxDriver: async () => {
            launches += 1;
            return {
              name: "docker",
              launch: async () => ({ ref: "must-not-launch" }),
              status: async () => "running",
              async *logs() {},
              stop: async () => undefined,
              destroy: async () => undefined,
            } as never;
          },
        },
      ),
    ).rejects.toMatchObject({ code: expected });
    expect(issueReads).toBe(2);
    expect(launches).toBe(0);
    expect(
      (
        await db
          .select({ status: runs.status, error: runs.error })
          .from(runs)
          .where(eq(runs.id, routed.runId))
          .limit(1)
      )[0],
    ).toEqual({ status: "failed", error: expected });
    await expect(lastDenialCode(fixture.orgId)).resolves.toBe(expected);
  });

  it("creates one clean governed successor under concurrent retry requests and revalidates it for dispatch", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    if (!routed.runId) throw new Error("governed retry root was not created");
    await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "running", repositoryWriteTrackingVersion: 1 })
      .where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, routed.runId));

    const repository = fixture.payload.repository;
    const owner = repository?.owner?.login;
    const repo = repository?.name;
    if (!owner || !repo) throw new Error("governed retry repository fixture missing");
    const options = { githubClient: { owner, repo, client: fixture.client } };
    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        createGovernedBuilderRetry(
          db,
          db,
          {
            orgId: fixture.orgId,
            projectId: fixture.projectId,
            parentRunId: routed.runId as string,
            actor: { type: "user", id: "approver" },
            reason: "Retry the failed tracked Builder",
          },
          options,
        ),
      ),
    );
    expect(new Set(attempts.map((attempt) => attempt.run.id)).size).toBe(1);
    expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
    const child = attempts[0]?.run;
    if (!child) throw new Error("governed retry child missing");
    expect(child).toMatchObject({
      retryOfRunId: routed.runId,
      status: "queued",
      sandbox: {},
      receipt: null,
      engineSessionId: null,
      transcriptUri: null,
      sessionStateUri: null,
      gh: { owner, repo, issueNumber: 204 },
    });
    expect(await db.select().from(runEvents).where(eq(runEvents.runId, child.id))).toEqual([
      expect.objectContaining({ seq: 1, type: "queued" }),
    ]);
    const retryAudits = await db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.orgId, fixture.orgId), eq(auditEvents.action, "run.retried")));
    expect(
      retryAudits.filter((event) => (event.target as { id?: unknown }).id === child.id),
    ).toHaveLength(1);

    const dispatchValidation = await validateGovernedRetryForDispatch(db, child, options);
    expect(dispatchValidation.lineage).toMatchObject({
      parent: { id: routed.runId, status: "failed" },
      root: { id: routed.runId },
      depth: 1,
    });
    await db
      .update(runs)
      .set({ gh: { owner, repo, issueNumber: 204, branch: "forged/output" } })
      .where(eq(runs.id, child.id));
    const forged = (await db.select().from(runs).where(eq(runs.id, child.id)).limit(1))[0];
    if (!forged) throw new Error("forged governed retry child missing");
    await expect(validateGovernedRetryForDispatch(db, forged, options)).rejects.toMatchObject({
      code: "governed_retry_lineage_invalid",
      details: { reason: "successor_not_clean" },
    });
    await db
      .update(runs)
      .set({ gh: { owner, repo, issueNumber: 204 } })
      .where(eq(runs.id, child.id));

    const retryConfig: AppConfig = {
      databaseUrl,
      secretMasterKey: Buffer.alloc(32, 7).toString("base64"),
      port: 0,
      publicUrl: "http://127.0.0.1:4400",
      webUrl: "http://127.0.0.1:4400",
      sandboxApiUrl: "http://127.0.0.1:4400",
      sandboxGatewayUrl: "http://127.0.0.1:4410",
      gatewayUrl: "http://127.0.0.1:4410",
      sandboxRunnerImage: "facility-runner:test",
      sandboxDriver: "docker",
      facilityInsecureDev: true,
      packageRegistryToken: "package-token",
      governedBuilderRetryPromotionEnabled: true,
      logLevel: "silent",
    };
    const roleId = newId("role");
    await db.insert(roles).values({
      id: roleId,
      orgId: fixture.orgId,
      name: `governed-retry-${crypto.randomUUID()}`,
      permissions: ["runs:trigger"],
    });
    const retryKey = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: retryKey.id,
      orgId: fixture.orgId,
      name: "governed retry integration",
      prefix: retryKey.lookup,
      last4: retryKey.last4,
      hash: retryKey.hash,
      scopeType: "project",
      projectId: fixture.projectId,
      roleId,
      createdBy: "integration-test",
    });
    const foreignOrgId = newId("org");
    const foreignProjectId = newId("proj");
    const foreignRoleId = newId("role");
    await db.insert(orgs).values({
      id: foreignOrgId,
      name: "Foreign retry tenant",
      slug: `foreign-retry-${crypto.randomUUID()}`,
    });
    await db.insert(projects).values({
      id: foreignProjectId,
      orgId: foreignOrgId,
      name: "Foreign retry project",
      slug: `foreign-retry-${crypto.randomUUID()}`,
    });
    await db.insert(roles).values({
      id: foreignRoleId,
      orgId: foreignOrgId,
      name: `foreign-retry-${crypto.randomUUID()}`,
      permissions: ["runs:trigger"],
    });
    const foreignKey = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: foreignKey.id,
      orgId: foreignOrgId,
      name: "foreign governed retry integration",
      prefix: foreignKey.lookup,
      last4: foreignKey.last4,
      hash: foreignKey.hash,
      scopeType: "project",
      projectId: foreignProjectId,
      roleId: foreignRoleId,
      createdBy: "integration-test",
    });
    const app = await buildApp(retryConfig);
    let enqueueAttempts = 0;
    app.enqueue = async () => {
      enqueueAttempts += 1;
      if (enqueueAttempts === 1) throw new Error("simulated_broker_outage");
      return `job_${enqueueAttempts}`;
    };
    await app.ready();
    try {
      const crossTenant = await app.inject({
        method: "POST",
        url: `/v1/runs/${routed.runId}/retry`,
        headers: {
          authorization: `Bearer ${foreignKey.secret}`,
          "idempotency-key": `governed-retry-foreign-${crypto.randomUUID()}`,
        },
      });
      expect(crossTenant.statusCode).toBe(404);
      expect(crossTenant.json().error.code).toBe("run_not_found");
      expect(enqueueAttempts).toBe(0);
      const idempotencyKey = `governed-retry-adopt-${crypto.randomUUID()}`;
      const failedEnqueue = await app.inject({
        method: "POST",
        url: `/v1/runs/${routed.runId}/retry`,
        headers: {
          authorization: `Bearer ${retryKey.secret}`,
          "idempotency-key": idempotencyKey,
        },
      });
      expect(failedEnqueue.statusCode).toBe(500);
      const adopted = await app.inject({
        method: "POST",
        url: `/v1/runs/${routed.runId}/retry`,
        headers: {
          authorization: `Bearer ${retryKey.secret}`,
          "idempotency-key": idempotencyKey,
        },
      });
      expect(adopted.statusCode, adopted.body).toBe(200);
      expect(adopted.json()).toMatchObject({ id: child.id, retryOfRunId: routed.runId });
      expect(enqueueAttempts).toBe(2);
      expect(
        await db
          .select({ id: runs.id })
          .from(runs)
          .where(eq(runs.retryOfRunId, routed.runId as string)),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }

    const builderAgent = (
      await db
        .select()
        .from(agentDefs)
        .where(eq(agentDefs.id, child.agentDefId ?? ""))
        .limit(1)
    )[0];
    if (!builderAgent) throw new Error("governed retry Builder agent missing");
    const profileId = newId("sbx");
    await db.insert(sandboxProfiles).values({
      id: profileId,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      name: "Governed retry integration",
      driver: "docker",
      image: "facility-runner:test",
      setup: {},
      resources: {},
      network: {},
    });
    await db
      .update(agentDefs)
      .set({ sandboxProfileId: profileId })
      .where(eq(agentDefs.id, builderAgent.id));
    await db.insert(registryVersions).values({
      id: newId("ver"),
      orgId: fixture.orgId,
      itemId: builderAgent.contractItemId,
      version: 1,
      content: "Implement only the approved plan.",
      contentHash: createHash("sha256").update("Implement only the approved plan.").digest("hex"),
      status: "active",
      createdBy: "integration-test",
    });
    let launches = 0;
    const driver: SandboxDriver = {
      name: "docker",
      launch: async () => {
        launches += 1;
        return { ref: `governed-retry-${launches}` };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    await Promise.all([
      dispatchRun(
        retryConfig,
        { runId: child.id, orgId: fixture.orgId },
        {
          githubClient: options.githubClient,
          sandboxDriver: async () => driver,
        },
      ),
      dispatchRun(
        retryConfig,
        { runId: child.id, orgId: fixture.orgId },
        {
          githubClient: options.githubClient,
          sandboxDriver: async () => driver,
        },
      ),
    ]);
    expect(launches).toBe(1);
    expect(
      await db
        .select({ id: virtualKeys.id })
        .from(virtualKeys)
        .where(eq(virtualKeys.runId, child.id)),
    ).toHaveLength(1);
    expect(
      await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.runId, child.id)),
    ).toHaveLength(1);
    expect(
      (
        await db
          .select({ status: runs.status, sandbox: runs.sandbox })
          .from(runs)
          .where(eq(runs.id, child.id))
          .limit(1)
      )[0],
    ).toMatchObject({ status: "provisioning", sandbox: { ref: "governed-retry-1" } });
  });

  it("fails a governed retry worker on post-creation drift before credentials or sandbox launch", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    if (!routed.runId) throw new Error("governed retry drift root was not created");
    await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "running", repositoryWriteTrackingVersion: 1 })
      .where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, routed.runId));
    const owner = fixture.payload.repository?.owner?.login;
    const repo = fixture.payload.repository?.name;
    if (!owner || !repo) throw new Error("governed retry drift repository missing");
    const child = (
      await createGovernedBuilderRetry(
        db,
        db,
        {
          orgId: fixture.orgId,
          projectId: fixture.projectId,
          parentRunId: routed.runId,
          actor: { type: "user", id: "approver" },
        },
        { githubClient: { owner, repo, client: fixture.client } },
      )
    ).run;
    await db
      .update(repos)
      .set({ fingerprintStatus: "drifted", fingerprintVerifiedAt: new Date() })
      .where(eq(repos.projectId, fixture.projectId));

    let launches = 0;
    const driver: SandboxDriver = {
      name: "docker",
      launch: async () => {
        launches += 1;
        return { ref: "must-not-launch" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    await expect(
      dispatchRun(
        { databaseUrl } as AppConfig,
        { runId: child.id, orgId: fixture.orgId },
        {
          githubClient: { owner, repo, client: fixture.client },
          sandboxDriver: async () => driver,
        },
      ),
    ).rejects.toMatchObject({
      code: "governed_retry_lane_invalid",
      details: { reason: "repository_fingerprint_unverified" },
    });
    expect(launches).toBe(0);
    expect(
      await db
        .select({ id: virtualKeys.id })
        .from(virtualKeys)
        .where(eq(virtualKeys.runId, child.id)),
    ).toHaveLength(0);
    expect(
      await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.runId, child.id)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select({ status: runs.status, error: runs.error, sandbox: runs.sandbox })
          .from(runs)
          .where(eq(runs.id, child.id))
          .limit(1)
      )[0],
    ).toEqual({
      status: "failed",
      error: "governed_retry_lane_invalid:repository_fingerprint_unverified",
      sandbox: {},
    });
    const denials = await db
      .select({ target: auditEvents.target, payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, fixture.orgId),
          eq(auditEvents.action, "run.governed_retry_denied"),
        ),
      );
    expect(denials.filter((event) => (event.target as { id?: unknown }).id === child.id)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "governed_retry_lane_invalid",
          reason: "repository_fingerprint_unverified",
          source: "worker_claimed_governed_retry",
        }),
      }),
    ]);
  });

  it("rejects a forged successor of a legacy tracking-zero run before GitHub or launch", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    if (!routed.runId) throw new Error("legacy governed retry root was not created");
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, routed.runId));
    const parent = (await db.select().from(runs).where(eq(runs.id, routed.runId)).limit(1))[0];
    const repository = (
      await db.select().from(repos).where(eq(repos.projectId, fixture.projectId)).limit(1)
    )[0];
    if (!parent || !repository) throw new Error("legacy governed retry fixture missing");
    await db.insert(runRepositoryWriteLeases).values({
      id: newId("rwl"),
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      runId: parent.id,
      repoId: repository.id,
      provider: "github_installation",
      status: "issued",
      requestedBranch: "facility/legacy-fabricated",
      authorizedBranch: "facility/legacy-fabricated",
      baseSha: String(
        (parent.trigger as { planProvenance?: { workspaceBaseSha?: unknown } }).planProvenance
          ?.workspaceBaseSha,
      ),
      permissions: ["contents"],
      issuedAt: new Date(Date.now() - 60 * 60_000),
      expiresAt: new Date(Date.now() - 30 * 60_000),
    });
    const child = (
      await db
        .insert(runs)
        .values({
          id: newId("run"),
          orgId: parent.orgId,
          projectId: parent.projectId,
          retryOfRunId: parent.id,
          agentDefId: parent.agentDefId,
          mode: parent.mode,
          engine: parent.engine,
          trigger: parent.trigger,
          gh: { owner: repository.owner, repo: repository.name, issueNumber: 204 },
          createdBy: { type: "user", id: "forged-legacy-test" },
        })
        .returning()
    )[0];
    if (!child) throw new Error("forged legacy child missing");
    let githubCalls = 0;
    let launches = 0;
    const githubClient = {
      getDefaultBranchSha: async () => {
        githubCalls += 1;
        throw new Error("legacy retry reached GitHub");
      },
      getIssue: async () => {
        githubCalls += 1;
        throw new Error("legacy retry reached GitHub");
      },
      listIssueComments: async () => {
        githubCalls += 1;
        throw new Error("legacy retry reached GitHub");
      },
    } as never;
    const driver: SandboxDriver = {
      name: "docker",
      launch: async () => {
        launches += 1;
        return { ref: "must-not-launch" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    await expect(
      dispatchRun(
        { databaseUrl } as AppConfig,
        { runId: child.id, orgId: child.orgId },
        {
          githubClient: { owner: repository.owner, repo: repository.name, client: githubClient },
          sandboxDriver: async () => driver,
        },
      ),
    ).rejects.toMatchObject({
      code: "governed_retry_requires_fresh_gate1",
      details: {
        reason: "legacy_repository_write_tracking_unavailable",
        requiredAction: "run_architect_and_approve_new_plan",
      },
    });
    expect(githubCalls).toBe(0);
    expect(launches).toBe(0);
    expect(
      await db
        .select({ id: virtualKeys.id })
        .from(virtualKeys)
        .where(eq(virtualKeys.runId, child.id)),
    ).toHaveLength(0);
    expect(
      await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.runId, child.id)),
    ).toHaveLength(0);
  });

  it("revalidates repository output across every retry ancestor before worker credentials", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    if (!routed.runId) throw new Error("ancestor evidence root was not created");
    await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "running", repositoryWriteTrackingVersion: 1 })
      .where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, routed.runId));
    const repository = (
      await db.select().from(repos).where(eq(repos.projectId, fixture.projectId)).limit(1)
    )[0];
    const owner = fixture.payload.repository?.owner?.login;
    const repo = fixture.payload.repository?.name;
    if (!repository || !owner || !repo) throw new Error("ancestor evidence repository missing");
    const baseSha = fixture.live.baseSha;
    const authorizedBranch = `facility/ancestor-${crypto.randomUUID()}`;
    await db.insert(runRepositoryWriteLeases).values({
      id: newId("rwl"),
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      runId: routed.runId,
      repoId: repository.id,
      provider: "github_installation",
      status: "issued",
      requestedBranch: authorizedBranch,
      authorizedBranch,
      baseSha,
      permissions: ["contents"],
      issuedAt: new Date(Date.now() - 2 * 60 * 60_000),
      expiresAt: new Date(Date.now() - 60 * 60_000),
    });
    let remoteHead = baseSha;
    const repositoryWriteClient = {
      repoId: repository.id,
      client: {
        assertRepositoryAccessible: async () => undefined,
        getRef: async () => remoteHead,
        listPullRequestsForHead: async () => ({ pullRequests: [], hasNextPage: false }),
      },
    };
    const options = {
      githubClient: { owner, repo, client: fixture.client },
      repositoryWriteClient,
    };
    const firstChild = (
      await createGovernedBuilderRetry(
        db,
        db,
        {
          orgId: fixture.orgId,
          projectId: fixture.projectId,
          parentRunId: routed.runId,
          actor: { type: "user", id: "approver" },
        },
        options,
      )
    ).run;
    await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, firstChild.id));
    await db
      .update(runs)
      .set({ status: "running", repositoryWriteTrackingVersion: 1 })
      .where(eq(runs.id, firstChild.id));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, firstChild.id));
    const grandchild = (
      await createGovernedBuilderRetry(
        db,
        db,
        {
          orgId: fixture.orgId,
          projectId: fixture.projectId,
          parentRunId: firstChild.id,
          actor: { type: "user", id: "approver" },
        },
        options,
      )
    ).run;

    remoteHead = "b".repeat(40);
    let launches = 0;
    const driver: SandboxDriver = {
      name: "docker",
      launch: async () => {
        launches += 1;
        return { ref: "must-not-launch" };
      },
      status: async () => "running",
      async *logs() {},
      stop: async () => undefined,
      destroy: async () => undefined,
    };
    await expect(
      dispatchRun(
        { databaseUrl } as AppConfig,
        { runId: grandchild.id, orgId: fixture.orgId },
        {
          githubClient: options.githubClient,
          repositoryWriteClient,
          sandboxDriver: async () => driver,
        },
      ),
    ).rejects.toMatchObject({
      code: "governed_retry_durable_output",
      details: { reason: "remote_branch_or_pull_request_exists" },
    });
    expect(launches).toBe(0);
    expect(
      await db
        .select({ id: virtualKeys.id })
        .from(virtualKeys)
        .where(eq(virtualKeys.runId, grandchild.id)),
    ).toHaveLength(0);
    expect(
      await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.runId, grandchild.id)),
    ).toHaveLength(0);
    expect(
      (
        await db
          .select({ status: runs.status, error: runs.error, sandbox: runs.sandbox })
          .from(runs)
          .where(eq(runs.id, grandchild.id))
          .limit(1)
      )[0],
    ).toEqual({
      status: "failed",
      error: "governed_retry_durable_output:remote_branch_or_pull_request_exists",
      sandbox: {},
    });
    const denial = (
      await db
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, fixture.orgId),
            eq(auditEvents.action, "run.governed_retry_denied"),
          ),
        )
        .orderBy(desc(auditEvents.seq))
        .limit(1)
    )[0];
    expect(denial?.payload).toMatchObject({
      code: "governed_retry_durable_output",
      reason: "remote_branch_or_pull_request_exists",
      source: "worker_initial_governed_retry",
    });
  });

  it("denies a parallel governed retry when a legacy resume descendant already exists", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    if (!routed.runId) throw new Error("legacy descendant root was not created");
    await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "running", repositoryWriteTrackingVersion: 1 })
      .where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, routed.runId));
    const parent = (await db.select().from(runs).where(eq(runs.id, routed.runId)).limit(1))[0];
    if (!parent) throw new Error("legacy descendant parent missing");
    await db.insert(runs).values({
      id: newId("run"),
      orgId: parent.orgId,
      projectId: parent.projectId,
      agentDefId: parent.agentDefId,
      mode: parent.mode,
      engine: parent.engine,
      status: "succeeded",
      trigger: { type: "resume", resumeOf: parent.id },
      gh: {
        owner: fixture.payload.repository?.owner?.login,
        repo: fixture.payload.repository?.name,
        issueNumber: 204,
        branch: "facility/legacy-resume",
        pr: { number: 991 },
      },
      createdBy: { type: "user", id: "legacy-resume-user" },
      endedAt: new Date(),
    });
    const owner = fixture.payload.repository?.owner?.login;
    const repo = fixture.payload.repository?.name;
    if (!owner || !repo) throw new Error("legacy descendant repository missing");
    let githubCalls = 0;
    const noNetworkClient = {
      getDefaultBranchSha: async () => {
        githubCalls += 1;
        return fixture.live.baseSha;
      },
      getIssue: async () => {
        githubCalls += 1;
        return null;
      },
      listIssueComments: async () => {
        githubCalls += 1;
        return [];
      },
    } as never;

    await expect(
      createGovernedBuilderRetry(
        db,
        db,
        {
          orgId: fixture.orgId,
          projectId: fixture.projectId,
          parentRunId: parent.id,
          actor: { type: "user", id: "approver" },
        },
        { githubClient: { owner, repo, client: noNetworkClient } },
      ),
    ).rejects.toMatchObject({
      code: "governed_retry_durable_output",
      details: { reason: "legacy_resume_descendant_exists" },
    });
    expect(githubCalls).toBe(0);
    expect(
      await db.select({ id: runs.id }).from(runs).where(eq(runs.retryOfRunId, parent.id)),
    ).toHaveLength(0);
  });

  it("persists one sanitized Gate 1 denial after the retry transaction rolls back", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    if (!routed.runId) throw new Error("stale retry root was not created");
    await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "running", repositoryWriteTrackingVersion: 1 })
      .where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, routed.runId));
    fixture.live.issueBody = "The issue changed after the approved plan";
    const owner = fixture.payload.repository?.owner?.login;
    const repo = fixture.payload.repository?.name;
    if (!owner || !repo) throw new Error("stale retry repository missing");

    await expect(
      createGovernedBuilderRetry(
        db,
        db,
        {
          orgId: fixture.orgId,
          projectId: fixture.projectId,
          parentRunId: routed.runId,
          actor: { type: "user", id: "approver" },
        },
        { githubClient: { owner, repo, client: fixture.client } },
      ),
    ).rejects.toMatchObject({ code: "builder_plan_stale" });
    expect(
      await db.select({ id: runs.id }).from(runs).where(eq(runs.retryOfRunId, routed.runId)),
    ).toHaveLength(0);
    const denials = await db
      .select({ target: auditEvents.target, payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, fixture.orgId),
          eq(auditEvents.action, "run.builder_plan_denied"),
        ),
      );
    expect(
      denials.filter((event) => (event.target as { id?: unknown }).id === routed.runId),
    ).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          code: "builder_plan_stale",
          reason: "base_or_issue_revision_changed",
          source: "governed_retry_admission",
        }),
      }),
    ]);
  });

  it("allows the bounded lineage depth and rejects the next successor before GitHub", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(repos)
      .set({
        fingerprint: { files: [] },
        fingerprintStatus: "ok",
        fingerprintVerifiedAt: new Date(),
      })
      .where(eq(repos.projectId, fixture.projectId));
    const routed = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    if (!routed.runId) throw new Error("depth retry root was not created");
    await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "running", repositoryWriteTrackingVersion: 1 })
      .where(eq(runs.id, routed.runId));
    await db
      .update(runs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(runs.id, routed.runId));
    const owner = fixture.payload.repository?.owner?.login;
    const repo = fixture.payload.repository?.name;
    if (!owner || !repo) throw new Error("depth retry repository missing");
    let githubCalls = 0;
    const countingClient = {
      getDefaultBranchSha: async () => {
        githubCalls += 1;
        return fixture.live.baseSha;
      },
      getIssue: async (number: number) => {
        githubCalls += 1;
        return {
          number,
          title: "Require a plan",
          body: "Implement it",
          state: "open",
          user: { login: "requester" },
          labels: [],
          html_url: `https://github.test/${owner}/${repo}/issues/${number}`,
        };
      },
      listIssueComments: async () => {
        githubCalls += 1;
        return [
          {
            id: 204,
            author: "maintainer",
            authorType: "User",
            body: "/builder",
            createdAt: "2026-08-26T10:00:00Z",
            url: "https://github.test/comments/204",
          },
        ];
      },
    } as never;
    let parentRunId = routed.runId;
    for (let depth = 1; depth <= 100; depth += 1) {
      const next = (
        await createGovernedBuilderRetry(
          db,
          db,
          {
            orgId: fixture.orgId,
            projectId: fixture.projectId,
            parentRunId,
            actor: { type: "user", id: "approver" },
            reason: `bounded depth ${depth}`,
          },
          { githubClient: { owner, repo, client: countingClient } },
        )
      ).run;
      await db.update(runs).set({ status: "provisioning" }).where(eq(runs.id, next.id));
      await db
        .update(runs)
        .set({ status: "running", repositoryWriteTrackingVersion: 1 })
        .where(eq(runs.id, next.id));
      await db
        .update(runs)
        .set({ status: "failed", endedAt: new Date() })
        .where(eq(runs.id, next.id));
      parentRunId = next.id;
    }
    const githubCallsAtLimit = githubCalls;
    await expect(
      createGovernedBuilderRetry(
        db,
        db,
        {
          orgId: fixture.orgId,
          projectId: fixture.projectId,
          parentRunId,
          actor: { type: "user", id: "approver" },
        },
        { githubClient: { owner, repo, client: countingClient } },
      ),
    ).rejects.toMatchObject({
      code: "governed_retry_lineage_invalid",
      details: { reason: "lineage_depth_exceeded" },
    });
    expect(githubCalls).toBe(githubCallsAtLimit);
    expect(
      await db.select({ id: runs.id }).from(runs).where(eq(runs.retryOfRunId, parentRunId)),
    ).toHaveLength(0);
  }, 60_000);

  it("recovers an executing GitHub plan and a crash after the exact row was created", async () => {
    const executing = await githubRouteFixture("executing");
    const recovered = await routeTrigger(
      db,
      executing.orgId,
      executing.client,
      executing.payload,
      async () => null,
    );
    expect(recovered).toMatchObject({ routed: true });
    const recoveredRun = (
      await db
        .select()
        .from(runs)
        .where(eq(runs.id, recovered.runId ?? ""))
        .limit(1)
    )[0];
    expect(recoveredRun?.createdBy).toMatchObject({
      type: "user",
      id: "github:maintainer",
      proposalId: executing.proposalId,
    });
    expect(
      (await db.select().from(proposals).where(eq(proposals.id, executing.proposalId)).limit(1))[0]
        ?.state,
    ).toBe("executed");

    const crashed = await githubRouteFixture("executed");
    const exactId = newId("run");
    await db.insert(runs).values({
      id: exactId,
      orgId: crashed.orgId,
      projectId: crashed.projectId,
      agentDefId: crashed.builderAgentId,
      mode: "codex-builder",
      engine: "codex",
      status: "queued",
      trigger: crashed.dispatch.trigger,
      gh: crashed.dispatch.gh,
      createdBy: { type: "user", id: "approver" },
    });
    const jobs: Record<string, unknown>[] = [];
    const crashRecovery = await routeTrigger(
      db,
      crashed.orgId,
      crashed.client,
      crashed.payload,
      async (_queue, data) => {
        jobs.push(data);
        return null;
      },
      `delivery_${crypto.randomUUID()}`,
    );
    expect(crashRecovery).toMatchObject({ routed: true, runId: exactId });
    expect(jobs).toEqual([{ runId: exactId, orgId: crashed.orgId }]);
  });

  it("does not enqueue an exact queued row when proposal recovery fails the required gate", async () => {
    const fixture = await githubRouteFixture("execution_failed");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    const exactId = newId("run");
    await db.insert(runs).values({
      id: exactId,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      agentDefId: fixture.builderAgentId,
      mode: "builder",
      engine: "codex",
      status: "queued",
      trigger: fixture.dispatch.trigger,
      gh: fixture.dispatch.gh,
      createdBy: { type: "user", id: "github:maintainer" },
    });
    const jobs: Record<string, unknown>[] = [];
    const result = await routeTrigger(
      db,
      fixture.orgId,
      fixture.client,
      fixture.payload,
      async (_queue, data) => {
        jobs.push(data);
        return null;
      },
      `delivery_${crypto.randomUUID()}`,
    );

    expect(result).toMatchObject({
      routed: false,
      reason: "builder_plan_context_invalid",
    });
    expect(jobs).toHaveLength(0);
    expect(
      (await db.select({ status: runs.status }).from(runs).where(eq(runs.id, exactId)).limit(1))[0]
        ?.status,
    ).toBe("queued");
  });

  it("returns the stable expired code for a persisted expired GitHub proposal", async () => {
    const fixture = await githubRouteFixture("expired");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    const before = await projectRuns(fixture.orgId, fixture.projectId);
    const result = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    expect(result).toMatchObject({ routed: false, reason: "builder_plan_expired" });
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
  });

  it("returns the stable expired code when an open GitHub proposal has passed expiresAt", async () => {
    const fixture = await githubRouteFixture("open");
    await db
      .update(projects)
      .set({ builderPlanPolicy: "required" })
      .where(eq(projects.id, fixture.projectId));
    await db
      .update(proposals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(proposals.id, fixture.proposalId));
    const before = await projectRuns(fixture.orgId, fixture.projectId);
    const result = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    expect(result).toMatchObject({ routed: false, reason: "builder_plan_expired" });
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
  });

  it.each([
    "expired",
    "rejected",
    "canceled",
    "execution_failed",
  ] as const)("preserves optional-policy /builder compatibility after a %s proposal", async (state) => {
    const fixture = await githubRouteFixture(state);
    const result = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    expect(result).toMatchObject({ routed: true });
    const run = (
      await db
        .select()
        .from(runs)
        .where(eq(runs.id, result.runId ?? ""))
        .limit(1)
    )[0];
    expect(run?.trigger).toMatchObject({ type: "github_comment" });
    expect(run?.trigger).not.toMatchObject({ source: "plan_acceptance" });
  });

  it("persists the canonical Builder mode for a renamed optional GitHub agent", async () => {
    const fixture = await githubRouteFixture("rejected");
    await db
      .update(agentDefs)
      .set({
        name: "delivery-specialist",
        triggers: [{ type: "command", handle: "/builder" }],
      })
      .where(eq(agentDefs.id, fixture.builderAgentId));
    const result = await routeTrigger(db, fixture.orgId, fixture.client, fixture.payload);
    expect(result).toMatchObject({ routed: true });
    const run = (
      await db
        .select()
        .from(runs)
        .where(eq(runs.id, result.runId ?? ""))
        .limit(1)
    )[0];
    expect(run).toMatchObject({ mode: "builder", agentDefId: fixture.builderAgentId });
  });

  it.each([
    {
      name: "missing",
      expected: "builder_plan_required",
      arrange: async () => {
        const fixture = await canonicalFixture();
        return { fixture, dispatch: { ...fixture.dispatch, trigger: { type: "manual" } } };
      },
    },
    {
      name: "expired",
      expected: "builder_plan_expired",
      arrange: async () => {
        const fixture = await canonicalFixture({ expiresAt: new Date(Date.now() - 60_000) });
        return { fixture, dispatch: fixture.dispatch };
      },
    },
    {
      name: "persisted expired state",
      expected: "builder_plan_expired",
      arrange: async () => {
        const fixture = await canonicalFixture({ state: "expired" });
        return { fixture, dispatch: fixture.dispatch };
      },
    },
    {
      name: "rejected",
      expected: "builder_plan_rejected",
      arrange: async () => {
        const fixture = await canonicalFixture({ state: "rejected" });
        return { fixture, dispatch: fixture.dispatch };
      },
    },
    {
      name: "stale",
      expected: "builder_plan_stale",
      arrange: async () => {
        const fixture = await canonicalFixture();
        return {
          fixture,
          dispatch: {
            ...fixture.dispatch,
            freshnessEvidence: {
              ...fixture.dispatch.freshnessEvidence,
              baseSha: "b".repeat(40),
            },
          },
        };
      },
    },
    {
      name: "invalid canonical context",
      expected: "builder_plan_context_invalid",
      arrange: async () => {
        const fixture = await canonicalFixture();
        return {
          fixture,
          dispatch: {
            ...fixture.dispatch,
            trigger: { ...fixture.dispatch.trigger, planSha256: "f".repeat(64) },
          },
        };
      },
    },
    {
      name: "non-human approval principal",
      expected: "builder_plan_context_invalid",
      arrange: async () => {
        const fixture = await canonicalFixture();
        await db
          .update(proposalEvents)
          .set({ actor: { type: "key", id: "approver" } })
          .where(
            and(
              eq(proposalEvents.proposalId, fixture.proposalId),
              eq(proposalEvents.type, "approved"),
            ),
          );
        return { fixture, dispatch: fixture.dispatch };
      },
    },
    {
      name: "freshness unavailable",
      expected: "builder_plan_freshness_unavailable",
      arrange: async () => {
        const fixture = await canonicalFixture();
        const { freshnessEvidence: _freshnessEvidence, ...dispatch } = fixture.dispatch;
        return { fixture, dispatch };
      },
    },
  ])("denies $name with a stable code and no new run row", async ({ expected, arrange }) => {
    const { fixture, dispatch } = await arrange();
    const before = await projectRuns(fixture.orgId, fixture.projectId);
    await expect(assertBuilderPlanDispatch(db, dispatch)).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.code === expected,
    );
    expect(await projectRuns(fixture.orgId, fixture.projectId)).toHaveLength(before.length);
    await expect(lastDenialCode(fixture.orgId)).resolves.toBe(expected);
  });

  async function canonicalFixture(options: { state?: string; expiresAt?: Date } = {}): Promise<{
    orgId: string;
    projectId: string;
    proposalId: string;
    dispatch: Parameters<typeof assertBuilderPlanDispatch>[1] & {
      trigger: Record<string, unknown>;
      gh: Record<string, unknown>;
      freshnessEvidence: { baseSha: string; issueRevisionSha256: string; checkedAt: string };
    };
  }> {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const orgId = `org_plan_${suffix}`;
    const projectId = `proj_plan_${suffix}`;
    const repoId = `repo_plan_${suffix}`;
    const architectRunId = `run_arch_${suffix}`;
    const proposalId = `prop_plan_${suffix}`;
    const actionTypeId = `act_plan_${suffix}`;
    const baseSha = "a".repeat(40);
    const issueUrl = `https://github.test/facility-test/plan-${suffix}/issues/204`;
    const issueRequest = {
      title: "Require a plan",
      body: "Implement it",
      state: "open",
      author: "requester",
      url: issueUrl,
      labels: [],
      comments: [],
    };
    const issueRevisionSha256 = githubIssueRevisionSha256(issueRequest);
    if (!issueRevisionSha256) throw new Error("issue revision fixture missing");
    const plan = "Implement the reviewed change and run the named checks.";
    const planSha256 = createHash("sha256").update(plan).digest("hex");
    const decidedAt = new Date();

    await db.insert(orgs).values({ id: orgId, name: `Plan ${suffix}`, slug: `plan-${suffix}` });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Plan policy",
      slug: `plan-policy-${suffix}`,
      builderPlanPolicy: "required",
    });
    await db.insert(repos).values({
      id: repoId,
      orgId,
      projectId,
      owner: "facility-test",
      name: `plan-${suffix}`,
      defaultBranch: "main",
    });
    await db.insert(ghIssues).values({
      id: `ghi_${suffix}`,
      orgId,
      projectId,
      repoId,
      number: 204,
      title: "Require a plan",
      state: "open",
      htmlUrl: issueUrl,
      ghUpdatedAt: new Date(),
    });
    const receipt = sealFacilityReceipt(
      {
        schema: "facility.run.v1",
        run_id: architectRunId,
        project_id: projectId,
        provider: "codex_cli",
        mode: "architect",
        result: "succeeded",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cost_cents: 1,
          cost_source: "test",
        },
        activity: {
          turns: 1,
          shell_commands: 0,
          file_changes: 0,
          mcp_tool_calls: 0,
          web_searches: 0,
          tool_calls: 1,
          errors: 0,
        },
        github: {
          owner: "facility-test",
          repo: `plan-${suffix}`,
          issue: 204,
          base_sha: baseSha,
        },
        timing: { started_at: decidedAt.toISOString(), ended_at: decidedAt.toISOString() },
      },
      null,
    );
    await db.insert(runs).values({
      id: architectRunId,
      orgId,
      projectId,
      mode: "architect",
      engine: "codex",
      status: "succeeded",
      trigger: {
        type: "github_comment",
        repo: {
          id: repoId,
          owner: "facility-test",
          name: `plan-${suffix}`,
          baseSha,
        },
        issue: { number: 204 },
        request: issueRequest,
      },
      workspaceBaseSha: baseSha,
      receipt,
      gh: { owner: "facility-test", repo: `plan-${suffix}`, issueNumber: 204 },
      createdBy: { type: "user", id: "requester" },
    });
    await db.insert(actionTypes).values({
      id: actionTypeId,
      orgId,
      name: "plan_acceptance",
      payloadSchema: { type: "object" },
      resolver: { type: "permission", config: { permission: "hitl:decide" } },
      executor: { type: "internal", config: {} },
      defaultTtlHours: 72,
    });
    await db.insert(proposals).values({
      id: proposalId,
      orgId,
      projectId,
      runId: architectRunId,
      actionTypeId,
      payload: {
        architectRunId,
        issueNumber: 204,
        repoId,
        receiptSha256: receipt.integrity?.payload_sha256,
        planSha256,
        workspaceBaseSha: baseSha,
        issueRevisionSha256,
      },
      contextMd: plan,
      state: options.state ?? "executing",
      decidedBy: "approver",
      decidedAt,
      expiresAt: options.expiresAt ?? new Date(Date.now() + 3_600_000),
    });
    await db.insert(proposalEvents).values([
      {
        orgId,
        proposalId,
        seq: 1,
        type: "open",
        actor: { type: "agent", id: architectRunId },
        data: { source: "architect_run" },
      },
      {
        orgId,
        proposalId,
        seq: 2,
        type: "approved",
        actor: { type: "user", id: "approver" },
        data: {},
      },
    ]);
    return {
      orgId,
      projectId,
      proposalId,
      dispatch: {
        orgId,
        projectId,
        mode: "builder",
        trigger: {
          source: "plan_acceptance",
          proposalId,
          architectRunId,
          approvedPlan: plan,
          planSha256,
          approval: { principal: "approver", at: decidedAt.toISOString() },
          planProvenance: { workspaceBaseSha: baseSha, issueRevisionSha256 },
        },
        gh: { owner: "facility-test", repo: `plan-${suffix}`, issueNumber: 204 },
        actor: { type: "user", id: "approver" },
        source: "integration_test",
        freshnessEvidence: {
          baseSha,
          issueRevisionSha256,
          checkedAt: new Date().toISOString(),
        },
      },
    };
  }

  async function githubRouteFixture(
    state:
      | "open"
      | "executing"
      | "executed"
      | "expired"
      | "rejected"
      | "canceled"
      | "execution_failed",
  ) {
    const fixture = await canonicalFixture({ state });
    await db
      .update(projects)
      .set({ builderPlanPolicy: "optional" })
      .where(eq(projects.id, fixture.projectId));
    if (state === "open") {
      await db
        .update(proposals)
        .set({ decidedBy: null, decidedAt: null })
        .where(eq(proposals.id, fixture.proposalId));
      await db
        .delete(proposalEvents)
        .where(and(eq(proposalEvents.proposalId, fixture.proposalId), eq(proposalEvents.seq, 2)));
    } else {
      await db
        .update(proposalEvents)
        .set({
          actor: { type: "user", id: "github:maintainer", name: "maintainer" },
          data: { source: "github_command", commentId: 204 },
        })
        .where(
          and(
            eq(proposalEvents.proposalId, fixture.proposalId),
            eq(proposalEvents.type, "approved"),
          ),
        );
      await db
        .update(proposals)
        .set({ decidedBy: "github:maintainer" })
        .where(eq(proposals.id, fixture.proposalId));
    }
    const repo = (
      await db.select().from(repos).where(eq(repos.projectId, fixture.projectId)).limit(1)
    )[0];
    if (!repo) throw new Error("route repo fixture missing");
    const contractId = newId("item");
    const builderAgentId = newId("agent");
    await db.insert(registryItems).values({
      id: contractId,
      orgId: fixture.orgId,
      scope: "project",
      projectId: fixture.projectId,
      kind: "contract",
      name: `route-builder-${crypto.randomUUID()}`,
    });
    await db.insert(agentDefs).values({
      id: builderAgentId,
      orgId: fixture.orgId,
      projectId: fixture.projectId,
      name: "builder",
      engine: "codex",
      model: { primary: "gpt-5" },
      contractItemId: contractId,
      triggers: [
        { type: "command", handle: "/builder" },
        { type: "command", handle: "/codex-builder" },
      ],
    });
    let nextCommentId = 1;
    const live: { baseSha: string; issueBody: string; issueError?: Error } = {
      baseSha: fixture.dispatch.freshnessEvidence.baseSha,
      issueBody: "Implement it",
    };
    const client = {
      userCanWrite: async () => true,
      getContent: async () => ({
        type: "file",
        encoding: "base64",
        content: Buffer.from(
          JSON.stringify({
            executionLane: { builder: "platform", "codex-builder": "platform" },
          }),
        ).toString("base64"),
      }),
      listIssueComments: async () => [
        {
          id: 204,
          author: "maintainer",
          authorType: "User",
          body: "/builder",
          createdAt: "2026-08-26T10:00:00Z",
          url: "https://github.test/comments/204",
        },
      ],
      getDefaultBranchSha: async () => live.baseSha,
      getIssue: async () => {
        if (live.issueError) throw live.issueError;
        return {
          number: 204,
          title: "Require a plan",
          body: live.issueBody,
          state: "open",
          user: { login: "requester" },
          labels: [],
          html_url: `https://github.test/${repo.owner}/${repo.name}/issues/204`,
        };
      },
      assignIssue: async () => true,
      createIssueComment: async () => ({ id: nextCommentId++ }),
    } as never;
    const payload: TriggerPayload = {
      action: "created",
      comment: { id: 204, body: "/builder" },
      issue: {
        number: 204,
        title: "Require a plan",
        body: "Implement it",
        user: { login: "requester" },
        labels: [],
        html_url: `https://github.test/${repo.owner}/${repo.name}/issues/204`,
      },
      repository: { owner: { login: repo.owner }, name: repo.name },
      sender: { login: "maintainer", type: "User" },
    };
    return {
      ...fixture,
      architectRunId: String(fixture.dispatch.trigger.architectRunId),
      builderAgentId,
      client,
      live,
      payload,
    };
  }

  async function projectRuns(orgId: string, projectId: string) {
    return db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.projectId, projectId)));
  }

  async function lastDenialCode(orgId: string) {
    return (await lastDenialPayload(orgId)).code;
  }

  async function lastDenialPayload(orgId: string): Promise<Record<string, unknown>> {
    const row = (
      await db
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, orgId), eq(auditEvents.action, "run.builder_plan_denied")))
        .orderBy(desc(auditEvents.seq))
        .limit(1)
    )[0];
    return (row?.payload as Record<string, unknown> | undefined) ?? {};
  }
});
