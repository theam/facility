import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { generateApiKey, newId, seal } from "@facility/core";
import {
  apiKeys,
  attentionItems,
  auditEvents,
  createDb,
  engineSessions,
  type FacilityDb,
  migrate,
  orgMembers,
  orgs,
  projectBudgets,
  projects,
  roles,
  stories,
  storyMessages,
  turnEvents,
  turns,
  turnUsage,
  users,
} from "@facility/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import type { Snapshot } from "../src/sessions/native.js";
import {
  interactiveState,
  type SessionScope,
  StorySessionService,
} from "../src/sessions/service.js";
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
        if (operation === "probe") stdout = JSON.stringify({ started: running.has(turnId!) });
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

  afterAll(async () => {
    if (domain) {
      for (const table of [
        "audit_events",
        "api_keys",
        "session_waiters",
        "turn_usage",
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
    ).toMatchObject({ priced: false, costCents: null });
    const next = clientIdentity();
    await domain.sessions.lease(scope, person(), next, true);
    await expect(domain.sessions.enter(scope, person(), next)).rejects.toMatchObject({
      code: "budget_model_unpriced",
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
