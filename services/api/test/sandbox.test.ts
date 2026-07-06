import { generateApiKey, hashKey, newId, seal } from "@facility/core";
import {
  agentDefs,
  apiKeys,
  auditEvents,
  conversationMessages,
  conversations,
  createDb,
  githubInstallations,
  migrate,
  projects,
  registryItems,
  repos,
  roles,
  runEvents,
  runs,
  seed,
  virtualKeys,
} from "@facility/db";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AwsSandboxDriver } from "../src/sandbox/aws.js";
import { DockerSandboxDriver } from "../src/sandbox/docker.js";
import { finishRun, reconcileSandboxes } from "../src/sandbox/orchestrator.js";
import { appendRunEvents } from "../src/sandbox/state.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility";
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

async function dockerReachable() {
  try {
    await new DockerSandboxDriver().status("definitely-missing");
    return true;
  } catch (error) {
    return error instanceof Error && !/connect|socket|permission/i.test(error.message);
  }
}

describe("sandbox api", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; sandbox tests skipped", () => undefined);
    return;
  }

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: masterKey,
    port: 4401,
    publicUrl: "http://127.0.0.1:0",
    sandboxApiUrl: "http://127.0.0.1:0",
    sandboxGatewayUrl: "http://127.0.0.1:0",
    sandboxRunnerImage: "facility-runner:dev",
    sandboxDriver: "docker",
    webUrl: "http://localhost:3000",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  const { db, client } = createDb(databaseUrl);
  const app = await buildApp(config);
  let cookie = "";
  let orgId = "";
  let projectId = "";

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl);
    await app.ready();
    const login = await app.inject({
      method: "POST",
      url: "/auth/dev-login",
      payload: { email: `sandbox-${Date.now()}@example.com` },
    });
    cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    orgId = login.json().orgId;
    await db.delete(auditEvents).where(eq(auditEvents.orgId, orgId));
    const project = (
      await db
        .insert(projects)
        .values({
          id: newId("proj"),
          orgId,
          name: "Sandbox Test Project",
          slug: `sandbox-${Date.now()}`,
          settings: {},
        })
        .returning()
    )[0];
    projectId = project?.id ?? "";
  });

  afterAll(async () => {
    await app.close();
    await client.end();
  });

  it("imageExists reports daemon image presence without pulling", async () => {
    const withInspect = (inspect: () => Promise<unknown>) =>
      new DockerSandboxDriver({ getImage: () => ({ inspect }) } as unknown as ConstructorParameters<
        typeof DockerSandboxDriver
      >[0]);
    // Present: inspect resolves.
    expect(await withInspect(async () => ({ Id: "sha256:abc" })).imageExists("runner:dev")).toBe(
      true,
    );
    // Absent: inspect rejects with Docker's 404.
    expect(
      await withInspect(async () => {
        throw { statusCode: 404 };
      }).imageExists("runner:missing"),
    ).toBe(false);
    // A real daemon error (not 404) must propagate, not read as "absent".
    await expect(
      withInspect(async () => {
        throw { statusCode: 500, message: "daemon boom" };
      }).imageExists("runner:dev"),
    ).rejects.toMatchObject({ statusCode: 500 });
  });

  it("appendRunEvents allocates contiguous seqs under concurrent appends", async () => {
    const runId = newId("run");
    await insertRunnerRun("frt_seq", "running", runId, {});
    // Many producers append to the SAME run at once — without the per-run advisory
    // lock these race on the (run_id, seq) PK and some fail with a duplicate key.
    const count = 24;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        appendRunEvents(db, orgId, runId, [{ type: "assistant", data: { n: i } }]),
      ),
    );
    expect(results.every((r) => r.length === 1)).toBe(true);
    const rows = await db
      .select({ seq: runEvents.seq })
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.seq);
    const seqs = rows.map((r) => r.seq);
    // All appends landed, with unique + contiguous seqs starting at 1.
    expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  it("aws driver fails loudly as not_configured when env is missing", async () => {
    await expect(
      new AwsSandboxDriver().launch({
        runId: "run_test",
        image: "facility-runner:dev",
        env: {},
        cpu: 1,
        memoryMb: 512,
        timeoutMin: 1,
      }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });

  it("rejects wrong runner tokens and terminal internal posts", async () => {
    const token = "frt_test";
    const run = await insertRunnerRun(token, "running");
    const wrong = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: "Bearer wrong" },
      payload: [{ type: "assistant", data: { text: "no" } }],
    });
    expect(wrong.statusCode).toBe(401);
    await db
      .update(runs)
      .set({ status: "succeeded", endedAt: new Date() })
      .where(eq(runs.id, run.id));
    const terminal = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/events`,
      headers: { authorization: `Bearer ${token}` },
      payload: [{ type: "assistant", data: { text: "late" } }],
    });
    expect(terminal.statusCode).toBe(409);
  });

  it("finishRun persists the engine session id from the runner result", async () => {
    const run = await insertRunnerRun("frt_finish_session", "running");
    await finishRun(db, run, { status: "succeeded", engineSessionId: "sess_finish_123" });
    const stored = (await db.select().from(runs).where(eq(runs.id, run.id)).limit(1))[0];
    expect(stored?.engineSessionId).toBe("sess_finish_123");
  });

  it("finishRun appends the assistant reply to a conversation and marks it idle", async () => {
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `conversation-contract-${Date.now()}`,
        })
        .returning()
    )[0];
    if (!contract) throw new Error("contract fixture missing");
    const agent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: `conversation-agent-${Date.now()}`,
          engine: "claude_code",
          model: {},
          contractItemId: contract.id,
          triggers: [],
          permissions: [],
          enabled: true,
        })
        .returning()
    )[0];
    if (!agent) throw new Error("agent fixture missing");
    const conversation = (
      await db
        .insert(conversations)
        .values({
          id: newId("evt"),
          orgId,
          projectId,
          agentDefId: agent.id,
          status: "running",
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!conversation) throw new Error("conversation fixture missing");
    const run = await insertRunnerRun("frt_finish_conversation", "running", newId("run"), {
      runnerTokenHash: await hashKey("frt_finish_conversation"),
    });
    await db
      .update(runs)
      .set({
        agentDefId: agent.id,
        engine: "claude_code",
        mode: "conversation",
        trigger: {
          type: "conversation",
          conversationId: conversation.id,
          message: "hello",
        },
      })
      .where(eq(runs.id, run.id));
    // The message handler pins the owning run; finishConversationTurn only
    // finalizes the run the conversation points at.
    await db
      .update(conversations)
      .set({ lastRunId: run.id })
      .where(eq(conversations.id, conversation.id));
    const [conversationRun] = await db.select().from(runs).where(eq(runs.id, run.id));
    if (!conversationRun) throw new Error("conversation run fixture missing");
    await appendRunEvents(db, orgId, run.id, [
      { type: "assistant", data: { text: "first reply" } },
      { type: "assistant", data: { text: "final reply" } },
    ]);
    await finishRun(db, conversationRun, {
      status: "succeeded",
      engineSessionId: "sess_conversation_2",
    });
    const messages = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversation.id))
      .orderBy(conversationMessages.seq);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("agent");
    expect(messages[0]?.body).toBe("final reply");
    expect(messages[0]?.runId).toBe(run.id);
    const [stored] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(stored?.status).toBe("idle");
    expect(stored?.lastRunId).toBe(run.id);
    expect(stored?.engineSessionId).toBe("sess_conversation_2");
  });

  it("a foreign run cannot finalize a conversation it doesn't own (even same agent)", async () => {
    const contract = (
      await db
        .insert(registryItems)
        .values({
          id: newId("item"),
          orgId,
          scope: "project",
          projectId,
          kind: "agent_contract",
          name: `forge-contract-${Date.now()}`,
        })
        .returning()
    )[0];
    const sharedAgent = (
      await db
        .insert(agentDefs)
        .values({
          id: newId("agent"),
          orgId,
          projectId,
          name: `forge-agent-${Date.now()}`,
          engine: "claude_code",
          model: {},
          contractItemId: contract?.id ?? "",
          triggers: [],
          permissions: [],
          enabled: true,
        })
        .returning()
    )[0];
    if (!sharedAgent) throw new Error("shared agent fixture missing");
    // A running conversation pinned to its OWN in-flight run — same agent the
    // attacker uses, so ONLY the lastRunId pin distinguishes owner from forger.
    const victimRun = await insertRunnerRun("frt_victim", "running", newId("run"), {
      runnerTokenHash: await hashKey("frt_victim"),
    });
    const victimConversationId = newId("evt");
    await db.insert(conversations).values({
      id: victimConversationId,
      orgId,
      projectId,
      agentDefId: sharedAgent.id,
      status: "running",
      lastRunId: victimRun.id,
      createdBy: { type: "user", id: "victim" },
    });
    const forged = await insertRunnerRun("frt_forge", "running", newId("run"), {
      runnerTokenHash: await hashKey("frt_forge"),
    });
    await db
      .update(runs)
      .set({
        agentDefId: sharedAgent.id,
        engine: "claude_code",
        mode: "conversation",
        trigger: { type: "conversation", conversationId: victimConversationId },
      })
      .where(eq(runs.id, forged.id));
    const [forgedRun] = await db.select().from(runs).where(eq(runs.id, forged.id));
    if (!forgedRun) throw new Error("forged run fixture missing");
    await appendRunEvents(db, orgId, forged.id, [
      { type: "assistant", data: { text: "attacker reply" } },
    ]);
    await finishRun(db, forgedRun, {
      status: "succeeded",
      engineSessionId: "sess_attacker",
    }).catch(() => undefined);
    const [victim] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, victimConversationId));
    expect(victim?.status).toBe("running"); // untouched — still owned by victimRun
    expect(victim?.engineSessionId ?? null).toBeNull();
    const forgedMessages = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, victimConversationId));
    expect(forgedMessages).toHaveLength(0);
  });

  it("delivers run events over the NOTIFY-backed SSE path without safety polling", async () => {
    const token = "frt_stream";
    const run = await insertRunnerRun(token, "running");
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const streamPromise = fetch(`${address}/v1/runs/${run.id}/stream?idleMs=1500`, {
      headers: { cookie },
    }).then((response) => response.text());
    await new Promise((resolve) => setTimeout(resolve, 100));
    const posted = await fetch(`${address}/internal/runs/${run.id}/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([{ type: "assistant", data: { text: "notify delivered" } }]),
    });
    expect(posted.status).toBe(200);
    const body = await streamPromise;
    expect(body).toContain("event: run_event");
    expect(body).toContain("notify delivered");
  }, 10_000);

  it("returns a per-installation repo token for runner clone credentials", async () => {
    const token = "frt_clone";
    const installationNumber = Date.now();
    const owner = `octo-${installationNumber}`;
    const installation = (
      await db
        .insert(githubInstallations)
        .values({
          id: newId("int"),
          orgId,
          installationId: installationNumber,
          accountLogin: owner,
          targetType: "Organization",
        })
        .returning()
    )[0];
    if (!installation) throw new Error("failed to insert installation");
    await db.insert(repos).values({
      id: newId("repo"),
      orgId,
      projectId,
      installationId: installation.id,
      owner,
      name: "private-repo",
      defaultBranch: "main",
    });
    const runId = newId("run");
    const run = await insertRunnerRun(token, "provisioning", runId, {
      runnerTokenHash: await hashKey(token),
      sealedVirtualKey: await seal("fvk_test", masterKey),
      bundle: {
        runId,
        mode: "builder",
        engine: "byo",
        contract: "contract",
        skills: [],
        engineConfig: {},
        repo: {
          cloneUrl: `https://github.com/${owner}/private-repo.git`,
          branch: "main",
          installationTokenRef: installation.id,
        },
        provisionCmd: null,
        checkCmds: [],
        gatewayUrls: { anthropic: "http://gateway/anthropic", openai: "http://gateway/openai" },
        scope: {},
        timeoutMin: 60,
      },
    });
    let tokenInput: Record<string, unknown> | undefined;
    app.githubInstallationTokenFactory = async (input) => {
      tokenInput = input;
      return "installation-token";
    };

    const response = await app.inject({
      method: "POST",
      url: `/internal/runs/${run.id}/hello`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().repoToken).toBe("installation-token");
    expect(tokenInput).toEqual({
      installationId: installationNumber,
      owner,
      repo: "private-repo",
      permissions: { contents: "read" },
    });
    app.githubInstallationTokenFactory = undefined;
  });

  it("redacts sealed run credentials from run read APIs", async () => {
    const runId = newId("run");
    const run = await insertRunnerRun("frt_redact", "provisioning", runId, {
      driver: "docker",
      ref: "container-redact",
      virtualKeyId: "vk_redact",
      platformKeyId: "ak_redact",
      runnerTokenHash: await hashKey("frt_redact"),
      sealedVirtualKey: await seal("fvk_secret", masterKey),
      sealedPlatformKey: await seal("fak_secret", masterKey),
    });

    const single = await app.inject({
      method: "GET",
      url: `/v1/runs/${run.id}`,
      headers: { cookie },
    });
    expect(single.statusCode).toBe(200);
    const sandbox = (single.json().sandbox ?? {}) as Record<string, unknown>;
    // Secrets stripped...
    expect(sandbox.sealedVirtualKey).toBeUndefined();
    expect(sandbox.sealedPlatformKey).toBeUndefined();
    expect(sandbox.runnerTokenHash).toBeUndefined();
    // ...non-secret fields retained (the UI/CLI still need driver + ref).
    expect(sandbox.driver).toBe("docker");
    expect(sandbox.ref).toBe("container-redact");

    const list = await app.inject({ method: "GET", url: "/v1/runs", headers: { cookie } });
    expect(list.statusCode).toBe(200);
    const listed = (list.json() as Array<{ id: string; sandbox?: Record<string, unknown> }>).find(
      (r) => r.id === run.id,
    );
    expect(listed?.sandbox?.sealedVirtualKey).toBeUndefined();
    expect(listed?.sandbox?.sealedPlatformKey).toBeUndefined();
    expect(listed?.sandbox?.runnerTokenHash).toBeUndefined();

    // The project-scoped run list is a run-read surface too — it must redact.
    const projList = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/runs`,
      headers: { cookie },
    });
    expect(projList.statusCode).toBe(200);
    const projListed = (
      projList.json() as Array<{ id: string; sandbox?: Record<string, unknown> }>
    ).find((r) => r.id === run.id);
    expect(projListed?.sandbox?.sealedVirtualKey).toBeUndefined();
    expect(projListed?.sandbox?.sealedPlatformKey).toBeUndefined();
    expect(projListed?.sandbox?.runnerTokenHash).toBeUndefined();
  });

  it("reconciler revokes orphaned run keys (virtual + platform) of a terminal run", async () => {
    const runId = newId("run");
    // A run that reached a terminal state but (simulating a crash between the
    // status commit and the best-effort revoke) still owns live keys.
    await insertRunnerRun("frt_orphan", "succeeded", runId, {});
    // Far-future expiry throughout, so the assertions prove the *sweep* revoked
    // the keys, not their own natural expiry.
    const farFuture = new Date(Date.now() + 3_600_000);
    const vkeyId = newId("vkey");
    await db.insert(virtualKeys).values({
      id: vkeyId,
      orgId,
      projectId,
      runId,
      name: "orphan run key",
      prefix: `orphan_${Date.now()}`,
      last4: "0000",
      hash: "orphan-hash",
      expiresAt: farFuture,
    });
    const roleId = newId("key");
    await db
      .insert(roles)
      .values({ id: roleId, orgId, name: `sweep-role-${Date.now()}`, permissions: [] });
    const platformKeyId = newId("key");
    await db.insert(apiKeys).values({
      id: platformKeyId,
      orgId,
      name: "orphan platform key",
      prefix: `orphanpk_${Date.now()}`,
      last4: "0000",
      hash: "orphan-pk-hash",
      scopeType: "project",
      projectId,
      roleId,
      runId,
      expiresAt: farFuture,
    });

    await reconcileSandboxes(config);

    const [vkey] = await db.select().from(virtualKeys).where(eq(virtualKeys.id, vkeyId));
    expect(vkey?.revokedAt).not.toBeNull();
    const [pkey] = await db.select().from(apiKeys).where(eq(apiKeys.id, platformKeyId));
    expect(pkey?.revokedAt).not.toBeNull();
  });

  it("rejects an expired run-scoped platform key at authentication", async () => {
    const roleId = newId("key");
    await db
      .insert(roles)
      .values({ id: roleId, orgId, name: `expiry-role-${Date.now()}`, permissions: ["runs:read"] });
    const expired = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: expired.id,
      orgId,
      name: "expired run key",
      prefix: expired.lookup,
      last4: expired.last4,
      hash: expired.hash,
      scopeType: "project",
      projectId,
      roleId,
      // Already expired: auth must reject it even though it's not revoked.
      // (runId omitted — expiry enforcement is independent of the run link.)
      expiresAt: new Date(Date.now() - 1000),
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs",
      headers: { authorization: `Bearer ${expired.secret}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("launches, stops, and destroys a docker sleep container when Docker is reachable", async () => {
    if (!(await dockerReachable())) {
      console.warn("Docker socket is not reachable from this sandbox; skipping docker driver test");
      return;
    }
    const driver = new DockerSandboxDriver();
    const launched = await driver.launch({
      runId: `run_${Date.now()}`,
      image: "alpine:3.20",
      env: {},
      cpu: 0.5,
      memoryMb: 128,
      timeoutMin: 1,
      cmd: ["sleep", "30"],
    });
    expect(await driver.status(launched.ref)).toBe("running");
    await driver.stop(launched.ref);
    expect(await driver.status(launched.ref)).toBe("exited");
    await driver.destroy(launched.ref);
    expect(await driver.status(launched.ref)).toBe("lost");
  }, 60_000);

  it("reconciler destroys orphan docker containers after label and run-state double check", async () => {
    if (!(await dockerReachable())) {
      console.warn(
        "Docker socket is not reachable from this sandbox; skipping docker reconciler test",
      );
      return;
    }
    const driver = new DockerSandboxDriver();
    const runId = `run_orphan_${Date.now()}`;
    const launched = await driver.launch({
      runId,
      image: "alpine:3.20",
      env: {},
      cpu: 0.5,
      memoryMb: 128,
      timeoutMin: 1,
      cmd: ["sleep", "30"],
    });
    await reconcileSandboxes(config);
    expect(await driver.status(launched.ref)).toBe("lost");
  }, 60_000);

  async function insertRunnerRun(
    token: string,
    status: string,
    runId = newId("run"),
    sandbox?: Record<string, unknown>,
  ) {
    const sandboxState = sandbox ?? { runnerTokenHash: await hashKey(token) };
    const row = (
      await db
        .insert(runs)
        .values({
          id: runId,
          orgId,
          projectId,
          mode: "builder",
          engine: "byo",
          status,
          trigger: {},
          sandbox: sandboxState,
          createdBy: { type: "user", id: "test" },
        })
        .returning()
    )[0];
    if (!row) throw new Error("failed to insert runner run");
    return row;
  }
});
