import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import type { WorkspaceLocator } from "../src/workspaces/runtime.js";

const enabled = process.env.FACILITY_E2E_DOCKER === "1";

describe.skipIf(!enabled)("DockerWorkspaceRuntime integration", () => {
  it("reattaches the same named volume after its compute is removed", async () => {
    const id = `ws_${randomBytes(12).toString("hex")}`;
    const gatewayToken = randomBytes(32).toString("base64url");
    const runtime = new DockerWorkspaceRuntime(new Docker());
    const created = await runtime.create({
      id,
      image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:serialized",
      environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: gatewayToken },
      ports: [{ service: "web", port: 3210, protocol: "http", websocket: true }],
    });
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

      const compose = await runtime.exec(workspace, {
        command: "sh",
        args: [
          "-lc",
          "mkdir -p compose-app && cp /bin/busybox compose-app/busybox && printf compose-ok > compose-app/health && printf '%s' \"$FACILITY_TEST_COMPOSE\" > compose-app/compose.yaml && printf '%s' \"$FACILITY_TEST_DOCKERFILE\" > compose-app/Dockerfile && cd compose-app && docker compose up -d --build",
        ],
        env: {
          FACILITY_TEST_COMPOSE: [
            "services:",
            "  web:",
            "    build: .",
            "    network_mode: host",
            "",
          ].join("\n"),
          FACILITY_TEST_DOCKERFILE: [
            "FROM scratch",
            "COPY busybox /busybox",
            "COPY health /www/health",
            'ENTRYPOINT ["/busybox", "httpd", "-f", "-p", "3210", "-h", "/www"]',
            "",
          ].join("\n"),
        },
        timeoutMs: 120_000,
      });
      expect(compose.exitCode, compose.stderr).toBe(0);
      const endpoint = (await runtime.expose(workspace, workspace.ports))[0];
      if (!endpoint) throw new Error("expected a Docker Compose preview endpoint");
      await expect(fetch(endpoint.url)).resolves.toMatchObject({ status: 401 });
      const preview = await fetch(`${endpoint.url}/health`, {
        headers: { "x-facility-preview-token": gatewayToken },
      });
      expect(preview.status).toBe(200);
      await expect(preview.text()).resolves.toBe("compose-ok");

      await runtime.replaceCompute(workspace);
      await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "sleeping" });

      const resumed = await runtime.wake(workspace);
      expect(resumed.computeRef).not.toBe(created.computeRef);
      const read = await runtime.exec(workspace, {
        command: "sh",
        args: ["-lc", 'printf \'%s|\' "$(cat repo/change)"; cat "$CLAUDE_CONFIG_DIR/session"'],
      });
      expect(read).toMatchObject({ exitCode: 0, stdout: "dirty|native-session" });
    } finally {
      await runtime.destroy(workspace);
    }
    await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "destroyed" });
  }, 120_000);
});
