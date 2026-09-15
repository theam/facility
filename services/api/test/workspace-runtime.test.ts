import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type { CreateWorkspace, WorkspaceLocator } from "../src/workspaces/runtime.js";
import {
  exportWorkspaceBackup,
  previewGatewayPorts,
  restoreWorkspaceBackup,
  validateWorkspacePorts,
  WorkspaceRuntimeError,
} from "../src/workspaces/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "facility-workspace-runtime-"));
  roots.push(root);
  const runtime = new FakeWorkspaceRuntime(root);
  const input: CreateWorkspace = {
    id: "ws_0123456789abcdef",
    image: "facility-workspace:test",
    ports: [{ service: "app", port: 3_000, websocket: true }],
  };
  const created = await runtime.create(input);
  return { runtime, created, workspace: created as WorkspaceLocator };
}

describe("WorkspaceRuntime", () => {
  it("preserves worktree and native engine state across suspend and compute replacement", async () => {
    const { runtime, workspace, created } = await fixture();
    const write = await runtime.exec(workspace, {
      command: "sh",
      args: [
        "-lc",
        'mkdir -p repo "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" && printf change > repo/uncommitted.txt && printf claude-session > "$CLAUDE_CONFIG_DIR/session" && printf codex-session > "$CODEX_HOME/session"',
      ],
    });
    expect(write.exitCode).toBe(0);

    await runtime.suspend(workspace);
    expect(await runtime.inspect(workspace)).toMatchObject({ state: "sleeping" });
    await runtime.replaceCompute(workspace);
    const resumed = await runtime.wake(workspace);

    expect(resumed.computeRef).not.toBe(created.computeRef);
    await expect(readFile(join(workspace.volumeRef, "repo/uncommitted.txt"), "utf8")).resolves.toBe(
      "change",
    );
    await expect(
      readFile(join(workspace.volumeRef, ".facility/claude/session"), "utf8"),
    ).resolves.toBe("claude-session");
    await expect(
      readFile(join(workspace.volumeRef, ".facility/codex/session"), "utf8"),
    ).resolves.toBe("codex-session");
    await expect(runtime.expose(workspace, workspace.ports ?? [])).resolves.toEqual([
      {
        service: "app",
        port: 3_000,
        websocket: true,
        url: "http://127.0.0.1:3000",
      },
    ]);
  });

  it("makes deletion explicit and idempotent", async () => {
    const { runtime, workspace } = await fixture();
    await runtime.suspend(workspace);
    await stat(workspace.volumeRef);

    await runtime.destroy(workspace);
    await runtime.destroy(workspace);

    await expect(stat(workspace.volumeRef)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "destroyed" });
    await expect(runtime.wake(workspace)).rejects.toMatchObject({ code: "workspace_destroyed" });
  });

  it("restores untracked work and native sessions into a fresh workspace", async () => {
    const { runtime, workspace } = await fixture();
    await runtime.exec(workspace, {
      command: "sh",
      args: [
        "-lc",
        "mkdir -p repo .facility/claude .facility/codex && printf untracked > repo/local.txt && printf claude > .facility/claude/session && printf codex > .facility/codex/session",
      ],
    });
    const backup = await exportWorkspaceBackup(runtime, workspace);
    const restored = await restoreWorkspaceBackup(
      runtime,
      { id: "ws_fedcba9876543210", image: workspace.image },
      backup,
    );

    expect(await runtime.read(restored, "repo/local.txt")).toBe("untracked");
    expect(await runtime.read(restored, ".facility/claude/session")).toBe("claude");
    expect(await runtime.read(restored, ".facility/codex/session")).toBe("codex");
    await runtime.destroy(workspace);
    await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "destroyed" });
    expect(await runtime.read(restored, "repo/local.txt")).toBe("untracked");
    await runtime.destroy(restored);
  });

  it("cancels only the command and preserves workspace state", async () => {
    const { runtime, workspace } = await fixture();
    const controller = new AbortController();
    const running = runtime.exec(workspace, {
      command: "sh",
      args: ["-lc", "printf before > cancellation-marker && sleep 30"],
      signal: controller.signal,
    });
    await waitFor(async () => {
      try {
        return (await runtime.read(workspace, "cancellation-marker")) === "before";
      } catch {
        return false;
      }
    });
    controller.abort();

    await expect(running).rejects.toMatchObject({ code: "workspace_command_canceled" });
    await expect(runtime.inspect(workspace)).resolves.toMatchObject({ state: "running" });
    expect(await runtime.read(workspace, "cancellation-marker")).toBe("before");
  });

  it("rejects path escapes and malformed or ambiguous exposed ports", async () => {
    const { runtime, workspace } = await fixture();
    await expect(
      runtime.exec(workspace, { command: "pwd", cwd: "../outside" }),
    ).rejects.toBeInstanceOf(WorkspaceRuntimeError);
    expect(() =>
      validateWorkspacePorts([
        { service: "app", port: 3_000 },
        { service: "admin", port: 3_000 },
      ]),
    ).toThrow(/unique/);
    expect(() => validateWorkspacePorts([{ service: "../app", port: 3_000 }])).toThrow(
      /invalid workspace service/,
    );
    expect(
      previewGatewayPorts([
        { service: "app", port: 32_768 },
        { service: "admin", port: 65_535 },
      ]),
    ).toEqual([
      { port: { service: "app", port: 32_768 }, gatewayPort: 65_534 },
      { port: { service: "admin", port: 65_535 }, gatewayPort: 65_533 },
    ]);
  });
});

async function waitFor(predicate: () => Promise<boolean>) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met before timeout");
}
