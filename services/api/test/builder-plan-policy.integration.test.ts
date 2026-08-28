import { createHash } from "node:crypto";
import { newId, sealFacilityReceipt } from "@facility/core";
import {
  actionTypes,
  agentDefs,
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
  repos,
  runs,
} from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertBuilderPlanDispatch,
  lockBuilderPlanPolicy,
  withBuilderPlanPreflight,
} from "../src/builder-plan-policy.js";
import { ApiError } from "../src/errors.js";
import { githubIssueRevisionSha256 } from "../src/github/issue-revision.js";
import { syncRepoFacilityConfig } from "../src/github/kickstart.js";
import { routeTrigger, type TriggerPayload } from "../src/github/router.js";
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
