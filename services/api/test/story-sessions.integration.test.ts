import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import {
  generateApiKey,
  newId,
  reservationCents,
  StoryWorkflowPolicySchema,
  seal,
} from "@facility/core";
import {
  agentManifests,
  apiKeys,
  attentionItems,
  auditEvents,
  budgetReservations,
  createDb,
  engineSessions,
  type FacilityDb,
  migrate,
  orgMembers,
  orgs,
  projectBudgets,
  projectRepositories,
  projects,
  roles,
  stories,
  storyMessages,
  storyPreviewConvergences,
  storyPreviewGenerations,
  turnEvents,
  turns,
  turnUsage,
  users,
  workspaces,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import type { Snapshot } from "../src/sessions/native.js";
import {
  interactiveState,
  type SessionScope,
  StorySessionService,
} from "../src/sessions/service.js";
import {
  confirmStoryPlanDecision,
  proposeStoryPlan,
  requestStoryPlanDecision,
  reviewStoryPlanDecision,
} from "../src/stories/plans.js";
import { readPlanExecutionReceipt } from "../src/stories/workflow-execution.js";
import { WORKFLOW_POLICY_SETTING } from "../src/stories/workflow-policy.js";
import { createStoryDomain, type StoryDomain } from "../src/story-domain.js";
import { appendTurnEvent } from "../src/turns/events.js";
import type { AppConfig, Principal } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { parseProjectManifest } from "../src/workspaces/project-environment.js";
import type { WorkspaceRuntime } from "../src/workspaces/runtime.js";
import { WorkspaceVariablesService } from "../src/workspaces/variables.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const manifest = parseAgentManifest(
  `---\nname: builder\ndescription: Builds stories\nengine: codex\nmodel: gpt-5.5\ntriggers:\n  - type: manual\n---\nPreserve the worktree and continue the story.`,
  "builder.md",
);
const projectManifest = parseProjectManifest(
  `version: 1\nrepositories:\n  primary: github.com/acme/demo\nenvironment:\n  start: node server.js`,
);

describe("interactive story sessions with durable ownership and accounting", {
  timeout: 30_000,
}, () => {
  const { db, client } = createDb(databaseUrl);
  const orgId = newId("org");
  const projectId = newId("proj");
  const otherOrgId = newId("org");
  const otherProjectId = newId("proj");
  const roleId = newId("role");
  const repositoryId = newId("repo");
  const userIds = [newId("user"), newId("user")];
  const person = (index = 0): Principal => ({
    type: "user",
    id: userIds[index]!,
    userId: userIds[index]!,
    orgId,
    permissions: ["*"],
  });
  const clientIdentity = () => ({ id: randomUUID(), transportId: randomUUID() });
  const snapshots = new Map<string, Snapshot>();
  const nativeSecrets = new Map<string, string>();
  const terminalWrites: string[] = [];
  const resizes: number[][] = [];
  const running = new Set<string>();
  let stopFails = false;
  let launchAckFails = false;
  let cleanupFails = false;
  let root: string;
  let domain: StoryDomain;
  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 1).toString("base64"),
    port: 0,
    publicUrl: "http://127.0.0.1",
    workspaceImage: "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };

  beforeAll(async () => {
    await migrate(databaseUrl);
    root = await mkdtemp(join(tmpdir(), "facility-sessions-"));
    const fake = new FakeWorkspaceRuntime(root);
    const runtime: WorkspaceRuntime = {
      provider: "docker",
      create: fake.create.bind(fake),
      wake: fake.wake.bind(fake),
      inspect: fake.inspect.bind(fake),
      expose: fake.expose.bind(fake),
      suspend: fake.suspend.bind(fake),
      destroy: fake.destroy.bind(fake),
      retireCompute: fake.retireCompute.bind(fake),
      terminal: async () => ({
        write(data) {
          terminalWrites.push(data.toString());
        },
        resize: async (cols, rows) => {
          resizes.push([cols, rows]);
        },
        close() {},
        onClose() {},
      }),
      exec: async (_workspace, command) => {
        if (command.command === "node" && command.env?.FACILITY_INTERRUPTED_TURN_ID)
          return {
            exitCode: cleanupFails ? 1 : 0,
            stdout: cleanupFails ? "" : "absent",
            stderr: "",
            durationMs: 0,
          };
        if (command.command !== "facility-session") throw new Error("Unexpected external command");
        const [operation, turnId] = command.args!;
        if (operation === "start") {
          nativeSecrets.set(turnId!, command.env?.GITHUB_TOKEN ?? "");
          const launch = JSON.parse(command.stdin!);
          const resumeIndex = launch.args.indexOf("resume");
          const previous =
            resumeIndex >= 0
              ? [...snapshots.values()].find(
                  (item) => item.nativeSessionId === launch.args[resumeIndex + 1],
                )
              : undefined;
          snapshots.set(
            turnId!,
            previous
              ? structuredClone({ ...previous, exited: false })
              : {
                  records: [],
                  hooks: [],
                  nativeSessionId: `native-${turnId}`,
                  bytes: 0,
                  exited: false,
                },
          );
          running.add(turnId!);
          if (launchAckFails) {
            launchAckFails = false;
            return {
              exitCode: 1,
              stdout: "",
              stderr: "launch acknowledgement lost",
              durationMs: 0,
            };
          }
        }
        if (operation === "stop") {
          if (stopFails)
            return { exitCode: 1, stdout: "", stderr: "shutdown unavailable", durationMs: 0 };
          running.delete(turnId!);
          const snapshot = snapshots.get(turnId!);
          if (snapshot) snapshot.exited = true;
        }
        let stdout = "";
        if (operation === "probe")
          stdout = JSON.stringify({
            started: running.has(turnId!),
            interrupted: snapshots.get(turnId!)?.interrupted,
          });
        if (operation === "read") {
          const input = JSON.parse(command.env!.FACILITY_SESSION_READ!);
          const snapshot = input.empty
            ? null
            : (snapshots.get(turnId!) ??
              [...snapshots.values()].find(
                (item) => item.nativeSessionId === input.nativeSessionId,
              ));
          stdout = JSON.stringify(
            snapshot ?? {
              records: [],
              hooks: [],
              nativeSessionId: input.nativeSessionId ?? null,
              bytes: 0,
              exited: false,
            },
          );
        }
        return { exitCode: 0, stdout, stderr: "", durationMs: 0 };
      },
    };
    domain = createStoryDomain({
      db,
      runtime,
      enqueue: async () => null,
      config,
    });
    vi.spyOn(domain.catalog, "list").mockResolvedValue([{ manifest }] as Awaited<
      ReturnType<typeof domain.catalog.list>
    >);
    vi.spyOn(domain.credentials, "issue").mockResolvedValue(
      {} as Awaited<ReturnType<typeof domain.credentials.issue>>,
    );
    vi.spyOn(domain.projectManifests, "load").mockResolvedValue(projectManifest);
    vi.spyOn(domain.environment, "prepare").mockResolvedValue({
      primaryCwd: "/workspace/repos/acme/demo",
      processEnvironment: { GITHUB_TOKEN: "ephemeral-fixture-token" },
      secretNames: [],
    } as unknown as Awaited<ReturnType<typeof domain.environment.prepare>>);
    vi.spyOn(domain.variables, "values").mockResolvedValue({
      EXAMPLE_SECRET: "fixture-secret-value",
    });
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Session tests", slug: `sessions-${randomUUID()}` });
    await db.insert(projects).values({ id: projectId, orgId, name: "Demo", slug: "demo" });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId,
      projectId,
      owner: "acme",
      name: "demo",
      role: "primary",
      defaultBranch: "main",
    });
    await db.insert(agentManifests).values({
      id: newId("amf"),
      orgId,
      projectId,
      name: manifest.name,
      manifest,
      commitSha: "a".repeat(40),
      path: "builder.md",
      contentHash: manifest.hash,
    });
    vi.spyOn(domain.catalog, "refreshSnapshot").mockResolvedValue({
      manifests: [manifest],
      repositoryId,
      commitSha: "a".repeat(40),
      observedAt: new Date(),
    });
    await db
      .insert(orgs)
      .values({ id: otherOrgId, name: "Other tenant", slug: `other-${randomUUID()}` });
    await db
      .insert(projects)
      .values({ id: otherProjectId, orgId: otherOrgId, name: "Other project", slug: "other" });
    await db.insert(roles).values({ id: roleId, orgId, name: "session-owner", permissions: ["*"] });
    await db.insert(users).values(
      userIds.map((id, index) => ({
        id,
        name: `Session user ${index}`,
        email: `${id}@example.test`,
      })),
    );
    await db
      .insert(orgMembers)
      .values(userIds.map((id) => ({ id: newId("member"), orgId, userId: id, roleId })));
  }, 30_000);

  beforeEach(async () => {
    cleanupFails = false;
    await db.update(projects).set({ settings: {} }).where(eq(projects.id, projectId));
    await db.delete(budgetReservations).where(eq(budgetReservations.orgId, orgId));
    await db.delete(turnUsage).where(eq(turnUsage.orgId, orgId));
  });

  afterAll(async () => {
    if (domain) {
      for (const table of [
        "audit_events",
        "api_keys",
        "session_waiters",
        "budget_reservations",
        "turn_usage",
        "story_evidence_events",
        "story_plan_states",
        "story_plan_decisions",
        "story_plan_requests",
        "story_plan_repository_refs",
        "story_plan_revisions",
        "story_preview_convergences",
        "story_preview_generations",
        "engine_sessions",
        "attention_items",
        "turn_events",
        "story_messages",
        "turns",
        "story_conversations",
        "workspace_events",
        "workspaces",
        "story_assignees",
        "stories",
        "project_budgets",
        "org_members",
        "roles",
        "agent_manifests",
        "project_repositories",
        "projects",
      ])
        for (const scopedOrgId of [orgId, otherOrgId])
          await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE org_id = ${scopedOrgId}`);
      for (const id of userIds) await db.delete(users).where(eq(users.id, id));
      await db.delete(orgs).where(eq(orgs.id, orgId));
      await db.delete(orgs).where(eq(orgs.id, otherOrgId));
    }
    await client.end();
    if (root) await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }, 30_000);

  async function fresh(scopedOrgId = orgId, scopedProjectId = projectId): Promise<SessionScope> {
    await db.delete(projectBudgets).where(eq(projectBudgets.projectId, projectId));
    await db
      .update(roles)
      .set({ permissions: ["*"] })
      .where(eq(roles.id, roleId));
    stopFails = false;
    launchAckFails = false;
    const result = await domain.stories.startInteractive({
      orgId: scopedOrgId,
      projectId: scopedProjectId,
      provider: "manual",
      externalId: randomUUID(),
      title: "An interactive story",
      agent: manifest,
      message: "Interactive workspace",
      messageDedupeKey: randomUUID(),
      actor: { type: "user", id: userIds[0]! },
      workspace: { image: "facility-runner:test" },
    });
    return { orgId: scopedOrgId, projectId: scopedProjectId, storyId: result.story.id };
  }
  async function open(scope: SessionScope) {
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, true);
    const turn = await domain.sessions.enter(scope, person(), connection);
    await domain.sessions.tick(scope); // Commit the native accounting baseline.
    await domain.sessions.tick(scope); // Launch the native process.
    expect(await db.select().from(turnUsage).where(eq(turnUsage.turnId, turn!.id))).toHaveLength(0);
    return { turn: turn!, connection };
  }
  async function importNow(scope: SessionScope) {
    const turn = (await domain.sessions.holder(scope))!;
    await db
      .update(turns)
      .set({ interactive: { ...interactiveState(turn), importedAt: "2000-01-01T00:00:00Z" } })
      .where(eq(turns.id, turn.id));
    await domain.sessions.tick(scope);
  }

  it("requires plan approval, records its receipt and closes after delegation is revoked", async () => {
    const scope = await fresh();
    const policy = StoryWorkflowPolicySchema.parse({ planApprovalAgents: [manifest.name] });
    await db
      .update(projects)
      .set({ settings: { [WORKFLOW_POLICY_SETTING]: { revision: 1, policy } } })
      .where(eq(projects.id, projectId));
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, true);
    await expect(domain.sessions.enter(scope, person(), connection)).rejects.toMatchObject({
      code: "workflow_plan_approval_required",
    });
    expect(await domain.sessions.holder(scope)).toBeNull();
    const actor = { type: "user" as const, id: userIds[0]!, name: "Session user" };
    const options = { webUrl: "https://facility.example" };
    await proposeStoryPlan(
      db,
      domain.catalog,
      scope,
      {
        expected_revision: 0,
        markdown: "Implement the bounded change and verify it",
        repositories: ["acme/demo"],
        agents: [manifest.name],
        idempotency_key: randomUUID(),
      },
      actor,
      options,
    );
    const requested = await requestStoryPlanDecision(
      db,
      scope,
      {
        expected_revision: 1,
        expected_decision_revision: 0,
        intent: "approve",
        idempotency_key: randomUUID(),
      },
      actor,
      options,
    );
    const human = { id: actor.id, name: actor.name, sessionCookie: "fixture-session" };
    const review = await reviewStoryPlanDecision(
      db,
      scope,
      requested.request.id,
      human,
      config.secretMasterKey,
      options,
    );
    if (!review.proof) throw Error("Missing approval proof");
    await confirmStoryPlanDecision(
      db,
      scope,
      requested.request.id,
      review.proof,
      human,
      config.secretMasterKey,
      options,
    );
    const turn = await domain.sessions.enter(scope, person(), connection);
    if (!turn) throw Error("Missing authorized interactive turn");
    await domain.sessions.tick(scope);
    await domain.sessions.tick(scope);
    expect(await readPlanExecutionReceipt(db, scope, turn.id)).toMatchObject({
      planRevision: 1,
      authorizerId: actor.id,
      repositoryIds: [repositoryId],
    });
    expect(running.has(turn.id)).toBe(true);
    await db
      .update(roles)
      .set({ permissions: ["sessions:observe", "sessions:control", "projects:write"] })
      .where(eq(roles.id, roleId));
    await domain.sessions.tick(scope);
    expect(await domain.sessions.holder(scope)).toBeNull();
    expect(running.has(turn.id)).toBe(false);
    const events = await db
      .select()
      .from(turnEvents)
      .where(and(eq(turnEvents.turnId, turn.id), eq(turnEvents.type, "session.closed")));
    expect(events[0]?.data).toMatchObject({ reason: "workflow_authorization_revoked" });
  });

  it("does not turn a native read-only Reviewer into an interactive writer", async () => {
    const scope = await fresh();
    const queued = await domain.stories.queueMessage({
      ...scope,
      body: "Review",
      dedupeKey: randomUUID(),
      agent: manifest,
      actor: { type: "system", id: "test" },
      trigger: { type: "schedule" },
    });
    await db
      .update(turns)
      .set({ triggerType: "review_cycle" })
      .where(eq(turns.id, queued.turn!.id));
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, true);
    await expect(
      domain.sessions.enter(scope, person(), connection, queued.turn!.id),
    ).rejects.toMatchObject({ code: "session_review_read_only" });
    expect((await domain.sessions.holder(scope))?.id).toBe(queued.turn!.id);
  });

  it("waits for the preview writer lease before taking ownership", async () => {
    const scope = await fresh();
    const generation = "a".repeat(64);
    await db.insert(storyPreviewGenerations).values({
      ...scope,
      generation,
      deliveryRevision: "b".repeat(64),
      repositories: [
        {
          repositoryId,
          repository: "acme/demo",
          pullNumber: 1,
          headRef: "feature",
          headSha: "c".repeat(40),
          primary: true,
        },
      ],
      sourceObservedAt: new Date(),
    });
    await db.insert(storyPreviewConvergences).values({
      ...scope,
      desiredGeneration: generation,
      desiredObservedAt: new Date(),
      state: "applying",
      leaseToken: randomUUID(),
      leaseGeneration: generation,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, true);
    await expect(domain.sessions.enter(scope, person(), connection)).rejects.toMatchObject({
      code: "session_preview_active",
    });
    expect(await domain.sessions.holder(scope)).toBeNull();
    await db
      .update(storyPreviewConvergences)
      .set({ state: "ready", leaseToken: null, leaseGeneration: null, leaseExpiresAt: null })
      .where(eq(storyPreviewConvergences.storyId, scope.storyId));
    expect((await domain.sessions.enter(scope, person(), connection))?.triggerType).toBe(
      "interactive",
    );
  });

  it("keeps the remaining budget hold during imports and releases it only after stop", async () => {
    const scope = await fresh();
    const estimate = reservationCents(manifest.model, "turn")!;
    await db.insert(projectBudgets).values({
      id: newId("bud"),
      orgId,
      projectId,
      enabled: true,
      monthlyLimitCents: Math.ceil(estimate),
    });
    const opened = await open(scope);
    snapshots.get(opened.turn.id)!.records.push({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
      },
    });
    await importNow(scope);
    const [usage] = await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id));
    const [hold] = await db
      .select()
      .from(budgetReservations)
      .where(eq(budgetReservations.turnId, opened.turn.id));
    expect(hold?.state).toBe("open");
    expect(hold!.reservedCents + usage!.costCents!).toBeCloseTo(estimate, 8);
    expect(usage?.createdAt).toEqual(opened.turn.createdAt);
    await importNow(scope);
    expect(
      (
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.turnId, opened.turn.id))
      )[0]?.reservedCents,
    ).toBe(hold?.reservedCents);
    expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
    stopFails = true;
    await expect(domain.sessions.release(scope, person(), opened.connection)).rejects.toThrow(
      "stop failed",
    );
    expect(
      (
        await db
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.turnId, opened.turn.id))
      )[0]?.state,
    ).toBe("open");
    stopFails = false;
    await domain.sessions.release(scope, person(), opened.connection);
    expect(
      await db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.turnId, opened.turn.id)),
    ).toHaveLength(0);
    const next = clientIdentity();
    await domain.sessions.lease(scope, person(), next, true);
    const nextTurn = await domain.sessions.enter(scope, person(), next);
    await domain.sessions.tick(scope);
    expect(interactiveState((await domain.sessions.holder(scope))!)?.closeReason).toBe(
      "budget_exceeded",
    );
    expect(running.has(nextTurn!.id)).toBe(false);
  });

  it("records uncertainty after compute loss without fabricating a completed zero-cost session", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const snapshot = snapshots.get(opened.turn.id)!;
    snapshot.records.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "A request before compute was lost" }],
      },
    });
    snapshot.exited = true;
    snapshot.interrupted = true;
    await importNow(scope);
    expect(await domain.sessions.holder(scope)).toBeNull();
    const [usage] = await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id));
    expect(usage).toMatchObject({ priced: false, costCents: null, source: "unpriced" });
    await db
      .insert(projectBudgets)
      .values({ id: newId("bud"), orgId, projectId, enabled: true, monthlyLimitCents: 1_000_000 });
    const next = clientIdentity();
    await domain.sessions.lease(scope, person(), next, true);
    await expect(domain.sessions.enter(scope, person(), next)).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
  });

  it("arbitrates simultaneous entrants and gives a waiting CLI priority over messages", async () => {
    const scope = await fresh();
    const first = clientIdentity();
    const second = clientIdentity();
    await domain.sessions.lease(scope, person(), first, true);
    await domain.sessions.lease(scope, person(1), second, true);
    const message = await domain.stories.queueMessage({
      ...scope,
      body: "Queued work",
      dedupeKey: randomUUID(),
      agent: manifest,
      actor: { type: "system", id: "schedule" },
      trigger: { type: "schedule" },
    });
    expect(message.queued).toBe(true);
    expect(
      await domain.stories.activateNextMessage({
        ...scope,
        agent: manifest,
        actor: { type: "system", id: "queue" },
      }),
    ).toBeUndefined();
    await Promise.all([
      domain.sessions.enter(scope, person(), first),
      domain.sessions.enter(scope, person(1), second),
    ]);
    const holder = await domain.sessions.holder(scope);
    expect(holder?.triggerType).toBe("interactive");
    expect(interactiveState(holder!)?.clientId).toBe(first.id);
    expect((await db.select().from(turns).where(eq(turns.storyId, scope.storyId))).length).toBe(1);
  });

  it("enforces user control on interactive creation and validates confirmed web takeover bodies", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
    try {
      await app.ready();
      const cookie = `facility_session=${await mintSessionCookie(config, userIds[0]!, orgId)}`;
      const key = await generateApiKey("fak");
      await db.insert(apiKeys).values({
        id: key.id,
        orgId,
        name: "Creation fixture",
        prefix: key.lookup,
        last4: key.last4,
        hash: key.hash,
        scopeType: "org",
        roleId,
      });
      const path = `/v1/projects/${projectId}/workspace-stories`;
      const payload = {
        interactive_only: true,
        title: "Empty native story",
        message: "Interactive workspace",
        idempotency_key: randomUUID(),
      };
      const denied = await app.inject({
        method: "POST",
        url: path,
        headers: { authorization: `Bearer ${key.secret}` },
        payload,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe("session_user_required");
      const created = await app.inject({ method: "POST", url: path, headers: { cookie }, payload });
      expect(created.statusCode, created.body).toBe(202);
      expect(created.json().turns).toHaveLength(0);
      const messages = `${path}/${scope.storyId}/messages`;
      for (const extra of [{ takeover_turn_id: opened.turn.id }, { confirm_takeover: true }]) {
        const invalid = await app.inject({
          method: "POST",
          url: messages,
          headers: { cookie },
          payload: { message: "A task", idempotency_key: randomUUID(), ...extra },
        });
        expect(invalid.statusCode).toBe(400);
      }
      const keyTakeover = await app.inject({
        method: "POST",
        url: messages,
        headers: { authorization: `Bearer ${key.secret}` },
        payload: {
          message: "A task",
          idempotency_key: randomUUID(),
          takeover_turn_id: opened.turn.id,
          confirm_takeover: true,
        },
      });
      expect(keyTakeover.statusCode).toBe(403);
      expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
      const sent = await app.inject({
        method: "POST",
        url: messages,
        headers: { cookie },
        payload: {
          message: "A confirmed web task",
          idempotency_key: randomUUID(),
          takeover_turn_id: opened.turn.id,
          confirm_takeover: true,
        },
      });
      expect(sent.statusCode, sent.body).toBe(202);
      expect(sent.json().queued.queued).toBe(false);
      expect((await domain.sessions.holder(scope))?.triggerType).toBe("manual");
    } finally {
      await app.close();
    }
  });

  it("retains deleted story reads for cleanup while refusing terminal entry", async () => {
    const scope = await fresh();
    const app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
    try {
      await app.ready();
      const cookie = `facility_session=${await mintSessionCookie(config, userIds[0]!, orgId)}`;
      const url = `/v1/projects/${projectId}/workspace-stories/${scope.storyId}`;
      const read = () => app.inject({ method: "GET", url, headers: { cookie } });
      expect((await read()).json().session).toMatchObject({ holder: null });
      await db.update(stories).set({ deletedAt: new Date() }).where(eq(stories.id, scope.storyId));
      const retained = await read();
      expect(retained.statusCode, retained.body).toBe(200);
      expect(retained.json().story.id).toBe(scope.storyId);
      expect(retained.json().session).toBeUndefined();
      const status = await app.inject({
        method: "GET",
        url: `${url}/session/status`,
        headers: { cookie },
      });
      expect(status.statusCode).toBe(404);
      await expect(domain.sessions.enter(scope, person(), clientIdentity())).rejects.toMatchObject({
        code: "story_not_found",
      });
      expect(await domain.sessions.holder(scope)).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("waits for cancellation acknowledgement before launching after a Facility takeover", async () => {
    const scope = await fresh();
    const queued = await domain.stories.queueMessage({
      ...scope,
      body: "Existing task",
      dedupeKey: randomUUID(),
      agent: manifest,
      actor: { type: "system", id: "test" },
      trigger: { type: "schedule" },
    });
    const prior = queued.turn!;
    await db
      .update(turns)
      .set({ state: "running", startedAt: new Date() })
      .where(eq(turns.id, prior.id));
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, false);
    const next = await domain.sessions.enter(scope, person(), connection, prior.id);
    await domain.sessions.tick(scope);
    expect(running.has(next!.id)).toBe(false);
    expect(interactiveState((await domain.sessions.holder(scope))!)?.status).toBe("waiting");
    const contender = clientIdentity();
    await domain.sessions.lease(scope, person(1), contender, false);
    await expect(
      domain.sessions.enter(scope, person(1), contender, next!.id),
    ).rejects.toMatchObject({ code: "session_cancellation_pending" });
    await expect(domain.sessions.release(scope, person(), connection)).rejects.toMatchObject({
      code: "session_cancellation_pending",
    });
    await expect(
      domain.stories.queueMessage({
        ...scope,
        takeoverTurnId: next!.id,
        body: "A web override",
        dedupeKey: randomUUID(),
        agent: manifest,
        actor: { type: "user", id: userIds[1]! },
        trigger: { type: "ui" },
      }),
    ).rejects.toMatchObject({ code: "session_cancellation_pending" });
    expect((await domain.sessions.holder(scope))?.id).toBe(next!.id);
    await appendTurnEvent(db, { ...scope, turnId: prior.id, type: "turn.canceled", data: {} });
    await domain.sessions.tick(scope);
    await domain.sessions.tick(scope);
    expect(running.has(next!.id)).toBe(true);
  });

  async function takeOverMissingWorker() {
    const scope = await fresh();
    const queued = await domain.stories.queueMessage({
      ...scope,
      body: "An interrupted task",
      dedupeKey: randomUUID(),
      agent: manifest,
      actor: { type: "system", id: "test" },
      trigger: { type: "schedule" },
    });
    const prior = queued.turn!;
    await db
      .update(turns)
      .set({ state: "running", startedAt: new Date() })
      .where(eq(turns.id, prior.id));
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, false);
    const next = await domain.sessions.enter(scope, person(), connection, prior.id);
    await db
      .update(turns)
      .set({ updatedAt: new Date(Date.now() - 180_000) })
      .where(eq(turns.id, prior.id));
    return { scope, prior, next: next!, connection };
  }

  it("recovers a canceled predecessor whose worker disappeared before acknowledgement", async () => {
    const { scope, prior, next, connection } = await takeOverMissingWorker();
    await domain.sessions.tick(scope);
    await domain.sessions.tick(scope);
    expect(running.has(next.id)).toBe(true);
    const events = await db
      .select()
      .from(turnEvents)
      .where(and(eq(turnEvents.turnId, prior.id), eq(turnEvents.type, "turn.worker_interrupted")));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ processCleanup: "absent" });
    expect(
      interactiveState((await domain.sessions.holder(scope))!)?.previousTurnId,
    ).toBeUndefined();
    expect((await domain.stories.get(orgId, projectId, scope.storyId)).story.activeAgentName).toBe(
      manifest.name,
    );
    await domain.sessions.release(scope, person(), connection);
    expect(await domain.sessions.holder(scope)).toBeNull();
  });

  it("keeps the slot when an expired worker's native writer cannot be confirmed stopped", async () => {
    const { scope, prior, next } = await takeOverMissingWorker();
    cleanupFails = true;
    await expect(domain.sessions.tick(scope)).rejects.toMatchObject({
      code: "turn_cleanup_unconfirmed",
    });
    expect((await domain.sessions.holder(scope))?.id).toBe(next.id);
    expect(running.has(next.id)).toBe(false);
    expect((await db.select().from(turns).where(eq(turns.id, prior.id)))[0]?.state).toBe(
      "canceled",
    );
    expect(
      await db
        .select()
        .from(turnEvents)
        .where(
          and(eq(turnEvents.turnId, prior.id), eq(turnEvents.type, "turn.worker_interrupted")),
        ),
    ).toHaveLength(0);
    cleanupFails = false;
    await domain.sessions.tick(scope);
    await domain.sessions.tick(scope);
    expect(running.has(next.id)).toBe(true);
  });

  it("retains the takeover slot when the dead worker's workspace cannot be located", async () => {
    const { scope, next } = await takeOverMissingWorker();
    await db
      .update(workspaces)
      .set({ externalRef: null })
      .where(eq(workspaces.storyId, scope.storyId));
    await expect(domain.sessions.tick(scope)).rejects.toMatchObject({
      code: "turn_cleanup_unconfirmed",
    });
    expect((await domain.sessions.holder(scope))?.id).toBe(next.id);
    expect(running.has(next.id)).toBe(false);
  });

  it("can release a pending takeover after confirming a dead worker without launching a new process", async () => {
    const { scope, prior, next, connection } = await takeOverMissingWorker();
    await domain.sessions.release(scope, person(), connection);
    expect(await domain.sessions.holder(scope)).toBeNull();
    expect(running.has(next.id)).toBe(false);
    expect(
      await db
        .select()
        .from(turnEvents)
        .where(
          and(eq(turnEvents.turnId, prior.id), eq(turnEvents.type, "turn.worker_interrupted")),
        ),
    ).toHaveLength(1);
  });

  it("recovers a lost native launch acknowledgement without resetting its accounting boundary", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    snapshots.get(opened.turn.id)!.records.push({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
      },
    });
    const active = (await domain.sessions.holder(scope))!;
    await db
      .update(turns)
      .set({
        state: "queued",
        interactive: { ...interactiveState(active), status: "prepared", importedAt: undefined },
      })
      .where(eq(turns.id, active.id));
    const restarted = new StorySessionService(db, domain, config.secretMasterKey);
    const preparations = vi.mocked(domain.environment.prepare).mock.calls.length;
    await restarted.tick(scope);
    expect(vi.mocked(domain.environment.prepare).mock.calls.length).toBe(preparations);
    expect((await restarted.holder(scope))?.id).toBe(active.id);
    expect(
      (await db.select().from(turnUsage).where(eq(turnUsage.turnId, active.id)))[0]?.inputTokens,
    ).toBe(100);
    expect(await restarted.owns(scope, person(), opened.connection, active.id)).toBe(true);
  });

  it("imports a prepared launch interrupted by compute loss instead of starting another native session", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const snapshot = snapshots.get(opened.turn.id)!;
    snapshot.records.push({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 10 } },
      },
    });
    snapshot.exited = true;
    snapshot.interrupted = true;
    running.delete(opened.turn.id);
    const active = (await domain.sessions.holder(scope))!;
    await db
      .update(turns)
      .set({
        state: "queued",
        interactive: { ...interactiveState(active), status: "prepared", importedAt: undefined },
      })
      .where(eq(turns.id, active.id));
    await new StorySessionService(db, domain, config.secretMasterKey).tick(scope);
    expect(snapshots.get(opened.turn.id)).toBe(snapshot);
    expect(await domain.sessions.holder(scope)).toBeNull();
    expect(
      (await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id)))[0],
    ).toMatchObject({ inputTokens: 100, outputTokens: 10, priced: false });
    expect(
      (await db.select().from(engineSessions).where(eq(engineSessions.storyId, scope.storyId)))[0]
        ?.nativeSessionId,
    ).toBe(snapshot.nativeSessionId);
  });

  it("recovers the exact prepared credentials for redaction after launch succeeds but its acknowledgement is lost", async () => {
    const scope = await fresh();
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, true);
    const turn = (await domain.sessions.enter(scope, person(), connection))!;
    vi.mocked(domain.environment.prepare).mockResolvedValueOnce({
      primaryCwd: "/workspace/repos/acme/demo",
      processEnvironment: { GITHUB_TOKEN: "prepared-fixture-secret" },
      secretNames: [],
    } as unknown as Awaited<ReturnType<typeof domain.environment.prepare>>);
    await domain.sessions.tick(scope);
    launchAckFails = true;
    await expect(domain.sessions.tick(scope)).rejects.toThrow("start failed");
    const secret = nativeSecrets.get(turn.id)!;
    expect(secret).toBe("prepared-fixture-secret");
    snapshots.get(turn.id)!.records.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Output contained ${secret}` }],
      },
    });
    const restarted = new StorySessionService(db, domain, config.secretMasterKey);
    await restarted.tick(scope);
    const messages = await db.select().from(storyMessages).where(eq(storyMessages.turnId, turn.id));
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toContain("[REDACTED]");
    expect(JSON.stringify(messages)).not.toContain(secret);
    expect(interactiveState((await restarted.holder(scope))!)?.launchEnvironment).toBeUndefined();
  });

  it("reads scoped secrets on the ownership transaction even with a one-connection pool", async () => {
    const scope = await fresh();
    const workspace = await domain.sessions.workspace(db, scope);
    const single = createDb(databaseUrl, { max: 1 });
    try {
      const variables = new WorkspaceVariablesService(single.db, config.secretMasterKey);
      const values = await single.db.transaction((tx) =>
        variables.values(
          { orgId, projectId, workspaceId: workspace.id },
          tx as unknown as FacilityDb,
        ),
      );
      expect(values).toEqual({});
      await expect(
        single.db.transaction((tx) =>
          variables.values(
            { orgId: otherOrgId, projectId: otherProjectId, workspaceId: workspace.id },
            tx as unknown as FacilityDb,
          ),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await single.client.end();
    }
  });

  it("does not grant session access through a role from another tenant", async () => {
    const scope = await fresh();
    const foreignRole = newId("role");
    await db
      .insert(roles)
      .values({ id: foreignRole, orgId: otherOrgId, name: foreignRole, permissions: ["*"] });
    await db
      .update(orgMembers)
      .set({ roleId: foreignRole })
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userIds[0]!)));
    try {
      await expect(
        domain.sessions.lease(scope, person(), clientIdentity(), true),
      ).rejects.toMatchObject({ code: "session_forbidden" });
      await expect(domain.sessions.enter(scope, person(), clientIdentity())).rejects.toMatchObject({
        code: "session_forbidden",
      });
      expect(await domain.sessions.holder(scope)).toBeNull();
    } finally {
      await db
        .update(orgMembers)
        .set({ roleId })
        .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userIds[0]!)));
    }
  });

  it("serializes terminal input with permission revocation", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    let entered!: () => void;
    let resume!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const permit = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const output: string[] = [];
    const writing = domain.sessions.write(
      scope,
      person(),
      opened.connection,
      opened.turn.id,
      async () => {
        entered();
        await permit;
        output.push("authorized");
      },
    );
    await inside;
    let revoked = false;
    const revoking = db
      .update(roles)
      .set({ permissions: ["sessions:observe"] })
      .where(eq(roles.id, roleId))
      .then(() => {
        revoked = true;
      });
    try {
      await vi.waitFor(
        async () => {
          const rows = await db.execute(
            sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%roles%') AS blocked`,
          );
          expect(rows[0]?.blocked).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(revoked).toBe(false);
    } finally {
      resume();
      await Promise.all([writing, revoking]);
    }
    await expect(
      domain.sessions.write(scope, person(), opened.connection, opened.turn.id, () => {
        output.push("revoked");
      }),
    ).rejects.toMatchObject({ code: "session_forbidden" });
    expect(output).toEqual(["authorized"]);
  });

  it("rejects API keys, forged tenant scope, observer control and stale connections", async () => {
    const scope = await fresh();
    const connection = clientIdentity();
    const foreignScope = await fresh(otherOrgId, otherProjectId);
    await expect(
      domain.sessions.lease(foreignScope, person(), connection, true),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(domain.sessions.enter(foreignScope, person(), connection)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await domain.sessions.holder(foreignScope)).toBeNull();
    await expect(
      domain.sessions.enter(scope, { ...person(), type: "key", userId: undefined }, connection),
    ).rejects.toMatchObject({ code: "session_user_required" });
    await expect(
      domain.sessions.enter({ ...scope, orgId: newId("org") }, person(), connection),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      domain.sessions.enter(scope, { ...person(), permissions: ["sessions:observe"] }, connection),
    ).rejects.toMatchObject({ code: "session_forbidden" });
    const opened = await open(scope);
    expect(await domain.sessions.owns(scope, person(), opened.connection, opened.turn.id)).toBe(
      true,
    );
    await domain.sessions.lease(
      scope,
      person(),
      { ...opened.connection, transportId: randomUUID() },
      false,
    );
    expect(await domain.sessions.owns(scope, person(), opened.connection, opened.turn.id)).toBe(
      false,
    );
    await expect(
      domain.sessions.lease(scope, person(), opened.connection, false, true),
    ).rejects.toMatchObject({ code: "session_connection_replaced" });
    await expect(
      domain.sessions.enter(scope, person(), opened.connection, opened.turn.id),
    ).rejects.toMatchObject({ code: "session_connection_replaced" });
    await expect(domain.sessions.release(scope, person(), opened.connection)).rejects.toMatchObject(
      { code: "session_connection_replaced" },
    );
    expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
  });

  it("allows only one confirmed takeover to win and audits the previous holder", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const contenders = [clientIdentity(), clientIdentity()];
    for (const connection of contenders)
      await domain.sessions.lease(scope, person(1), connection, false);
    const results = await Promise.allSettled(
      contenders.map((connection) =>
        domain.sessions.enter(scope, person(1), connection, opened.turn.id),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(running.has(opened.turn.id)).toBe(false);
    expect(await domain.sessions.owns(scope, person(), opened.connection, opened.turn.id)).toBe(
      false,
    );
    const events = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.orgId, orgId),
          eq(auditEvents.action, "session.takeover"),
          sql`${auditEvents.payload}->>'fromTurnId' = ${opened.turn.id}`,
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      fromTurnId: opened.turn.id,
      fromUserId: userIds[0],
    });
  });

  it("serializes native input with nonce replacement across broker connections", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const output: string[] = [];
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const permit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = domain.sessions.write(
      scope,
      person(),
      opened.connection,
      opened.turn.id,
      async () => {
        entered();
        await permit;
        output.push("old");
      },
    );
    await inside;
    const replacement = { ...opened.connection, transportId: randomUUID() };
    let replaced = false;
    const replacing = domain.sessions.lease(scope, person(), replacement, false).then(() => {
      replaced = true;
    });
    try {
      await vi.waitFor(
        async () => {
          const rows = await db.execute(
            sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%session_waiters%') AS blocked`,
          );
          expect(rows[0]?.blocked).toBe(true);
        },
        { timeout: 5000 },
      );
      expect(replaced).toBe(false);
    } finally {
      release();
      await Promise.all([writing, replacing]);
    }
    await expect(
      domain.sessions.write(scope, person(), opened.connection, opened.turn.id, () => {
        output.push("stale");
      }),
    ).rejects.toMatchObject({ code: "session_read_only" });
    await domain.sessions.write(scope, person(), replacement, opened.turn.id, () => {
      output.push("new");
    });
    expect(output).toEqual(["old", "new"]);
  });

  it("imports appended conversation, steps and cumulative usage exactly once before a web takeover", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    await db
      .insert(attentionItems)
      .values({ id: newId("attn"), ...scope, kind: "agent_waiting", title: "A reply is needed" });
    const snapshot = snapshots.get(opened.turn.id)!;
    snapshot.records.push(
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Use fixture-secret-value and ephemeral-fixture-token" },
          ],
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: "test" },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Updated the code" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 12 },
          },
        },
      },
    );
    await importNow(scope);
    await importNow(scope);
    expect(
      await db.select().from(storyMessages).where(eq(storyMessages.storyId, scope.storyId)),
    ).toHaveLength(2);
    const usage = await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 20,
      outputTokens: 12,
      priced: true,
    });
    expect(
      (await db.select().from(attentionItems).where(eq(attentionItems.storyId, scope.storyId)))[0]
        ?.status,
    ).toBe("resolved");
    const messages = await db
      .select()
      .from(storyMessages)
      .where(eq(storyMessages.storyId, scope.storyId));
    expect(messages[0]?.body).not.toContain("fixture-secret-value");
    expect(JSON.stringify(messages)).not.toContain("ephemeral-fixture-token");
    expect(
      (await db.select().from(engineSessions).where(eq(engineSessions.storyId, scope.storyId)))[0]
        ?.nativeSessionId,
    ).toBe(snapshot.nativeSessionId);
    const sent = await domain.stories.queueMessage({
      ...scope,
      takeoverTurnId: opened.turn.id,
      body: "Continue from the web",
      dedupeKey: randomUUID(),
      agent: manifest,
      actor: { type: "user", id: userIds[1]! },
      trigger: { type: "ui" },
    });
    expect(sent.queued).toBe(false);
    expect(sent.turn?.triggerType).toBe("ui");
    expect(running.has(opened.turn.id)).toBe(false);
  });

  it("retains the slot and audit history when shutdown cannot be confirmed", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    stopFails = true;
    const next = clientIdentity();
    await domain.sessions.lease(scope, person(1), next, false);
    await expect(domain.sessions.enter(scope, person(1), next, opened.turn.id)).rejects.toThrow(
      "stop failed",
    );
    expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
    expect(running.has(opened.turn.id)).toBe(true);
  });

  it("keeps an interactive process through a merge and denies lifecycle operations that bypass takeover", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    await expect(
      domain.stories.cancelTurn({
        ...scope,
        turnId: opened.turn.id,
        actor: { type: "user", id: userIds[0]! },
      }),
    ).rejects.toMatchObject({ code: "interactive_session_control_required" });
    await expect(domain.stories.suspend(orgId, projectId, scope.storyId)).rejects.toMatchObject({
      code: "interactive_session_active",
    });
    await expect(domain.stories.archive(orgId, projectId, scope.storyId)).rejects.toMatchObject({
      code: "interactive_session_active",
    });
    const merged = await domain.stories.markMerged({
      ...scope,
      pullRequestNumber: 12,
      pullRequestUrl: "https://github.com/acme/demo/pull/12",
      branch: "facility/example",
    });
    expect(merged.story.status).toBe("done");
    expect((await domain.sessions.status(scope)).completedByMerge).toBe(true);
    expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
    expect(running.has(opened.turn.id)).toBe(true);
    await domain.sessions.release(scope, person(), opened.connection);
    expect((await domain.stories.get(orgId, projectId, scope.storyId)).story.status).toBe("done");
  });

  it("retains an already imported charge when budget shutdown fails and refuses counter regression", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const snapshot = snapshots.get(opened.turn.id)!;
    const tokens = (input: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: 100 } },
      },
    });
    snapshot.records.push(tokens(1_000_000));
    await importNow(scope);
    const charged = (
      await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id))
    )[0]!;
    expect(charged.inputTokens).toBe(1_000_000);
    snapshot.records.push(tokens(900_000));
    await expect(importNow(scope)).rejects.toThrow("regressed");
    expect(
      (await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id)))[0]
        ?.inputTokens,
    ).toBe(1_000_000);
    snapshot.records.pop(); // Repair the rejected fixture record before retrying import.
    snapshot.records.push(tokens(1_100_000));
    await db
      .insert(projectBudgets)
      .values({ id: newId("bud"), orgId, projectId, monthlyLimitCents: 1, enabled: true });
    await importNow(scope);
    stopFails = true;
    await expect(domain.sessions.tick(scope)).rejects.toThrow("stop failed");
    expect(
      (await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id)))[0]
        ?.inputTokens,
    ).toBe(1_100_000);
    expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
  });

  it("reattaches a disconnected holder to the running process without restarting the native session", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const next = clientIdentity();
    await domain.sessions.lease(scope, person(), next, false);
    await domain.sessions.reattach(scope, person(), next);
    expect(await domain.sessions.owns(scope, person(), next, opened.turn.id)).toBe(false);
    await domain.sessions.disconnect(scope, opened.connection);
    await domain.sessions.reattach(scope, person(), next);
    expect(await domain.sessions.owns(scope, person(), next, opened.turn.id)).toBe(true);
    expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
    expect(running.has(opened.turn.id)).toBe(true);
  });

  it("denies exhausted entry and closes after an imported usage delta exhausts the budget", async () => {
    const scope = await fresh();
    await db
      .insert(projectBudgets)
      .values({ id: newId("bud"), orgId, projectId, monthlyLimitCents: 0, enabled: true });
    const connection = clientIdentity();
    await domain.sessions.lease(scope, person(), connection, true);
    await expect(domain.sessions.enter(scope, person(), connection)).rejects.toMatchObject({
      code: "budget_exceeded",
    });
    expect(await domain.sessions.holder(scope)).toBeNull();
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: 1_000_000 })
      .where(eq(projectBudgets.projectId, projectId));
    const opened = await open(scope);
    await db
      .update(projectBudgets)
      .set({ monthlyLimitCents: 1 })
      .where(eq(projectBudgets.projectId, projectId));
    snapshots.get(opened.turn.id)!.records.push({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 1_000_000, output_tokens: 100 } },
      },
    });
    await importNow(scope);
    await domain.sessions.tick(scope);
    expect(await domain.sessions.holder(scope)).toBeNull();
    expect(running.has(opened.turn.id)).toBe(false);
    expect(
      await db
        .select()
        .from(turnEvents)
        .where(
          and(
            eq(turnEvents.turnId, opened.turn.id),
            eq(turnEvents.type, "session.budget_exceeded"),
          ),
        ),
    ).toHaveLength(1);
  });

  it("accounts for native model changes and refuses further budgeted work after an unknown price", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const snapshot = snapshots.get(opened.turn.id)!;
    const context = (model: string) => ({ type: "turn_context", payload: { model } });
    const tokens = (input: number, output: number) => ({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: input, output_tokens: output } },
      },
    });
    snapshot.records.push(
      context("gpt-5.5"),
      tokens(100, 10),
      context("gpt-5.5-mini"),
      tokens(200, 20),
    );
    await importNow(scope);
    const priced = (
      await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id))
    )[0]!;
    expect(priced.model).toBe("mixed");
    expect(priced.costCents).toBeCloseTo(0.1345, 8);
    await db
      .insert(projectBudgets)
      .values({ id: newId("bud"), orgId, projectId, monthlyLimitCents: 1_000_000, enabled: true });
    snapshot.records.push(context("unpriced-native-model"), tokens(300, 30));
    await importNow(scope);
    await domain.sessions.tick(scope);
    expect(await domain.sessions.holder(scope)).toBeNull();
    expect(
      (await db.select().from(turnUsage).where(eq(turnUsage.turnId, opened.turn.id)))[0],
    ).toMatchObject({ priced: false, costCents: priced.costCents });
    const next = clientIdentity();
    await domain.sessions.lease(scope, person(), next, true);
    await expect(domain.sessions.enter(scope, person(), next)).rejects.toMatchObject({
      code: "budget_usage_unconfirmed",
    });
  });

  it("ends the accounting period before a retained turn can bypass the next month's budget", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const previousMonth = new Date();
    previousMonth.setUTCDate(1);
    previousMonth.setUTCMonth(previousMonth.getUTCMonth() - 1);
    await db.update(turns).set({ createdAt: previousMonth }).where(eq(turns.id, opened.turn.id));
    await domain.sessions.tick(scope);
    expect(await domain.sessions.holder(scope)).toBeNull();
    expect(running.has(opened.turn.id)).toBe(false);
    const events = await db
      .select()
      .from(turnEvents)
      .where(and(eq(turnEvents.turnId, opened.turn.id), eq(turnEvents.type, "session.closed")));
    expect(events[0]?.data).toMatchObject({ reason: "budget_period_changed" });
  });

  it("revokes writing and gracefully closes a session when control permission is removed", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    await db
      .update(roles)
      .set({ permissions: ["sessions:observe"] })
      .where(eq(roles.id, roleId));
    await expect(
      domain.sessions.owns(scope, person(), opened.connection, opened.turn.id),
    ).rejects.toMatchObject({ code: "session_forbidden" });
    await domain.sessions.tick(scope);
    expect(await domain.sessions.holder(scope)).toBeNull();
    expect(running.has(opened.turn.id)).toBe(false);
  });

  it("guards the real WebSocket handshake, fences read-only input, and requires confirmed takeover", async () => {
    const scope = await fresh();
    const opened = await open(scope);
    const app = await buildApp(config, { storyDomain: domain, rateLimitMax: 10_000 });
    const sockets: Awaited<ReturnType<typeof app.injectWS>>[] = [];
    try {
      await app.ready();
      const path = `/v1/projects/${projectId}/workspace-stories/${scope.storyId}/session?client_id=${randomUUID()}`;
      const cookie = `facility_session=${await mintSessionCookie(config, userIds[0]!, orgId)}`;
      const listing = await app.inject({
        method: "GET",
        url: `/v1/projects/${projectId}/session-holders?limit=1000`,
        headers: { cookie },
      });
      expect(listing.statusCode).toBe(200);
      expect(listing.json().holders[scope.storyId]).toMatchObject({
        kind: "person",
        turnId: opened.turn.id,
        userId: userIds[0],
      });
      expect(listing.body).not.toContain("redactionSecrets");
      expect(listing.body).not.toContain("clientId");
      const observer = await app.injectWS(`${path}&mode=observe`, { headers: { cookie } });
      const observations: Array<Record<string, unknown>> = [];
      observer.on("message", (data) => observations.push(JSON.parse(data.toString())));
      try {
        await vi.waitFor(() =>
          expect(observations.some((message) => message.type === "holder")).toBe(true),
        );
        observer.send(JSON.stringify({ type: "takeover", turnId: opened.turn.id, confirm: true }));
        await vi.waitFor(() =>
          expect(observations.some((message) => message.code === "session_read_only")).toBe(true),
        );
        expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
      } finally {
        observer.close();
      }
      const flooding = await app.injectWS(
        path.replace(/client_id=.*/, `client_id=${randomUUID()}`),
        { headers: { cookie } },
      );
      sockets.push(flooding);
      let closeCode = 0;
      flooding.on("close", (code) => {
        closeCode = code;
      });
      for (let index = 0; index < 150; index++) flooding.send(Buffer.from("x"));
      await vi.waitFor(() => expect(closeCode).toBe(1009), { timeout: 5000 });
      expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
      await expect(app.injectWS(path)).rejects.toThrow(/401/);
      await expect(
        app.injectWS(path, { headers: { cookie, origin: "https://unrelated.example.test" } }),
      ).rejects.toThrow(/403/);
      await expect(
        app.injectWS(path.replace(projectId, newId("proj")), { headers: { cookie } }),
      ).rejects.toThrow(/404/);
      await expect(
        app.injectWS(path.replace(/client_id=.*/, "client_id=malformed"), { headers: { cookie } }),
      ).rejects.toThrow(/400/);
      const expired = await seal(
        JSON.stringify({ userId: userIds[0], orgId, exp: 0 }),
        config.secretMasterKey,
      );
      await expect(
        app.injectWS(path, { headers: { cookie: `facility_session=${expired}` } }),
      ).rejects.toThrow(/401/);
      const key = await generateApiKey("fak");
      await db.insert(apiKeys).values({
        id: key.id,
        orgId,
        name: "Fixture key",
        prefix: key.lookup,
        last4: key.last4,
        hash: key.hash,
        scopeType: "org",
        roleId,
      });

      await expect(
        app.injectWS(path, { headers: { authorization: `Bearer ${key.secret}` } }),
      ).rejects.toThrow(/403/);
      const messages: Array<Record<string, unknown>> = [];
      const socket = await app.injectWS(
        path,
        { headers: { cookie } },
        {
          onOpen: (ws) =>
            ws.on("message", (data, binary) => {
              if (!binary) messages.push(JSON.parse(data.toString()));
            }),
        },
      );
      sockets.push(socket);
      await vi.waitFor(
        () =>
          expect(
            messages.some((message) => message.type === "holder" && message.writer === false),
          ).toBe(true),
        { timeout: 5000 },
      );
      socket.send(Buffer.from("unconfirmed input"));
      await vi.waitFor(() =>
        expect(messages.some((message) => message.code === "session_read_only")).toBe(true),
      );
      expect(terminalWrites).toHaveLength(0);
      const beforeUnconfirmed = messages.length;
      socket.send(JSON.stringify({ type: "takeover", turnId: opened.turn.id, confirm: false }));
      await vi.waitFor(() =>
        expect(messages.slice(beforeUnconfirmed).some((message) => message.type === "error")).toBe(
          true,
        ),
      );
      expect((await domain.sessions.holder(scope))?.id).toBe(opened.turn.id);
      socket.send(JSON.stringify({ type: "takeover", turnId: opened.turn.id, confirm: true }));
      await vi.waitFor(
        () =>
          expect(
            messages.some((message) => message.type === "holder" && message.writer === true),
          ).toBe(true),
        { timeout: 10_000 },
      );
      socket.send(Buffer.from("native input"));
      await vi.waitFor(() => expect(terminalWrites).toEqual(["native input"]));
      socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 45 }));
      await vi.waitFor(() => expect(resizes).toContainEqual([120, 45]));
      await db.update(roles).set({ permissions: [] }).where(eq(roles.id, roleId));
      await vi.waitFor(() => expect(socket.readyState).toBe(3), { timeout: 5000 });
    } finally {
      for (const socket of sockets) socket.terminate();
      await app.close();
    }
  }, 30_000);
  it("keeps Vercel's channel read-only and explains that interactive entry is not supported yet", async () => {
    const scope = await fresh();
    const queued = await domain.stories.queueMessage({
      ...scope,
      body: "A Facility task",
      dedupeKey: randomUUID(),
      agent: manifest,
      actor: { type: "system", id: "test" },
      trigger: { type: "schedule" },
    });
    await appendTurnEvent(db, {
      ...scope,
      turnId: queued.turn!.id,
      type: "turn.phase",
      data: { phase: "fixture" },
    });
    const unsupportedDomain = {
      ...domain,
      runtime: { ...domain.runtime, provider: "vercel" as const, terminal: undefined },
    };
    const sessions = new StorySessionService(db, unsupportedDomain, config.secretMasterKey);
    const app = await buildApp(config, { storyDomain: { ...unsupportedDomain, sessions } });
    await app.ready();
    const socket = await app.injectWS(
      `/v1/projects/${projectId}/workspace-stories/${scope.storyId}/session?client_id=${randomUUID()}`,
      {
        headers: {
          cookie: `facility_session=${await mintSessionCookie(config, userIds[0]!, orgId)}`,
        },
      },
    );
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
    try {
      await vi.waitFor(() =>
        expect(
          messages.some(
            (message) =>
              message.type === "unsupported" &&
              String(message.message).includes("not supported yet"),
          ),
        ).toBe(true),
      );
      await vi.waitFor(() =>
        expect(messages.some((message) => message.type === "events")).toBe(true),
      );
      socket.send(JSON.stringify({ type: "takeover", turnId: queued.turn!.id, confirm: true }));
      await vi.waitFor(() =>
        expect(messages.some((message) => message.code === "session_not_supported")).toBe(true),
      );
      expect((await sessions.holder(scope))?.id).toBe(queued.turn?.id);
      expect(messages.some((message) => message.writer === true)).toBe(false);
    } finally {
      socket.close();
      await app.close();
    }
  });
});
