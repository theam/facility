import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  createDb,
  engineSessions,
  githubInstallations,
  migrate,
  projectRepositories,
  seed,
  turns,
} from "@facility/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentCatalogService, type AgentCatalogSource } from "../src/agents/catalog.js";
import { GithubAgentTriggerService } from "../src/agents/github-triggers.js";
import { AgentScheduler } from "../src/agents/scheduler.js";
import { buildApp } from "../src/app.js";
import { GithubMirrorService } from "../src/github/mirror.js";
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
import { CostBudgetService } from "../src/insights/costs.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import type { StoryDomain } from "../src/story-domain.js";
import { TurnDispatcher } from "../src/turns/dispatcher.js";
import {
  type AgentEngine,
  AgentEngineRegistry,
  type AgentTurnRequest,
  type AgentTurnResult,
} from "../src/turns/engines.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { WorkspacePreviewService } from "../src/workspaces/preview.js";
import {
  ProjectEnvironmentService,
  type ProjectManifestSource,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_ws";

async function canConnect() {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

describe("Facility 0.12 reference journey", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const { db, client: databaseClient } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-012-e2e-"));
  const remotes = join(root, "remotes");
  const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
  const suffix = crypto.randomUUID().slice(0, 8);
  const owner = "facility-e2e";
  const repository = `app-${suffix}`;
  const installationId = newId("ghi");
  const queuedTurns: string[] = [];
  const engineRequests: AgentTurnRequest[] = [];
  const agentSources = await loadKickstartAgentSources(root);
  const builderSource = agentSources.find((source) => source.file === ".agents/builder.md");
  if (!builderSource) throw new Error("kickstart builder manifest is missing");
  const canonicalBuilder = parseAgentManifest(builderSource.source, ".agents/builder.md");
  const catalogSource: AgentCatalogSource = {
    load: async () => ({ commitSha: "b".repeat(40), sources: agentSources }),
  };
  const catalog = new AgentCatalogService(db, catalogSource);
  const credentials = new GithubWorkspaceCredentialBroker(db, async () => ({
    token: "e2e-maintainer-installation-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
  }));
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), kid: "e2e-key", alg: "ES256", use: "sig" };
  const publicJwk = { ...(await exportJWK(publicKey)), kid: "e2e-key", alg: "ES256", use: "sig" };
  let app: Awaited<ReturnType<typeof buildApp>>;
  let mcp: Client;
  let backend = createServer();
  let backendPort = 0;
  let origin = "";
  let projectId = "";
  let storyId = "";
  let browserCookie = "";

  class RecordingEngine implements AgentEngine {
    constructor(readonly name: "claude_code" | "codex") {}

    async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
      engineRequests.push(request);
      const sequence = engineRequests.length;
      const nativeSessionId = request.nativeSessionId ?? `${this.name}-persistent-session`;
      const work = await runtime.exec(request.workspace, {
        command: "sh",
        args: ["-lc", `printf 'turn-${sequence}\\n' >> agent-work`],
        cwd: request.cwd,
      });
      await runtime.exec(request.workspace, {
        command: "sh",
        args: [
          "-lc",
          `mkdir -p .facility/${this.name === "codex" ? "codex" : "claude"} && printf '%s' ${JSON.stringify(nativeSessionId)} > .facility/${this.name === "codex" ? "codex" : "claude"}/native-session`,
        ],
      });
      return {
        nativeSessionId,
        output: `completed turn ${sequence} with ${request.environment?.GH_TOKEN}`,
        events: [
          {
            engine: this.name,
            type: "item.completed",
            data: { sequence, credential: request.environment?.GH_TOKEN },
          },
        ],
        exitCode: 0,
        stderr: "",
        durationMs: work.durationMs,
      };
    }
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
    await createBareRepository(remotes, owner, repository);

    backend = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          authorized: typeof request.headers["x-facility-preview-token"] === "string",
        }),
      );
    });
    await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
    backendPort = (backend.address() as { port: number }).port;

    const projectManifest = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/${owner}/${repository}
  related: []
environment:
  setup: |
    count=$(cat .setup-complete 2>/dev/null || printf 0)
    printf '%s' "$((count + 1))" > .setup-complete
  seed: mkdir -p .dev && printf seeded > .dev/seed
  start: mkdir -p .dev && printf ready >> .dev/start-count
  ready: test -s .dev/start-count
  browser_test: |
    test "$(cat .dev/seed)" = seeded
    mkdir -p "$FACILITY_ARTIFACT_DIR"
    printf screenshot > "$FACILITY_ARTIFACT_DIR/story.png"
    printf trace > "$FACILITY_ARTIFACT_DIR/browser-trace.json"
  services:
    web:
      port: ${backendPort}
      protocol: http
      websocket: true
`);
    const projectManifests: ProjectManifestSource = { load: async () => projectManifest };
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);
    const stories = new StoryWorkspaceService(db, runtime, async (turn) => {
      queuedTurns.push(turn.id);
    });
    const engines = new AgentEngineRegistry([
      new RecordingEngine("claude_code"),
      new RecordingEngine("codex"),
    ]);
    const dispatcher = new TurnDispatcher(
      db,
      stories,
      catalog,
      credentials,
      projectManifests,
      environment,
      engines,
    );

    const port = await unusedPort();
    origin = `http://127.0.0.1:${port}`;
    const config: AppConfig = {
      databaseUrl,
      secretMasterKey: Buffer.alloc(32, 41).toString("base64"),
      port,
      publicUrl: origin,
      webUrl: origin,
      previewUrl: origin,
      workspaceImage: "facility-runner:test",
      workspaceDriver: "docker",
      facilityInsecureDev: true,
      oauthIssuer: origin,
      mcpPublicUrl: `${origin}/mcp`,
      oauthJwks: { keys: [privateJwk] },
      logLevel: "silent",
    };
    const previews = new WorkspacePreviewService(
      db,
      config,
      runtime,
      credentials,
      projectManifests,
      environment,
    );
    const domain: StoryDomain = {
      runtime,
      stories,
      catalog,
      credentials,
      projectManifests: projectManifests as StoryDomain["projectManifests"],
      environment,
      engines,
      dispatcher,
      previews,
      scheduler: new AgentScheduler(db, catalog, stories, projectManifests, config.workspaceImage),
      githubTriggers: new GithubAgentTriggerService(
        db,
        catalog,
        stories,
        projectManifests,
        config.workspaceImage,
      ),
      mirror: new GithubMirrorService(db, async () => {
        throw new Error("GitHub mirror is not used by this fixture");
      }),
      costs: new CostBudgetService(db),
    };
    app = await buildApp(config, {
      storyDomain: domain,
      oauthJwks: createLocalJWKSet({ keys: [publicJwk] }),
      rateLimitMax: 10_000,
    });
    await app.listen({ port, host: "127.0.0.1" });

    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
    browserCookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie: browserCookie, "idempotency-key": `project-${suffix}` },
      payload: { name: "Facility 0.12 E2E", slug: `facility-012-e2e-${suffix}` },
    });
    expect(created.statusCode, created.body).toBe(200);
    projectId = created.json().id;
    await db.insert(githubInstallations).values({
      id: installationId,
      orgId: "org_local",
      installationId: 8_000_000 + Math.floor(Math.random() * 100_000),
      accountId: 9_000_000,
      accountLogin: owner,
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: newId("repo"),
      orgId: "org_local",
      projectId,
      installationId,
      owner,
      name: repository,
      defaultBranch: "main",
      role: "primary",
    });

    const accessToken = await new SignJWT({ org_id: "org_local", scope: "facility:mcp" })
      .setProtectedHeader({ alg: "ES256", kid: "e2e-key" })
      .setIssuer(origin)
      .setAudience(`${origin}/mcp`)
      .setSubject("user_local_admin")
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(privateKey);
    mcp = new Client({ name: "facility-012-e2e", version: "0.12.0" });
    await mcp.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      }),
    );
  });

  afterAll(async () => {
    await mcp?.close();
    await app?.close();
    await databaseClient.end();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("keeps the full MCP story journey in one durable workspace and native session", async () => {
    const agents = mcpData(
      await mcp.callTool({ name: "facility_list_agents", arguments: { projectId } }),
    ) as { agents: Array<{ name: string; hash: string; model: string }> };
    expect(agents.agents).toHaveLength(6);
    expect(agents.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "builder",
          hash: canonicalBuilder.hash,
          model: canonicalBuilder.model,
        }),
      ]),
    );

    const startArguments = {
      projectId,
      provider: "manual",
      title: "Prove the Facility 0.12 reference journey",
      agent: "builder",
      message: "Create a durable change and keep the same native session for my follow-up.",
      idempotencyKey: `story-start-${suffix}`,
    };
    const started = mcpData(
      await mcp.callTool({ name: "facility_start_story", arguments: startArguments }),
    ) as StoryToolBundle;
    storyId = started.story.id;
    const workspaceId = started.workspace.id;
    const firstTurnId = started.queued.turn.id;
    expect(started.status).toBe("working");
    expect(queuedTurns).toEqual([firstTurnId]);

    const replayed = mcpData(
      await mcp.callTool({ name: "facility_start_story", arguments: startArguments }),
    ) as StoryToolBundle;
    expect(replayed.story.id).toBe(storyId);
    expect(replayed.workspace.id).toBe(workspaceId);
    expect(queuedTurns).toEqual([firstTurnId]);

    await expect(
      app.storyDomain.dispatcher.dispatch({
        orgId: "org_local",
        projectId,
        turnId: firstTurnId,
      }),
    ).resolves.toMatchObject({ claimed: true, state: "succeeded" });
    expect(engineRequests[0]).toMatchObject({ nativeSessionId: undefined });
    expect(engineRequests[0]?.environment).toMatchObject({
      GH_TOKEN: "e2e-maintainer-installation-token",
      GITHUB_TOKEN: "e2e-maintainer-installation-token",
      GIT_CONFIG_VALUE_0: "!facility-git-credential",
    });

    const followUp = mcpData(
      await mcp.callTool({
        name: "facility_send_message",
        arguments: {
          projectId,
          storyId,
          agent: "builder",
          message:
            "Continue in the existing checkout and verify the prior change is still present.",
          idempotencyKey: `story-follow-up-${suffix}`,
        },
      }),
    ) as { queued: { turn: { id: string } } };
    await expect(
      app.storyDomain.dispatcher.dispatch({
        orgId: "org_local",
        projectId,
        turnId: followUp.queued.turn.id,
      }),
    ).resolves.toMatchObject({ claimed: true, state: "succeeded" });
    expect(engineRequests[1]?.nativeSessionId).toBe("codex-persistent-session");
    expect(engineRequests[1]?.workspace.id).toBe(workspaceId);

    const switchEngine = mcpData(
      await mcp.callTool({
        name: "facility_send_message",
        arguments: {
          projectId,
          storyId,
          agent: "architect",
          message: "Inspect the same worktree using the Claude Code engine.",
          idempotencyKey: `story-switch-engine-${suffix}`,
        },
      }),
    ) as { queued: { turn: { id: string } } };
    await expect(
      app.storyDomain.dispatcher.dispatch({
        orgId: "org_local",
        projectId,
        turnId: switchEngine.queued.turn.id,
      }),
    ).resolves.toMatchObject({ claimed: true, state: "succeeded" });
    expect(engineRequests[2]).toMatchObject({ nativeSessionId: undefined });
    expect(engineRequests[2]?.manifest).toMatchObject({ name: "architect", engine: "claude_code" });
    expect(engineRequests[2]?.workspace.id).toBe(workspaceId);

    const firstRequest = engineRequests[0];
    if (!firstRequest) throw new Error("expected first engine request");
    const workspace = firstRequest.workspace;
    expect(await runtime.read(workspace, `repos/${owner}/${repository}/agent-work`)).toBe(
      "turn-1\nturn-2\nturn-3\n",
    );
    expect(await runtime.read(workspace, ".facility/codex/native-session")).toBe(
      "codex-persistent-session",
    );
    expect(await runtime.read(workspace, `repos/${owner}/${repository}/.setup-complete`)).toBe("1");
    const sessionRows = await db
      .select()
      .from(engineSessions)
      .where(eq(engineSessions.storyId, storyId));
    expect(sessionRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          engine: "codex",
          nativeSessionId: "codex-persistent-session",
        }),
        expect.objectContaining({
          engine: "claude_code",
          nativeSessionId: "claude_code-persistent-session",
        }),
      ]),
    );

    const conversation = mcpData(
      await mcp.callTool({
        name: "facility_get_conversation",
        arguments: { projectId, storyId, after: 0, limit: 50 },
      }),
    ) as { messages: Array<{ role: string; body: string }> };
    expect(conversation.messages.map((message) => message.role)).toEqual([
      "user",
      "agent",
      "user",
      "agent",
      "user",
      "agent",
    ]);
    expect(JSON.stringify(conversation)).not.toContain("e2e-maintainer-installation-token");

    const mcpStory = mcpData(
      await mcp.callTool({ name: "facility_get_story", arguments: { projectId, storyId } }),
    ) as StoryToolBundle;
    const uiStory = await app.inject({
      method: "GET",
      url: `/v1/projects/${projectId}/workspace-stories/${storyId}`,
      headers: { cookie: browserCookie },
    });
    expect(uiStory.statusCode, uiStory.body).toBe(200);
    expect(uiStory.json()).toMatchObject({
      story: { id: mcpStory.story.id, status: mcpStory.story.status },
      workspace: { id: mcpStory.workspace.id, state: mcpStory.workspace.state },
      next_operations: mcpStory.next_operations,
    });

    const browserTest = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories/${storyId}/environment/browser-test`,
      headers: { cookie: browserCookie },
    });
    expect(browserTest.statusCode, browserTest.body).toBe(200);
    expect(browserTest.json().browser_test.artifacts).toHaveLength(2);
    const cleanSetup = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories/${storyId}/environment/clean-setup`,
      headers: { cookie: browserCookie },
    });
    expect(cleanSetup.statusCode, cleanSetup.body).toBe(200);
    expect(await runtime.read(workspace, `repos/${owner}/${repository}/.setup-complete`)).toBe("2");
    expect(await runtime.read(workspace, ".facility/codex/native-session")).toBe(
      "codex-persistent-session",
    );

    const preview = mcpData(
      await mcp.callTool({
        name: "facility_open_preview",
        arguments: { projectId, storyId, service: "web" },
      }),
    ) as { sessionId: string; url: string };
    const exchange = await fetch(preview.url, { redirect: "manual" });
    expect(exchange.status).toBe(302);
    const previewCookie = exchange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(previewCookie).toContain(`facility_workspace_preview_${preview.sessionId}=`);
    if (!previewCookie) throw new Error("expected preview cookie");
    const browserResult = await fetch(
      `${origin}/workspace-preview/${preview.sessionId}/health?source=e2e`,
      { headers: { cookie: previewCookie } },
    );
    expect(browserResult.status).toBe(200);
    await expect(browserResult.json()).resolves.toEqual({
      method: "GET",
      path: "/health?source=e2e",
      authorized: true,
    });

    const suspended = mcpData(
      await mcp.callTool({
        name: "facility_suspend_story",
        arguments: { projectId, storyId },
      }),
    ) as StoryToolBundle;
    expect(suspended.workspace.state).toBe("sleeping");
    await runtime.replaceCompute(workspace);
    const restored = mcpData(
      await mcp.callTool({
        name: "facility_restore_story",
        arguments: { projectId, storyId },
      }),
    ) as StoryToolBundle;
    expect(restored.workspace.state).toBe("running");
    expect(await runtime.read(workspace, `repos/${owner}/${repository}/agent-work`)).toBe(
      "turn-1\nturn-2\nturn-3\n",
    );
    expect(await runtime.read(workspace, ".facility/codex/native-session")).toBe(
      "codex-persistent-session",
    );

    const archived = mcpData(
      await mcp.callTool({
        name: "facility_archive_story",
        arguments: { projectId, storyId },
      }),
    ) as StoryToolBundle;
    expect(archived.story.status).toBe("archived");
    expect(archived.workspace.state).toBe("sleeping");
    await mcp.callTool({
      name: "facility_restore_story",
      arguments: { projectId, storyId },
    });

    const deleted = mcpData(
      await mcp.callTool({
        name: "facility_delete_workspace",
        arguments: {
          projectId,
          storyId,
          confirm: true,
          idempotencyKey: `delete-workspace-${suffix}`,
        },
      }),
    ) as StoryToolBundle;
    expect(deleted.story.deletedAt).toBeTruthy();
    expect(deleted.workspace.state).toBe("destroyed");
    await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "destroyed" });
    const revokedPreview = await fetch(`${origin}/workspace-preview/${preview.sessionId}/health`, {
      headers: { cookie: previewCookie },
    });
    expect(revokedPreview.status).toBe(401);
    const replayedDelete = mcpData(
      await mcp.callTool({
        name: "facility_delete_workspace",
        arguments: {
          projectId,
          storyId,
          confirm: true,
          idempotencyKey: `delete-workspace-${suffix}`,
        },
      }),
    ) as StoryToolBundle;
    expect(replayedDelete.workspace.id).toBe(workspaceId);
    expect(replayedDelete.workspace.state).toBe("destroyed");
  });

  it("dispatches every kickstart agent with its own model, prompt, and MCP trigger", async () => {
    const listed = mcpData(
      await mcp.callTool({ name: "facility_list_agents", arguments: { projectId } }),
    ) as {
      agents: Array<{ name: string; engine: string; model: string; prompt: string }>;
    };
    const expectedNames = [
      "address-review",
      "architect",
      "builder",
      "ci-doctor",
      "pr-reviewer",
      "security-audit",
    ];
    expect(listed.agents.map((agent) => agent.name)).toEqual(expectedNames);

    for (const agent of listed.agents) {
      const message = `Smoke test the ${agent.name} role with its canonical configuration.`;
      const started = mcpData(
        await mcp.callTool({
          name: "facility_start_story",
          arguments: {
            projectId,
            provider: "manual",
            title: `Agent smoke: ${agent.name}`,
            agent: agent.name,
            message,
            idempotencyKey: `agent-smoke-${agent.name}-${suffix}`,
          },
        }),
      ) as StoryToolBundle;
      const turnId = started.queued.turn.id;
      await expect(
        app.storyDomain.dispatcher.dispatch({ orgId: "org_local", projectId, turnId }),
      ).resolves.toMatchObject({ claimed: true, state: "succeeded" });
      const request = engineRequests.at(-1);
      expect(request?.manifest).toMatchObject({
        name: agent.name,
        engine: agent.engine,
        model: agent.model,
      });
      expect(request?.manifest.prompt).toBe(agent.prompt);
      expect(request?.prompt).toContain(message);
      expect(request?.prompt).toContain(agent.prompt);
      await expect(
        db.select().from(turns).where(eq(turns.id, turnId)).limit(1),
      ).resolves.toMatchObject([
        {
          triggerType: "mcp",
          agentName: agent.name,
          engine: agent.engine,
          model: agent.model,
        },
      ]);
      const deleted = mcpData(
        await mcp.callTool({
          name: "facility_delete_workspace",
          arguments: {
            projectId,
            storyId: started.story.id,
            confirm: true,
            idempotencyKey: `agent-smoke-delete-${agent.name}-${suffix}`,
          },
        }),
      ) as StoryToolBundle;
      expect(deleted.workspace.state).toBe("destroyed");
    }

    const uiStarted = await app.inject({
      method: "POST",
      url: `/v1/projects/${projectId}/workspace-stories`,
      headers: { cookie: browserCookie, "x-facility-surface": "ui" },
      payload: {
        provider: "manual",
        title: "UI dispatcher smoke",
        agent: "builder",
        message: "Dispatch this turn through the UI surface.",
        idempotency_key: `ui-dispatch-${suffix}`,
      },
    });
    expect(uiStarted.statusCode, uiStarted.body).toBe(202);
    const uiBundle = uiStarted.json() as StoryToolBundle;
    await expect(
      db.select().from(turns).where(eq(turns.id, uiBundle.queued.turn.id)).limit(1),
    ).resolves.toMatchObject([{ triggerType: "ui", agentName: "builder" }]);
    const uiDeleted = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${projectId}/workspace-stories/${uiBundle.story.id}/workspace`,
      headers: {
        cookie: browserCookie,
        "idempotency-key": `ui-delete-${suffix}`,
      },
      payload: { confirm: true, idempotency_key: `ui-delete-${suffix}` },
    });
    expect(uiDeleted.statusCode, uiDeleted.body).toBe(200);
  });
});

type StoryToolBundle = {
  story: { id: string; status: string; deletedAt?: string | null };
  workspace: { id: string; state: string };
  queued: { turn: { id: string } };
  status: string;
  next_operations: string[];
};

function mcpData(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  const structured = result.structuredContent as { data?: unknown } | undefined;
  if (structured && "data" in structured) return structured.data;
  const text = (result.content as Array<{ type: string; text?: string }>).find(
    (part) => part.type === "text",
  )?.text;
  return text ? JSON.parse(text) : undefined;
}

async function loadKickstartAgentSources(root: string) {
  const names = [
    "architect",
    "builder",
    "pr-reviewer",
    "address-review",
    "ci-doctor",
    "security-audit",
  ];
  const target = join(root, "kickstart");
  await mkdir(target, { recursive: true });
  await command("git", ["init", "--initial-branch=main"], target);
  await writeFile(join(target, "package.json"), '{"name":"fixture","private":true}\n');
  await command(
    process.execPath,
    [
      fileURLToPath(new URL("../../../packages/cli/bin/facility.mjs", import.meta.url)),
      "init",
      "--yes",
      `--dir=${target}`,
      "--repo=facility-e2e/app",
      "--start=true",
      "--plan-model=claude-opus-4-8",
      "--review-model=claude-opus-4-8",
      "--codex-plan-model=gpt-5.5",
      "--codex-build-model=gpt-5.5",
    ],
    target,
  );
  return Promise.all(
    names.map(async (name) => ({
      file: `.agents/${name}.md`,
      source: await readFile(join(target, ".agents", `${name}.md`), "utf8"),
    })),
  );
}

async function createBareRepository(root: string, owner: string, name: string) {
  const bare = join(root, owner, `${name}.git`);
  const work = join(root, "seed", name);
  await mkdir(join(root, owner), { recursive: true });
  await mkdir(work, { recursive: true });
  await command("git", ["init", "--bare", "--initial-branch=main", bare]);
  await command("git", ["init", "--initial-branch=main"], work);
  await writeFile(join(work, "README.md"), "# Facility 0.12 acceptance\n");
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

async function unusedPort() {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function command(executable: string, args: string[], cwd?: string) {
  await new Promise<void>((resolve, reject) => {
    execFile(executable, args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve();
    });
  });
}
