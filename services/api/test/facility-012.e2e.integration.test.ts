import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { newId } from "@facility/core";
import {
  createDb,
  engineSessions,
  githubInstallations,
  migrate,
  projectRepositories,
  seed,
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
import { GithubWorkspaceCredentialBroker } from "../src/github/workspace-credentials.js";
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
  const agentSources = await loadKickstartAgentSources();
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
  setup: printf setup-complete > .setup-complete
  start: mkdir -p .dev && printf ready >> .dev/start-count
  ready: test -s .dev/start-count
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
    };
    app = await buildApp(config, {
      storyDomain: domain,
      oauthJwks: createLocalJWKSet({ keys: [publicJwk] }),
      rateLimitMax: 10_000,
    });
    await app.listen({ port, host: "127.0.0.1" });

    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });
    const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const created = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: { cookie, "idempotency-key": `project-${suffix}` },
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

    const firstRequest = engineRequests[0];
    if (!firstRequest) throw new Error("expected first engine request");
    const workspace = firstRequest.workspace;
    expect(await runtime.read(workspace, `repos/${owner}/${repository}/agent-work`)).toBe(
      "turn-1\nturn-2\n",
    );
    expect(await runtime.read(workspace, ".facility/codex/native-session")).toBe(
      "codex-persistent-session",
    );
    expect(await runtime.read(workspace, `repos/${owner}/${repository}/.setup-complete`)).toBe(
      "setup-complete",
    );
    const sessionRows = await db
      .select()
      .from(engineSessions)
      .where(eq(engineSessions.storyId, storyId));
    expect(sessionRows).toHaveLength(1);
    expect(sessionRows[0]).toMatchObject({ nativeSessionId: "codex-persistent-session" });

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
    ]);
    expect(JSON.stringify(conversation)).not.toContain("e2e-maintainer-installation-token");

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
      "turn-1\nturn-2\n",
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
  });
});

type StoryToolBundle = {
  story: { id: string; status: string; deletedAt?: string | null };
  workspace: { id: string; state: string };
  queued: { turn: { id: string } };
  status: string;
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

async function loadKickstartAgentSources() {
  const names = [
    "architect",
    "builder",
    "pr-reviewer",
    "address-review",
    "ci-doctor",
    "security-audit",
  ];
  return Promise.all(
    names.map(async (name) => ({
      file: `.agents/${name}.md`,
      source: (
        await readFile(
          new URL(`../../../packages/cli/templates/agents/${name}.md`, import.meta.url),
          "utf8",
        )
      )
        .replaceAll("{{PLAN_MODEL}}", "claude-opus-4-8")
        .replaceAll("{{REVIEW_MODEL}}", "claude-opus-4-8")
        .replaceAll("{{CODEX_PLAN_MODEL}}", "gpt-5.5")
        .replaceAll("{{CODEX_BUILD_MODEL}}", "gpt-5.5"),
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
