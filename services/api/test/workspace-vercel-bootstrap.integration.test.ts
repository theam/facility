import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Sandbox, SandboxUser } from "@vercel/sandbox";
import { afterEach, expect, it, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({ getOrCreate: vi.fn() }));
vi.mock("@vercel/sandbox", async (original) => ({
  ...(await original<typeof import("@vercel/sandbox")>()),
  Sandbox: sandboxApi,
}));

import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function localProvider(brokenGateway: boolean) {
  const root = await mkdtemp(join(tmpdir(), "facility-vercel-bootstrap-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const server = createServer((_req, res) => res.end("preview app"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server missing port");
  // Reserve a separate local port for the provider's mapped gateway port.
  const reserve = createServer();
  await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
  const reserved = reserve.address();
  if (!reserved || typeof reserved === "string") throw new Error("test gateway missing port");
  const gatewayPort = reserved.port;
  await new Promise<void>((resolve) => reserve.close(() => resolve()));
  const scripts: Record<string, string> = {
    docker: "exit 0",
    chown: "exit 0",
    chmod: "exit 0",
    // Model the provider's environment reset; the real SDK must inject env after this transition.
    sudo: 'test "$1" = -u; shift 3; exec /usr/bin/env -i PATH="$PATH" "$@"',
    runuser: 'test "$1" = --user; shift 4; exec "$@"',
    // Ignore host login profiles while executing the unchanged bootstrap in its temporary root.
    sh: 'if test "$1" = -lc; then shift; exec /bin/sh -c "$@"; fi; exec /bin/sh "$@"',
    "facility-preview-gateway": brokenGateway
      ? "exit 2"
      : `test -z "$UNRELATED_SECRET" || exit 7\nexec '${process.execPath}' '${fileURLToPath(new URL("../../../runner/facility-preview-gateway.mjs", import.meta.url))}' "$@"`,
  };
  for (const [name, script] of Object.entries(scripts))
    await writeFile(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const fixture = {
    name: "ws_0123456789abcdef",
    status: "running",
    currentSnapshotId: "snapshot",
    currentSession: () => ({ sessionId: "compute" }),
    domain: () => `http://127.0.0.1:${gatewayPort}`,
    stop: vi.fn(async () => {
      fixture.status = "stopped";
    }),
    asUser: (username: string): SandboxUser =>
      new SandboxUser({ sandbox: fixture as unknown as Sandbox, username }),
    runCommand: async (params: {
      cmd: string;
      args?: string[];
      env?: Record<string, string>;
      sudo?: boolean;
    }) => {
      const args = (params.args ?? []).map((arg) =>
        arg.replaceAll("/workspace", root).replaceAll("65535", String(gatewayPort)),
      );
      return new Promise<{ exitCode: number; stderr: () => Promise<string> }>((resolve, reject) => {
        const child = spawn(params.cmd, args, {
          env: { PATH: `${bin}:${process.env.PATH}`, ...(params.sudo ? {} : params.env) },
        });
        let stderr = "";
        child.stderr.on("data", (data) => {
          stderr += data;
        });
        child.stdout.resume();
        child.on("error", reject);
        child.on("close", (code) => resolve({ exitCode: code ?? 1, stderr: async () => stderr }));
      });
    },
  };
  cleanups.push(async () => {
    const pid = Number(
      await readFile(join(root, `.facility/preview-${gatewayPort}.pid`), "utf8").catch(() => ""),
    );
    if (pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
  });
  sandboxApi.getOrCreate.mockImplementation(async (options) => {
    await options.onCreate?.(fixture);
    return fixture;
  });
  return { fixture, gatewayPort, appPort: address.port };
}

it("starts the real authenticated gateway through the SDK user switch without exposing a bare app", async () => {
  const { gatewayPort, appPort, fixture } = await localProvider(false);
  const token = 'credential-with-$()-and-quote-"-characters';
  await new VercelWorkspaceRuntime().create({
    id: fixture.name,
    image: "runner:test",
    ports: [{ service: "web", port: appPort }],
    environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: token, UNRELATED_SECRET: "must-not-forward" },
  });
  const url = `http://127.0.0.1:${gatewayPort}/`;
  for (const value of [undefined, "malformed", "another-workspace-credential-0000000000"]) {
    expect(
      (await fetch(url, { headers: value ? { "x-facility-preview-token": value } : {} })).status,
    ).toBe(401);
  }
  const response = await fetch(url, { headers: { "x-facility-preview-token": token } });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("preview app");
  expect(fixture.stop).not.toHaveBeenCalled();
});

it("fails initialization and stops newly allocated compute when the background gateway exits", async () => {
  const { appPort, fixture } = await localProvider(true);
  await expect(
    new VercelWorkspaceRuntime().create({
      id: fixture.name,
      image: "runner:test",
      ports: [{ service: "web", port: appPort }],
      environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
    }),
  ).rejects.toMatchObject({
    code: "workspace_initialize_failed",
    message: expect.stringContaining("did not start"),
  });
  expect(fixture.stop).toHaveBeenCalledOnce();
});
