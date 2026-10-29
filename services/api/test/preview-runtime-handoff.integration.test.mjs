import assert from "node:assert/strict";
import { execFile as cb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseAgentManifest } from "@facility/agents";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  githubPullRequests,
  migrate,
  orgMembers,
  orgs,
  projectRepositories,
  projects,
  roles,
  seed,
  stories,
  storyConversations,
  storyDeliveryPullRequests,
  storyDeliveryScopes,
  storyPreviewConvergences,
  users,
  workspaces,
} from "@facility/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { eq } from "drizzle-orm";
import { it } from "vitest";
import { createFacilityMcpServer } from "../../../packages/mcp/src/tools.js";
import { buildApp } from "../src/app.js";
import { StoryPreviewConvergenceService } from "../src/stories/preview-convergence.js";
import { StoryPreviewConvergenceExecutor } from "../src/stories/preview-convergence-executor.js";
import { StoryWorkspaceService } from "../src/stories/service.js";
import { createStoryDomain } from "../src/story-domain.js";
import { TurnDispatcher } from "../src/turns/dispatcher.js";
import { AgentEngineRegistry } from "../src/turns/engines.js";
import { TurnGitEvidenceService } from "../src/turns/git-evidence.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import {
  ProjectEnvironmentService,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";

it("preserves the converged next turn, fences delayed stops, and advertises delivery execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "facility-preview-handoff-"));
  const url =
    process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
  assert.ok(url, "Set DATABASE_URL to your own disposable local facility_test database");
  assert.equal(new URL(url).hostname, "127.0.0.1");
  assert.equal(new URL(url).pathname, "/facility_test");
  const { db, client } = createDb(url);
  const execFile = promisify(cb);
  const git = async (cwd, args) => (await execFile("git", args, { cwd })).stdout.trim();
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const barrier = () => {
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    return { promise, resolve };
  };
  const actor = { type: "user", id: "user_review_pr498" };
  await migrate(url);
  await seed(url, { includeDemoData: false });
  await db
    .insert(orgs)
    .values({ id: "org_review_pr498", name: "PR 498 synthetic review", slug: "pr498-review" })
    .onConflictDoNothing();
  await db
    .insert(users)
    .values({ id: "user_review_pr498", email: "pr498-review@example.test", status: "active" })
    .onConflictDoNothing();
  await db
    .insert(roles)
    .values({
      id: "role_review_pr498",
      orgId: "org_review_pr498",
      name: "review owner",
      permissions: ["*"],
    })
    .onConflictDoNothing();
  await db
    .insert(orgMembers)
    .values({
      id: "member_review_pr498",
      orgId: "org_review_pr498",
      userId: "user_review_pr498",
      roleId: "role_review_pr498",
    })
    .onConflictDoNothing();
  async function fixture(kind, RuntimeClass = FakeWorkspaceRuntime, block = false) {
    const suffix = randomUUID().slice(0, 8),
      projectId = newId("proj"),
      repositoryId = newId("repo"),
      storyId = newId("story"),
      workspaceId = newId("ws");
    const name = "app-" + suffix,
      localRoot = join(root, kind);
    await mkdir(localRoot, { recursive: true });
    const remote = join(localRoot, name + ".git"),
      source = join(localRoot, "source");
    await git(localRoot, ["init", "--bare", "--initial-branch=main", remote]);
    await git(localRoot, ["clone", remote, source]);
    await git(source, ["config", "user.name", "Review Test"]);
    await git(source, ["config", "user.email", "review@example.test"]);
    await writeFile(join(source, "README.md"), "base\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "base"]);
    await git(source, ["push", "origin", "main"]);
    await git(source, ["switch", "-c", "feature/story"]);
    await writeFile(join(source, "application.txt"), "A\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "A"]);
    const A = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "feature/story"]);
    const runtime = new RuntimeClass(join(localRoot, "runtime"));
    const ws = await runtime.create({ id: workspaceId, image: "review:test" });
    await mkdir(join(ws.volumeRef, "repos/acme"), { recursive: true });
    await git(join(ws.volumeRef, "repos/acme"), ["clone", remote, name]);
    const repo = join(ws.volumeRef, "repos/acme", name);
    await db
      .insert(projects)
      .values({ id: projectId, orgId: "org_review_pr498", name: kind, slug: "review-" + suffix });
    await db.insert(projectRepositories).values({
      id: repositoryId,
      orgId: "org_review_pr498",
      projectId,
      owner: "acme",
      name,
      defaultBranch: "main",
      role: "primary",
    });
    const scope = { orgId: "org_review_pr498", projectId, storyId };
    await db.insert(stories).values({
      ...scope,
      id: storyId,
      provider: "manual",
      externalId: storyId,
      title: kind,
      branch: "feature/story",
      createdBy: actor,
    });
    await db.insert(storyConversations).values({ ...scope, id: newId("sess") });
    await db.insert(workspaces).values({
      ...scope,
      id: workspaceId,
      provider: "fake",
      externalRef: ws.externalRef,
      volumeRef: ws.volumeRef,
      state: "running",
      environment: { image: ws.image, variables: {}, ports: [] },
    });
    const credentials = {
      repositories: [{ owner: "acme", name, defaultBranch: "main", role: "primary" }],
      environment: {
        GH_TOKEN: "synthetic-preview-token",
        GITHUB_TOKEN: "synthetic-preview-token",
        FACILITY_GITHUB_CREDENTIALS: JSON.stringify({
          [`acme/${name}`]: "synthetic-preview-token",
        }),
      },
      gitIdentity: { name: "Review Test", email: "review@example.test" },
      expiresAt: new Date(Date.now() + 3600000),
    };
    const manifest = parseProjectManifest(
      `version: 1\nrepositories:\n  primary: github.com/acme/${name}\nenvironment:\n  setup: 'true'\n  start: '${block ? "fixture-block-start" : "true"}'\n${block ? "" : "  seed: 'printf seeded > retained-data.txt'\n"}`,
    );
    const environment = new ProjectEnvironmentService(db, runtime);
    const initial = block
      ? null
      : await environment.prepare({
          ...scope,
          workspace: ws,
          manifest,
          credentials,
          branch: "feature/story",
        });
    await db.insert(githubPullRequests).values({
      ...scope,
      id: newId("ghp"),
      repositoryId,
      number: 7,
      title: kind,
      state: "open",
      headRef: "feature/story",
      baseRef: "main",
      headSha: A,
      htmlUrl: `https://github.com/acme/${name}/pull/7`,
      githubUpdatedAt: new Date(),
      syncedAt: new Date(),
    });
    await db.insert(storyDeliveryScopes).values({
      ...scope,
      revision: 1,
      declaredComplete: true,
      executionAuthorization: { revision: 1, actor },
      updatedBy: actor,
    });
    await db
      .insert(storyDeliveryPullRequests)
      .values({ ...scope, repositoryId, pullNumber: 7, required: true, isPrimary: true });
    const broker = { issue: async () => credentials },
      manifests = { load: async () => manifest };
    const advance = async () => {
      await writeFile(join(source, "application.txt"), "B\n");
      await writeFile(join(source, "external.txt"), "external correction\n");
      await git(source, ["add", "."]);
      await git(source, ["commit", "-m", "external correction B"]);
      const B = await git(source, ["rev-parse", "HEAD"]);
      await git(source, ["push", "origin", "feature/story"]);
      await db
        .update(githubPullRequests)
        .set({ headSha: B, githubUpdatedAt: new Date(), syncedAt: new Date() })
        .where(eq(githubPullRequests.repositoryId, repositoryId));
      return B;
    };
    return {
      scope,
      runtime,
      ws,
      repo,
      source,
      A,
      advance,
      credentials,
      manifest,
      environment,
      broker,
      manifests,
      initial,
    };
  }
  const config = {
    databaseUrl: url,
    secretMasterKey: Buffer.alloc(32, 7).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: "review:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
  };
  try {
    // The real successor TurnDispatcher invokes prepare() with no cleanSetup override.
    const f = await fixture("detached-handoff");
    await writeFile(join(f.repo, "retained-data.txt"), "edited by user");
    const native = join(f.ws.volumeRef, ".facility/codex/native-session");
    await writeFile(native, "retained-native-session");
    const B = await f.advance();
    const preview = new StoryPreviewConvergenceService(db, async () => undefined);
    await preview.observe(f.scope);
    const executor = new StoryPreviewConvergenceExecutor(
      db,
      f.runtime,
      f.broker,
      f.manifests,
      f.environment,
      preview,
    );
    const ready = await executor.dispatch(f.scope);
    assert.equal(ready.state, "ready");
    assert.equal(await git(f.repo, ["rev-parse", "HEAD"]), B);
    assert.equal(await readFile(join(f.repo, "retained-data.txt"), "utf8"), "edited by user");
    const service = new StoryWorkspaceService(db, f.runtime);
    const agent = parseAgentManifest(
      "---\nname: builder\ndescription: Synthetic review builder.\nengine: codex\nmodel: gpt-5.5\nenabled: true\ntriggers:\n  - type: manual\n---\nContinue the requested correction.\n",
      "builder.md",
    );
    let engineObservation;
    const engine = {
      name: "codex",
      run: async () => {
        engineObservation = {
          head: await git(f.repo, ["rev-parse", "HEAD"]),
          application: await readFile(join(f.repo, "application.txt"), "utf8"),
          data: await readFile(join(f.repo, "retained-data.txt"), "utf8"),
          native: await readFile(native, "utf8"),
        };
        return {
          nativeSessionId: "review-native",
          output: "Synthetic correction completed.",
          progress: [],
          events: [],
          exitCode: 0,
          stderr: "",
          durationMs: 1,
        };
      },
    };
    const dispatcher = new TurnDispatcher(
      db,
      service,
      {},
      f.broker,
      f.manifests,
      f.environment,
      new AgentEngineRegistry([engine]),
      new TurnGitEvidenceService(db, f.runtime),
      undefined,
      f.runtime,
    );
    const queued = await service.queueMessage({
      ...f.scope,
      body: "Continue with the requested correction.",
      dedupeKey: randomUUID(),
      agent,
      actor,
      trigger: { type: "manual" },
    });
    assert.ok(queued.turn);
    const dispatched = await dispatcher.dispatch({
      orgId: f.scope.orgId,
      projectId: f.scope.projectId,
      turnId: queued.turn.id,
    });
    assert.equal(dispatched.state, "succeeded", dispatched.error);
    assert.equal(engineObservation.head, B);
    assert.equal(engineObservation.data, "edited by user");
    assert.equal(await git(f.repo, ["branch", "--show-current"]), "feature/story");
    assert.equal(engineObservation.native, "retained-native-session");
    const projection = await preview.read(f.scope);
    assert.equal(projection.state, "ready");

    // Suspend/restore must invalidate the old executor before admitting a native writer.
    for (const pauseAt of ["git-response", "claim-response"]) {
      const suspended = await fixture(`suspend-restore-${pauseAt}`);
      const suspendedNative = join(suspended.ws.volumeRef, ".facility/codex/native-session");
      await writeFile(suspendedNative, "retained-native-session");
      await writeFile(join(suspended.repo, "retained-data.txt"), "retained application data");
      const targetHead = await suspended.advance();
      const suspensionDomain = createStoryDomain({
        db,
        config,
        runtime: suspended.runtime,
        enqueue: async () => undefined,
        githubFactory: async () => {
          throw new Error("No live provider may be called");
        },
      });
      const suspendedPreview = suspensionDomain.previewConvergence;
      await suspendedPreview.observe(suspended.scope);
      const oldGitEntered = barrier(),
        releaseOldGit = barrier();
      const originalClaim = suspendedPreview.claim.bind(suspendedPreview);
      let holdClaim = pauseAt === "claim-response";
      suspendedPreview.claim = async (...args) => {
        const claim = await originalClaim(...args);
        if (holdClaim && claim.claimed) {
          holdClaim = false;
          oldGitEntered.resolve();
          await releaseOldGit.promise;
        }
        return claim;
      };
      const originalExec = suspended.runtime.exec.bind(suspended.runtime);
      let holdOldGit = pauseAt === "git-response";
      suspended.runtime.exec = async (ws, command) => {
        const result = await originalExec(ws, command);
        if (
          holdOldGit &&
          command.command === "git" &&
          command.args?.join(" ") === "rev-parse --git-dir"
        ) {
          holdOldGit = false;
          oldGitEntered.resolve();
          await releaseOldGit.promise;
        }
        return result;
      };
      const suspendedExecutor = new StoryPreviewConvergenceExecutor(
        db,
        suspended.runtime,
        suspended.broker,
        suspended.manifests,
        suspended.environment,
        suspendedPreview,
      );
      const suspendedRun = suspendedExecutor.dispatch(suspended.scope);
      const nativeEntered = barrier(),
        releaseNative = barrier();
      let successorRun;
      try {
        await oldGitEntered.promise;
        const suspendedService = suspensionDomain.stories;
        const oldCompute = (await suspended.runtime.inspect(suspended.ws)).computeRef;
        await suspendedService.suspend(
          suspended.scope.orgId,
          suspended.scope.projectId,
          suspended.scope.storyId,
        );
        await suspendedService.restore(
          suspended.scope.orgId,
          suspended.scope.projectId,
          suspended.scope.storyId,
        );
        let firstHead, secondHead;
        const successorEngine = {
          name: "codex",
          run: async () => {
            firstHead = await git(suspended.repo, ["rev-parse", "HEAD"]);
            nativeEntered.resolve();
            await releaseNative.promise;
            secondHead = await git(suspended.repo, ["rev-parse", "HEAD"]);
            return {
              nativeSessionId: "retained-native-session",
              output: "Continued safely.",
              progress: [],
              events: [],
              exitCode: 0,
              stderr: "",
              durationMs: 1,
            };
          },
        };
        const successorDispatcher = new TurnDispatcher(
          db,
          suspendedService,
          {},
          suspended.broker,
          suspended.manifests,
          suspended.environment,
          new AgentEngineRegistry([successorEngine]),
          new TurnGitEvidenceService(db, suspended.runtime),
          undefined,
          suspended.runtime,
        );
        const successor = await suspendedService.queueMessage({
          ...suspended.scope,
          body: "Continue after restoring the preview.",
          dedupeKey: randomUUID(),
          agent,
          actor,
          trigger: { type: "manual" },
        });
        assert.ok(successor.turn);
        successorRun = successorDispatcher.dispatch({
          ...suspended.scope,
          turnId: successor.turn.id,
        });
        await nativeEntered.promise;
        const successorWake = suspended.runtime.wake.bind(suspended.runtime);
        let staleWakeCalls = 0;
        suspended.runtime.wake = async (...args) => {
          staleWakeCalls += 1;
          return successorWake(...args);
        };
        releaseOldGit.resolve();
        const staleResult = await suspendedRun;
        assert.equal(staleWakeCalls, 0, "a revoked preview must not wake its successor's compute");
        assert.equal(firstHead, suspended.A);
        assert.equal(
          await git(suspended.repo, ["rev-parse", "HEAD"]),
          suspended.A,
          "a superseded preview must not change Git during its successor's active engine",
        );
        assert.notEqual((await suspended.runtime.inspect(suspended.ws)).computeRef, oldCompute);
        assert.notEqual(staleResult.state, "ready");
        assert.equal((await suspendedPreview.read(suspended.scope)).state, "pending");
        releaseNative.resolve();
        assert.equal((await successorRun).state, "succeeded");
        assert.equal(secondHead, suspended.A);
        assert.equal(await readFile(suspendedNative, "utf8"), "retained-native-session");
        assert.equal(
          await readFile(join(suspended.repo, "retained-data.txt"), "utf8"),
          "retained application data",
        );
        assert.equal((await suspendedExecutor.dispatch(suspended.scope)).state, "ready");
        assert.equal(await git(suspended.repo, ["rev-parse", "HEAD"]), targetHead);
      } finally {
        releaseOldGit.resolve();
        releaseNative.resolve();
        await Promise.allSettled([suspendedRun, successorRun]);
      }
    }

    // Full executor/controller/DB race: delay only the old stop provider call.
    const firstStop = barrier(),
      releaseFirstStop = barrier(),
      oldStart = barrier(),
      newStart = barrier();
    let stopCalls = 0,
      startCalls = 0,
      pendingStart;
    class BarrierRuntime extends FakeWorkspaceRuntime {
      async exec(ws, cmd) {
        if (cmd.command === "sh" && cmd.args?.[1] === "fixture-block-start") {
          await this.wake(ws);
          const call = ++startCalls;
          const entered = call === 1 ? oldStart : newStart;
          entered.resolve();
          return new Promise((resolve, reject) => {
            const abort = () => {
              pendingStart = undefined;
              reject(
                Object.assign(new Error("command canceled"), {
                  code: "workspace_command_canceled",
                }),
              );
            };
            cmd.signal?.addEventListener("abort", abort, { once: true });
            pendingStart = { resolve, reject, call };
          });
        }
        return super.exec(ws, cmd);
      }
      async suspend(ws) {
        const call = ++stopCalls;
        if (call === 1) {
          firstStop.resolve();
          await releaseFirstStop.promise;
        }
        await super.suspend(ws);
        if ((await this.inspect(ws)).state === "sleeping" && pendingStart) {
          const active = pendingStart;
          pendingStart = undefined;
          active.reject(
            Object.assign(new Error("compute suspended by provider"), {
              code: "workspace_not_running",
            }),
          );
        }
      }
    }
    const g = await fixture("delayed-old-stop", BarrierRuntime, true);
    const convergence = new StoryPreviewConvergenceService(db, async () => undefined, 1500);
    await convergence.observe(g.scope);
    const raceExecutor = new StoryPreviewConvergenceExecutor(
      db,
      g.runtime,
      g.broker,
      g.manifests,
      g.environment,
      convergence,
    );
    const oldRun = raceExecutor.dispatch(g.scope);
    await oldStart.promise;
    await g.advance();
    await convergence.observe(g.scope);
    await firstStop.promise;
    const [oldOwner] = await db
      .select()
      .from(storyPreviewConvergences)
      .where(eq(storyPreviewConvergences.storyId, g.scope.storyId));
    assert.ok(oldOwner.leaseToken);
    await delay(Math.max(0, oldOwner.leaseExpiresAt.getTime() - Date.now() + 20));
    const retire = g.runtime.retireCompute.bind(g.runtime);
    g.runtime.retireCompute = async () => {
      throw new Error("synthetic provider unavailable");
    };
    const fenced = await raceExecutor.dispatch(g.scope);
    assert.equal(fenced.code, "preview_compute_stop_unconfirmed");
    const [retainedWriter] = await db
      .select()
      .from(storyPreviewConvergences)
      .where(eq(storyPreviewConvergences.storyId, g.scope.storyId));
    assert.equal(retainedWriter.state, "applying");
    await delay(Math.max(0, retainedWriter.leaseExpiresAt.getTime() - Date.now() + 20));
    g.runtime.retireCompute = retire;
    const recovered = await raceExecutor.dispatch(g.scope);
    assert.equal(recovered.state, "recovered");
    const newRun = raceExecutor.dispatch(g.scope);
    await newStart.promise;
    const replacement = (await g.runtime.inspect(g.ws)).computeRef;
    const [newOwner] = await db
      .select()
      .from(storyPreviewConvergences)
      .where(eq(storyPreviewConvergences.storyId, g.scope.storyId));
    assert.notEqual(newOwner.leaseToken, oldOwner.leaseToken);
    releaseFirstStop.resolve();
    const oldResult = await oldRun;
    assert.equal((await g.runtime.inspect(g.ws)).state, "running");
    assert.equal((await g.runtime.inspect(g.ws)).computeRef, replacement);
    pendingStart.resolve({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    pendingStart = undefined;
    const newResult = await newRun;
    const after = await convergence.read(g.scope);
    assert.equal(oldResult.state, "superseded");
    assert.equal(newResult.state, "ready");
    console.log(
      JSON.stringify({
        test: "delayed old provider stop after replacement recovery/new writer",
        stopCalls,
        startCalls,
        oldResult,
        newResult,
        controllerState: after.state,
        computeState: (await g.runtime.inspect(g.ws)).state,
        result: "late old stop leaves replacement compute running",
      }),
    );

    // Actual MCP memory transport -> real authenticated API route -> captured worker queue.
    const h = await fixture("mcp-contract");
    const key = await generateApiKey("fak");
    await db.insert(apiKeys).values({
      id: key.id,
      orgId: h.scope.orgId,
      name: "synthetic review",
      prefix: key.lookup,
      last4: key.last4,
      hash: key.hash,
      scopeType: "project",
      projectId: h.scope.projectId,
      roleId: "role_review_pr498",
    });
    const jobs = [];
    const domain = createStoryDomain({
      db,
      config,
      runtime: h.runtime,
      enqueue: async (queue, data) => {
        jobs.push({ queue, data });
      },
      githubFactory: async () => {
        throw Error("No live provider may be called");
      },
    });
    const app = await buildApp(config, { storyDomain: domain });
    await app.ready();
    class MemoryTransport {
      peer;
      onmessage;
      onclose;
      onerror;
      async start() {}
      async send(message) {
        queueMicrotask(() => this.peer?.onmessage?.(message));
      }
      async close() {
        this.onclose?.();
      }
    }
    const ct = new MemoryTransport(),
      st = new MemoryTransport();
    ct.peer = st;
    st.peer = ct;
    const server = createFacilityMcpServer({
      apiUrl: "http://facility.test",
      apiKey: key.secret,
      client: {
        request: async (method, path, options) => {
          const res = await app.inject({
            method,
            url: path,
            headers: {
              authorization: `Bearer ${key.secret}`,
              ...(options?.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
            },
            payload: options?.body,
          });
          assert.equal(res.statusCode, 200, res.body);
          return res.json();
        },
      },
    });
    const mcp = new Client({ name: "review", version: "1" });
    await server.connect(st);
    await mcp.connect(ct);
    try {
      const tools = await mcp.listTools();
      const tool = tools.tools.find((t) => t.name === "facility_set_delivery");
      assert.match(tool.description, /rebuild/i);
      assert.equal(tool.annotations.openWorldHint, true);
      const result = await mcp.callTool({
        name: "facility_set_delivery",
        arguments: {
          projectId: h.scope.projectId,
          storyId: h.scope.storyId,
          expectedRevision: 1,
          declaredComplete: true,
          pullRequests: [
            {
              repository: `acme/${h.credentials.repositories[0].name}`,
              number: 7,
              required: true,
              primary: true,
            },
          ],
          idempotencyKey: randomUUID(),
        },
      });
      assert.notEqual(result.isError, true);
      assert.ok(jobs.some((j) => j.queue === "stories.preview-convergence"));
      console.log(
        JSON.stringify({
          test: "actual MCP delivery save by execution-capable actor",
          metadataOnlyDescription: tool.description,
          openWorldHint: tool.annotations.openWorldHint,
          enqueued: jobs.map((j) => j.queue),
          result: "delivery save discloses executable convergence",
        }),
      );
    } finally {
      await mcp.close();
      await server.close();
      await app.close();
    }
  } finally {
    await client.end();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
