import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { stopInterruptedEngineProcess } from "../src/turns/engines.js";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import {
  exportWorkspaceBackup,
  restoreWorkspaceBackup,
  type WorkspaceLocator,
} from "../src/workspaces/runtime.js";

const enabled = process.env.FACILITY_E2E_DOCKER === "1";

describe.skipIf(!enabled)("DockerWorkspaceRuntime integration", () => {
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
