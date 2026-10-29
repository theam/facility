import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newId } from "@facility/core";
import { engineSessions, storyMessages, turns, workspaces } from "@facility/db";
import Docker from "dockerode";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceCredentialRenewal } from "../src/github/workspace-credential-renewal.js";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";
import { PreviewWorkspaceGitApplicator } from "../src/stories/preview-convergence-executor.js";
import { createStoryDomain } from "../src/story-domain.js";
import { ENGINE_PROCESS_WRAPPER, stopInterruptedEngineProcess } from "../src/turns/engines.js";
import { ENGINE_USAGE_PROCESS, readUsageJournal } from "../src/turns/usage-journal.js";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import {
  exportWorkspaceBackup,
  restoreWorkspaceBackup,
  type WorkspaceLocator,
} from "../src/workspaces/runtime.js";
import { consultationDatabaseUrl, consultationTestEnvironment } from "./fixtures/consultations.js";

const enabled = process.env.FACILITY_E2E_DOCKER === "1";

describe.skipIf(!enabled)("DockerWorkspaceRuntime integration", () => {
  it("renews Git and gh credentials in an existing runner without replacing its volume", async () => {
    const runtime = new DockerWorkspaceRuntime(new Docker());
    const workspace = await runtime.create({
      id: `ws_${randomBytes(12).toString("hex")}`,
      image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:serialized",
    });
    let authorized = true;
    const credentials = (token: string): GithubWorkspaceCredentials => ({
      repositories: [{ owner: "acme", name: "app", defaultBranch: "main", role: "primary" }],
      environment: {
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
        FACILITY_GITHUB_CREDENTIALS: JSON.stringify({ "acme/app": token }),
      },
      expiresAt: new Date(Date.now() + 3_600_000),
      gitIdentity: { name: "Fixture", email: "fixture@example.test" },
    });
    const renewal = new WorkspaceCredentialRenewal(
      runtime,
      { ...workspace, expectedComputeRef: workspace.computeRef },
      "turn_dockercredentials",
      credentials("synthetic-before"),
      {
        issue: async () => credentials("synthetic-after"),
        authorized: async () => authorized,
        rememberSecrets: () => undefined,
        report: async () => undefined,
        revoked: () => undefined,
      },
    );
    try {
      const environment = renewal.environment(await renewal.start(), true);
      const git = () =>
        runtime.exec(workspace, {
          command: "git",
          args: ["credential", "fill"],
          stdin: "protocol=https\nhost=github.com\npath=acme/app.git\n\n",
          env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
        });
      const gh = () =>
        runtime.exec(workspace, {
          command: "sh",
          args: ["-lc", "gh auth token"],
          env: {
            ...environment,
            HTTPS_PROXY: "http://127.0.0.1:9",
            HTTP_PROXY: "http://127.0.0.1:9",
            NO_PROXY: "",
          },
        });
      expect((await git()).stdout).toContain("password=synthetic-before");
      expect((await gh()).stdout.trim()).toBe("synthetic-before");
      const expired = await runtime.exec(workspace, {
        command: "node",
        args: [
          "-e",
          "const fs=require('node:fs'),p=require('node:path').join(process.env.GH_CONFIG_DIR,'..','credentials.json'); const v=JSON.parse(fs.readFileSync(p,'utf8')); v.expiresAt=0; fs.writeFileSync(p,JSON.stringify(v));",
        ],
        env: environment,
      });
      expect(expired.exitCode).toBe(0);
      expect((await git()).exitCode).not.toBe(0);
      await renewal.renew();
      expect((await git()).stdout).toContain("password=synthetic-after");
      expect((await gh()).stdout.trim()).toBe("synthetic-after");
      expect((await runtime.inspect(workspace)).volumeRef).toBe(workspace.volumeRef);
      authorized = false;
      await renewal.renew();
      expect((await git()).exitCode).not.toBe(0);
      expect((await gh()).exitCode).not.toBe(0);
    } finally {
      await renewal.stop();
      await runtime.destroy(workspace);
    }
  });
  it("converges an exact revision without replacing the retained volume or local data", async () => {
    const runtime = new DockerWorkspaceRuntime(new Docker());
    const workspace = await runtime.create({
      id: `ws_${randomBytes(12).toString("hex")}`,
      image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:serialized",
    });
    const run = async (script: string, cwd = ".") => {
      const result = await runtime.exec(workspace, {
        command: "sh",
        args: ["-lc", script],
        cwd,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const credentials = {
      repositories: [
        { owner: "acme", name: "app", defaultBranch: "main", role: "primary" as const },
      ],
      environment: {},
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      gitIdentity: { name: "Facility Test", email: "facility@example.test" },
    };
    const target = (headSha: string) => ({
      repositoryId: "repo_app",
      repository: "acme/app",
      pullNumber: 7,
      headRef: "preview-one",
      headSha,
      primary: true,
    });
    try {
      await run(`
        mkdir -p remotes source repos/acme
        git init --bare --initial-branch=main remotes/app.git
        git clone remotes/app.git source/app
        git -C source/app config user.name 'Facility Test'
        git -C source/app config user.email facility@example.test
        printf 'base\\n' > source/app/README.md
        git -C source/app add README.md
        git -C source/app commit -m base
        git -C source/app push origin main
        git clone remotes/app.git repos/acme/app
        git -C repos/acme/app config user.name 'Facility Test'
        git -C repos/acme/app config user.email facility@example.test
        git -C source/app switch -c preview-one
        printf 'first generation\\n' > source/app/application.txt
        git -C source/app add application.txt
        git -C source/app commit -m 'first generation'
        git -C source/app push origin preview-one
        printf 'retained user data\\n' > repos/acme/app/local-data.txt
      `);
      const first = await run("git rev-parse HEAD", "source/app");
      const applicator = new PreviewWorkspaceGitApplicator(runtime);
      await applicator.apply({ workspace, credentials, repositories: [target(first)] });
      expect(await run(`git merge-base --is-ancestor ${first} HEAD`, "repos/acme/app")).toBe("");
      expect(await run("cat local-data.txt", "repos/acme/app")).toBe("retained user data");
      expect((await runtime.inspect(workspace)).volumeRef).toBe(workspace.volumeRef);

      await run(
        `
        printf 'second generation\\n' > README.md
        git add README.md
        git commit -m 'second generation'
        git push origin preview-one
      `,
        "source/app",
      );
      const second = await run("git rev-parse HEAD", "source/app");
      const beforeBlocked = await run("git rev-parse HEAD", "repos/acme/app");
      await run("printf 'local README edit\\n' > README.md", "repos/acme/app");
      await expect(
        applicator.apply({ workspace, credentials, repositories: [target(second)] }),
      ).rejects.toMatchObject({ code: "preview_dirty_overlap" });
      expect(await run("git rev-parse HEAD", "repos/acme/app")).toBe(beforeBlocked);
      expect(await run("cat README.md", "repos/acme/app")).toBe("local README edit");
      expect(await run("cat local-data.txt", "repos/acme/app")).toBe("retained user data");

      await run("git restore README.md", "repos/acme/app");
      await applicator.apply({ workspace, credentials, repositories: [target(second)] });
      expect(await run("cat README.md", "repos/acme/app")).toBe("second generation");
      expect(await run("cat local-data.txt", "repos/acme/app")).toBe("retained user data");
      expect((await runtime.inspect(workspace)).volumeRef).toBe(workspace.volumeRef);
      const oldTarget = { ...workspace, expectedComputeRef: workspace.computeRef };
      await runtime.retireCompute(oldTarget);
      const replacement = await runtime.wake(workspace);
      expect(replacement.computeRef).not.toBe(oldTarget.expectedComputeRef);
      await runtime.suspend(oldTarget);
      expect((await runtime.inspect(workspace)).state).toBe("running");
      await expect(runtime.exec(oldTarget, { command: "true" })).rejects.toMatchObject({
        code: "workspace_not_running",
      });
      expect(await run("cat local-data.txt", "repos/acme/app")).toBe("retained user data");
    } finally {
      await runtime.destroy(workspace);
    }
  }, 180_000);

  it("consults through the production domain without touching running or sleeping workspace state", async () => {
    const env = await consultationTestEnvironment();
    const runtime = new DockerWorkspaceRuntime(new Docker());
    const workspace = await runtime.create({
      id: newId("ws"),
      image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:serialized",
    });
    try {
      const f = await env.fixture();
      const written = await runtime.exec(workspace, {
        command: "node",
        args: [
          "-e",
          `
          const fs = require('node:fs'), path = require('node:path');
          const files = { 'repo/dirty-change': 'uncommitted change', 'data/seed.json': '{"count":7}' };
          files[path.join(process.env.CLAUDE_CONFIG_DIR, 'session')] = 'synthetic-native-session';
          files[path.join(process.env.CODEX_HOME, 'auth.json')] = 'synthetic-native-credential';
          for (const [file, value] of Object.entries(files)) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, value); }
        `,
        ],
      });
      expect(written.exitCode, written.stderr).toBe(0);
      const readRetained = () =>
        runtime.exec(workspace, {
          command: "node",
          args: [
            "-e",
            `
          const fs = require('node:fs'), path = require('node:path');
          console.log(JSON.stringify(['repo/dirty-change','data/seed.json',path.join(process.env.CLAUDE_CONFIG_DIR,'session'),path.join(process.env.CODEX_HOME,'auth.json')].map(file => fs.readFileSync(file,'utf8'))));
        `,
          ],
        });
      const beforeFiles = await readRetained();
      expect(beforeFiles.exitCode, beforeFiles.stderr).toBe(0);
      await env.db.insert(workspaces).values({
        id: workspace.id,
        ...f.scope,
        provider: "docker",
        externalRef: workspace.externalRef,
        volumeRef: workspace.volumeRef,
        state: "running",
        setupChecksum: "retained-setup",
      });
      const sessionId = newId("esess");
      await env.db.insert(engineSessions).values({
        id: sessionId,
        ...f.scope,
        workspaceId: workspace.id,
        agentName: "reviewer",
        engine: "codex",
        model: "gpt-5.5",
        nativeSessionId: "synthetic-native-session",
        statePath: ".codex",
        lastTurnId: f.previousTurnId,
      });
      const enqueue = vi.fn(async (_queue: string, _data: Record<string, unknown>) => "test-job");
      const domain = createStoryDomain({
        db: env.db,
        runtime,
        enqueue,
        githubFactory: async () => f.octokit,
        config: {
          databaseUrl: consultationDatabaseUrl,
          secretMasterKey: Buffer.alloc(32, 53).toString("base64"),
          port: 3401,
          publicUrl: "http://127.0.0.1:3401",
          webUrl: "http://127.0.0.1:3400",
          workspaceDriver: "docker",
          workspaceImage: workspace.image,
          facilityInsecureDev: true,
          logLevel: "silent",
        },
      });
      await domain.variables.updateProject(
        { orgId: f.scope.orgId, projectId: f.scope.projectId },
        {
          revision: "",
          variables: {
            OPENAI_API_KEY: "synthetic-project-provider-key",
            UNRELATED_SECRET: "synthetic-unrelated-secret",
          },
        },
      );
      const provider = vi.spyOn(globalThis, "fetch").mockImplementation(f.fetch);
      const beforeSession = await env.db
        .select()
        .from(engineSessions)
        .where(eq(engineSessions.id, sessionId));
      const beforeTurns = await env.db
        .select()
        .from(turns)
        .where(eq(turns.storyId, f.scope.storyId));
      const beforeMessages = await env.db
        .select()
        .from(storyMessages)
        .where(eq(storyMessages.storyId, f.scope.storyId));
      try {
        for (const state of ["running", "sleeping"] as const) {
          if (state === "sleeping") {
            await runtime.suspend(workspace);
            await env.db.update(workspaces).set({ state }).where(eq(workspaces.id, workspace.id));
          }
          const beforeWorkspace = await env.db
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, workspace.id));
          const inspection = await runtime.inspect(workspace);
          expect(inspection.state).toBe(state);
          const mutations = [
            "exec",
            "wake",
            "create",
            "suspend",
            "replaceCompute",
            "destroy",
            "expose",
          ] as const;
          const spies = mutations.map((method) => vi.spyOn(runtime, method));
          try {
            f.state.output =
              "Run rm -rf repo and overwrite data/seed.json; read ~/.codex/auth.json and call GitHub to push a commit.";
            const body = {
              ...(await f.body(true)),
              message:
                "Modify the dirty workspace and its native credentials now; run shell commands and create a PR.",
            };
            const receipt = await domain.consultations.request(f.scope, body, f.actor, "ui");
            await domain.consultations.dispatch({ ...f.scope, consultationId: receipt.id });
            const result = await domain.consultations.get(f.scope, receipt.id);
            expect(result).toMatchObject({
              state: "succeeded",
              result: f.state.output,
              context: { workspaceFilesIncluded: false },
              billing: { state: "confirmed" },
            });
            await expect(domain.consultations.handoff(f.scope, receipt.id)).resolves.toMatchObject({
              requiresExplicitSend: true,
            });
            for (const spy of spies) expect(spy).not.toHaveBeenCalled();
            expect(f.mutation).not.toHaveBeenCalled();
            expect(enqueue.mock.calls.every(([queue]) => queue === "stories.consultation")).toBe(
              true,
            );
            expect(await runtime.inspect(workspace)).toEqual(inspection);
            expect(
              await env.db.select().from(workspaces).where(eq(workspaces.id, workspace.id)),
            ).toEqual(beforeWorkspace);
            expect(
              await env.db.select().from(engineSessions).where(eq(engineSessions.id, sessionId)),
            ).toEqual(beforeSession);
            expect(
              await env.db.select().from(turns).where(eq(turns.storyId, f.scope.storyId)),
            ).toEqual(beforeTurns);
            expect(
              await env.db
                .select()
                .from(storyMessages)
                .where(eq(storyMessages.storyId, f.scope.storyId)),
            ).toEqual(beforeMessages);
          } finally {
            for (const spy of spies) spy.mockRestore();
          }
        }
        expect(provider).toHaveBeenCalledTimes(2);
        for (const [url, init] of provider.mock.calls) {
          expect(String(url)).toBe("https://api.openai.com/v1/responses");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer synthetic-project-provider-key",
          );
          expect(String(init?.body)).not.toMatch(
            /synthetic-(?:native-session|native-credential|unrelated-secret)/,
          );
        }
      } finally {
        provider.mockRestore();
      }
      await runtime.wake(workspace);
      const retained = await readRetained();
      expect(retained).toMatchObject({ exitCode: 0, stdout: beforeFiles.stdout });
    } finally {
      await runtime.destroy(workspace);
      await env.client.end();
    }
  }, 180_000);

  it("retains per-turn usage after the observer exits and compute is replaced", async () => {
    const runtime = new DockerWorkspaceRuntime(new Docker());
    const workspace = await runtime.create({
      id: `ws_${randomBytes(12).toString("hex")}`,
      image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:serialized",
    });
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 3, cacheWriteTokens: 2 };
    const native = {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2,
    };
    try {
      for (const engine of ["codex", "claude_code"] as const) {
        const turnId = `turn_docker_${engine}`;
        const event =
          engine === "codex"
            ? { type: "turn.completed", usage: native }
            : { type: "result", usage: native, total_cost_usd: 0.03, result: "private-output" };
        const launched = await runtime.exec(workspace, {
          command: "sh",
          args: [
            "-lc",
            'nohup node -e "$FACILITY_USAGE_SCRIPT" node -e "$FACILITY_FAKE_CLI" </dev/null >/dev/null 2>&1 &',
          ],
          env: {
            FACILITY_TURN_ID: turnId,
            FACILITY_ENGINE: engine,
            FACILITY_USAGE_SCRIPT: ENGINE_USAGE_PROCESS,
            FACILITY_FAKE_CLI: `setTimeout(() => console.log(JSON.stringify(${JSON.stringify(event)})), 100);`,
          },
        });
        expect(launched.exitCode, launched.stderr).toBe(0);
        await waitUntil(
          async () => (await readUsageJournal(runtime, workspace, turnId, engine)).complete,
        );
        expect(await readUsageJournal(runtime, workspace, turnId, engine)).toEqual({
          complete: true,
          usage: engine === "codex" ? usage : { ...usage, reportedCostCents: 3 },
        });
        const contents = await runtime.exec(workspace, {
          command: "sh",
          args: ["-lc", 'cat "$(dirname "$HOME")/engine-usage/$FACILITY_TURN_ID.json"'],
          env: { FACILITY_TURN_ID: turnId },
        });
        expect(contents.stdout).not.toContain("private-output");
      }
      const partial = await runtime.exec(workspace, {
        command: "node",
        args: [
          "-e",
          ENGINE_USAGE_PROCESS,
          "node",
          "-e",
          `console.log(JSON.stringify({type:'assistant',message:{id:'msg-partial',usage:${JSON.stringify(native)}}}))`,
        ],
        env: { FACILITY_TURN_ID: "turn_docker_partial", FACILITY_ENGINE: "claude_code" },
      });
      expect(partial.exitCode, partial.stderr).toBe(0);
      expect(
        await readUsageJournal(runtime, workspace, "turn_docker_partial", "claude_code"),
      ).toEqual({ complete: false, usage });
      await runtime.replaceCompute(workspace);
      expect(await readUsageJournal(runtime, workspace, "turn_docker_codex", "codex")).toEqual({
        complete: false,
      });
      await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "sleeping" });
      await runtime.wake(workspace);
      expect(await readUsageJournal(runtime, workspace, "turn_docker_codex", "codex")).toEqual({
        complete: true,
        usage,
      });
    } finally {
      await runtime.destroy(workspace);
    }
  }, 180_000);

  it("reattaches the same named volume after its compute is removed", async () => {
    const id = `ws_${randomBytes(12).toString("hex")}`;
    const gatewayToken = randomBytes(32).toString("base64url");
    const runtime = new DockerWorkspaceRuntime(new Docker());
    const createStartedAt = performance.now();
    const created = await runtime.create({
      id,
      image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:serialized",
      environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: gatewayToken },
      ports: [{ service: "web", port: 3210, protocol: "http", websocket: true }],
    });
    const createDurationMs = Math.round(performance.now() - createStartedAt);
    const workspace = created as WorkspaceLocator;
    try {
      const bootstrap = await runtime.exec(workspace, {
        command: "sh",
        args: ["-lc", "printf '%s|' \"$(id -un)\"; docker info --format '{{.Driver}}'"],
      });
      expect(bootstrap).toMatchObject({ exitCode: 0, stdout: "node|vfs\n" });
      const write = await runtime.exec(workspace, {
        command: "sh",
        args: [
          "-lc",
          'mkdir -p repo "$CLAUDE_CONFIG_DIR" && printf dirty > repo/change && printf native-session > "$CLAUDE_CONFIG_DIR/session"',
        ],
      });
      expect(write.exitCode, write.stderr).toBe(0);

      await installReferenceProject(runtime, workspace);
      const compose = await runtime.exec(workspace, {
        command: "sh",
        args: [
          "-lc",
          'cp /bin/busybox reference-project/busybox && cd reference-project && mkdir -p state && printf \'{"people":[{"name":"Ada Lovelace"}]}\' > state/seed.json && docker compose up -d --build',
        ],
        timeoutMs: 120_000,
      });
      expect(compose.exitCode, compose.stderr).toBe(0);
      const endpoint = (await runtime.expose(workspace, workspace.ports))[0];
      if (!endpoint) throw new Error("expected a Docker Compose preview endpoint");
      await expect(fetch(endpoint.url)).resolves.toMatchObject({ status: 401 });
      const preview = await fetch(`${endpoint.url}/cgi-bin/items`, {
        headers: { "x-facility-preview-token": gatewayToken },
      });
      expect(preview.status).toBe(200);
      await expect(preview.text()).resolves.toContain("Ada Lovelace");
      const browser = await runtime.exec(workspace, {
        command: "sh",
        args: [
          "-lc",
          "mkdir -p .facility/artifacts && chromium --headless --no-sandbox --disable-gpu --screenshot=.facility/artifacts/reference.png --trace-startup --trace-startup-duration=1 --trace-startup-file=.facility/artifacts/browser-trace.json --virtual-time-budget=10000 --dump-dom http://127.0.0.1:3210 > .facility/artifacts/dom.html && { grep -q 'Ada Lovelace' .facility/artifacts/dom.html && test -s .facility/artifacts/reference.png && test -s .facility/artifacts/browser-trace.json || { ls -la .facility/artifacts; cat .facility/artifacts/dom.html; exit 1; }; }",
        ],
        cwd: "reference-project",
        timeoutMs: 120_000,
      });
      expect(browser.exitCode, `${browser.stderr}\n${browser.stdout}`).toBe(0);

      const cancellation = new AbortController();
      const longCommand = runtime.exec(workspace, {
        command: "sh",
        args: ["-lc", "printf started > reference-project/cancel-marker && sleep 30"],
        signal: cancellation.signal,
      });
      await waitUntil(async () => {
        const marker = await runtime.exec(workspace, {
          command: "test",
          args: ["-f", "reference-project/cancel-marker"],
        });
        return marker.exitCode === 0;
      });
      cancellation.abort();
      await expect(longCommand).rejects.toMatchObject({ code: "workspace_command_canceled" });
      const afterCancellation = await fetch(`${endpoint.url}/cgi-bin/items`, {
        headers: { "x-facility-preview-token": gatewayToken },
      });
      await expect(afterCancellation.text()).resolves.toContain("Ada Lovelace");

      const interruptedTurnId = "turn_docker_interrupted";
      const orphan = await runtime.exec(workspace, {
        command: "sh",
        args: [
          "-lc",
          'mkdir -p "$(dirname "$HOME")/engine-processes"; FACILITY_TURN_ID="$FACILITY_TEST_TURN_ID" sh -c \'exec sleep 30\' >/dev/null 2>&1 & printf \'%s\' "$!" > "$(dirname "$HOME")/engine-processes/$FACILITY_TEST_TURN_ID.pid"',
        ],
        env: { FACILITY_TEST_TURN_ID: interruptedTurnId },
      });
      expect(orphan.exitCode, orphan.stderr).toBe(0);
      await expect(
        stopInterruptedEngineProcess(runtime, workspace, interruptedTurnId),
      ).resolves.toBe("stopped");
      const processMarker = await runtime.exec(workspace, {
        command: "test",
        args: ["!", "-f", `.facility/engine-processes/${interruptedTurnId}.pid`],
      });
      expect(processMarker.exitCode, processMarker.stderr).toBe(0);

      const resistantTurnId = "turn_docker_resistant_native";
      const native =
        "const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync('interrupted-native-activity','x'),50);";
      const start = [
        "const {spawn}=require('node:child_process');",
        `const child=spawn('sh',['-c',${JSON.stringify(ENGINE_PROCESS_WRAPPER)},'facility-engine','node','-e',${JSON.stringify(ENGINE_USAGE_PROCESS)},'node','-e',${JSON.stringify(native)}],{env:process.env,stdio:'ignore'});`,
        "child.unref();setTimeout(()=>process.exit(0),300);",
      ].join("\n");
      const launched = await runtime.exec(workspace, {
        command: "node",
        args: ["-e", start],
        env: { FACILITY_TURN_ID: resistantTurnId, FACILITY_ENGINE: "codex" },
      });
      expect(launched.exitCode, launched.stderr).toBe(0);
      await waitUntil(
        async () =>
          (
            await runtime.exec(workspace, {
              command: "test",
              args: ["-s", "interrupted-native-activity"],
            })
          ).exitCode === 0,
      );
      await expect(stopInterruptedEngineProcess(runtime, workspace, resistantTurnId)).resolves.toBe(
        "stopped",
      );
      const activitySize = async () =>
        (
          await runtime.exec(workspace, {
            command: "node",
            args: [
              "-e",
              "process.stdout.write(String(require('node:fs').readFileSync('interrupted-native-activity').length))",
            ],
          })
        ).stdout;
      const stoppedSize = await activitySize();
      const successorWrite = await runtime.exec(workspace, {
        command: "node",
        args: ["-e", "require('node:fs').writeFileSync('successor-write','safe')"],
      });
      expect(successorWrite.exitCode, successorWrite.stderr).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await activitySize()).toBe(stoppedSize);

      await runtime.replaceCompute(workspace);
      await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "sleeping" });

      const wakeStartedAt = performance.now();
      const resumed = await runtime.wake(workspace);
      const wakeDurationMs = Math.round(performance.now() - wakeStartedAt);
      expect(resumed.computeRef).not.toBe(created.computeRef);
      const read = await runtime.exec(workspace, {
        command: "sh",
        args: ["-lc", 'printf \'%s|\' "$(cat repo/change)"; cat "$CLAUDE_CONFIG_DIR/session"'],
      });
      expect(read).toMatchObject({ exitCode: 0, stdout: "dirty|native-session" });
      const restarted = await runtime.exec(workspace, {
        command: "docker",
        args: ["compose", "up", "-d", "--build"],
        cwd: "reference-project",
        timeoutMs: 120_000,
      });
      expect(restarted.exitCode, restarted.stderr).toBe(0);
      const resumedEndpoint = (await runtime.expose(workspace, workspace.ports))[0];
      if (!resumedEndpoint) throw new Error("expected a resumed preview endpoint");
      const afterReplacement = await fetch(`${resumedEndpoint.url}/cgi-bin/items`, {
        headers: { "x-facility-preview-token": gatewayToken },
      });
      await expect(afterReplacement.text()).resolves.toContain("Ada Lovelace");

      const backup = await exportWorkspaceBackup(runtime, workspace);
      const restored = await restoreWorkspaceBackup(
        runtime,
        {
          id: `ws_${randomBytes(12).toString("hex")}`,
          image: workspace.image,
        },
        backup,
      );
      try {
        const restoredCompose = await runtime.exec(restored, {
          command: "docker",
          args: ["compose", "up", "-d", "--build"],
          cwd: "reference-project",
          timeoutMs: 120_000,
        });
        expect(restoredCompose.exitCode, restoredCompose.stderr).toBe(0);
        const restoredState = await runtime.exec(restored, {
          command: "sh",
          args: ["-lc", 'printf \'%s|\' "$(cat repo/change)"; cat "$CLAUDE_CONFIG_DIR/session"'],
        });
        expect(restoredState).toMatchObject({ exitCode: 0, stdout: "dirty|native-session" });
        const restoredSeed = await runtime.exec(restored, {
          command: "cat",
          args: ["state/seed.json"],
          cwd: "reference-project",
        });
        expect(restoredSeed.stdout).toContain("Ada Lovelace");
        console.info(
          "reference fixture measurements",
          JSON.stringify({
            create_ms: createDurationMs,
            wake_after_compute_replacement_ms: wakeDurationMs,
            compose_build_and_start_ms: compose.durationMs,
            chromium_flow_ms: browser.durationMs,
            docker_provider_cost: "not metered",
          }),
        );
      } finally {
        await runtime.destroy(restored);
      }
    } finally {
      await runtime.destroy(workspace);
    }
    await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "destroyed" });
  }, 300_000);
});

async function waitUntil(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition was not met before timeout");
}

async function installReferenceProject(
  runtime: DockerWorkspaceRuntime,
  workspace: WorkspaceLocator,
) {
  const files = [
    "compose.yaml",
    "Dockerfile.database",
    "Dockerfile.api",
    "Dockerfile.app",
    "api/items",
    "app/items",
    "app/index.html",
    ".facility.yml",
    ".agents/builder.md",
    ".agents/security-audit.md",
  ];
  for (const path of files) {
    const source = await readFile(
      new URL(`./fixtures/reference-project/${path}`, import.meta.url),
      "utf8",
    );
    const result = await runtime.exec(workspace, {
      command: "sh",
      args: [
        "-lc",
        'mkdir -p "$(dirname "$FACILITY_FIXTURE_PATH")" && printf %s "$FACILITY_FIXTURE_SOURCE" > "$FACILITY_FIXTURE_PATH"',
      ],
      cwd: ".",
      env: {
        FACILITY_FIXTURE_PATH: `reference-project/${path}`,
        FACILITY_FIXTURE_SOURCE: source,
      },
    });
    expect(result.exitCode, result.stderr).toBe(0);
  }
}
