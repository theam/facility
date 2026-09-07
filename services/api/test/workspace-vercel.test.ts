import { beforeEach, describe, expect, it, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({
  get: vi.fn(),
  getOrCreate: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: sandboxApi,
}));

import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

function fakeSandbox() {
  return {
    name: "ws_0123456789abcdef",
    status: "running",
    currentSnapshotId: "snap_persistent",
    currentSession: () => ({ sessionId: "session_current" }),
    runCommand: vi.fn().mockResolvedValue({
      exitCode: 0,
      stderr: vi.fn().mockResolvedValue(""),
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
    domain: (port: number) => `workspace-${port}.example.test`,
  };
}

describe("Vercel persistent workspace runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a non-expiring persistent sandbox and initializes it exactly once", async () => {
    const sandbox = fakeSandbox();
    sandboxApi.getOrCreate.mockImplementation(async (options) => {
      await options.onCreate?.(sandbox);
      return sandbox;
    });
    const runtime = new VercelWorkspaceRuntime({
      token: "test-token",
      teamId: "team_test",
      projectId: "project_test",
    });

    await expect(
      runtime.create({
        id: "ws_0123456789abcdef",
        image: "facility-runner:test",
        environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
        ports: [{ service: "web", port: 3000 }],
      }),
    ).resolves.toMatchObject({
      externalRef: "ws_0123456789abcdef",
      volumeRef: "snap_persistent",
      state: "running",
    });

    expect(sandboxApi.getOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ws_0123456789abcdef",
        persistent: true,
        snapshotExpiration: 0,
        keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true },
        resume: true,
      }),
    );
    // The fake invokes the lifecycle hook: a bootstrap in both the hook and runtime would run twice.
    expect(sandboxApi.getOrCreate.mock.calls[0]?.[0].onCreate).toEqual(expect.any(Function));
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.stop).not.toHaveBeenCalled();
  });

  it("resumes by Facility identity and reinitializes transient services once", async () => {
    const sandbox = fakeSandbox();
    sandboxApi.get.mockImplementation(async (options) => {
      await options.onResume?.(sandbox);
      return sandbox;
    });
    const runtime = new VercelWorkspaceRuntime();

    await runtime.wake({
      id: "ws_0123456789abcdef",
      image: "facility-runner:test",
      externalRef: "ws_0123456789abcdef",
      volumeRef: "snap_previous",
      environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
      ports: [{ service: "web", port: 3000 }],
    });

    expect(sandboxApi.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ws_0123456789abcdef", resume: true }),
    );
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.stop).not.toHaveBeenCalled();
  });

  const input = {
    id: "ws_0123456789abcdef",
    externalRef: "ws_0123456789abcdef",
    volumeRef: "snap_original",
    image: "facility-runner:test",
    environment: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
    ports: [{ service: "web", port: 3000 }],
  };

  it.each([
    "create",
    "wake",
  ] as const)("stops compute after %s initialization rejects, preserving the disk", async (operation) => {
    const sandbox = fakeSandbox();
    const failure = new Error("bootstrap connection failed");
    sandbox.runCommand.mockRejectedValue(failure);
    sandboxApi.getOrCreate.mockImplementation(async (options) => {
      await options.onCreate?.(sandbox);
      return sandbox;
    });
    sandboxApi.get.mockImplementation(async (options) => {
      await options.onResume?.(sandbox);
      return sandbox;
    });
    await expect(new VercelWorkspaceRuntime()[operation](input)).rejects.toBe(failure);
    expect(sandbox.stop).toHaveBeenCalledOnce();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("stops compute on a nonzero bootstrap exit or a failed handle construction", async () => {
    for (const handleFails of [false, true]) {
      const sandbox = fakeSandbox();
      if (handleFails)
        sandbox.currentSession = () => {
          throw new Error("session unavailable");
        };
      else
        sandbox.runCommand.mockResolvedValue({
          exitCode: 1,
          stderr: vi.fn().mockResolvedValue("docker did not start"),
        });
      sandboxApi.getOrCreate.mockImplementation(async (options) => {
        await options.onCreate?.(sandbox);
        return sandbox;
      });
      await expect(new VercelWorkspaceRuntime().create(input)).rejects.toThrow(
        handleFails ? "session unavailable" : "docker did not start",
      );
      expect(sandbox.stop).toHaveBeenCalledOnce();
      expect(sandbox.delete).not.toHaveBeenCalled();
    }
  });

  it("surfaces both failures and the recoverable workspace identity when stopping fails", async () => {
    const sandbox = fakeSandbox();
    const initializationError = new Error("bootstrap failed");
    const cleanupError = new Error("stop failed");
    sandbox.runCommand.mockRejectedValue(initializationError);
    sandbox.stop.mockRejectedValue(cleanupError);
    sandboxApi.getOrCreate.mockImplementation(async (options) => {
      await options.onCreate?.(sandbox);
      return sandbox;
    });
    await expect(new VercelWorkspaceRuntime().create(input)).rejects.toMatchObject({
      code: "workspace_initialize_cleanup_failed",
      message: expect.stringContaining(input.id),
      cause: { errors: [initializationError, cleanupError] },
    });
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it.each([
    "create",
    "wake",
  ] as const)("rejects a missing preview credential before %s allocates or resumes compute", async (operation) => {
    await expect(
      new VercelWorkspaceRuntime()[operation]({ ...input, environment: {} }),
    ).rejects.toMatchObject({ code: "preview_gateway_token_missing" });
    expect(sandboxApi.get).not.toHaveBeenCalled();
    expect(sandboxApi.getOrCreate).not.toHaveBeenCalled();
  });

  it.each([
    "create",
    "wake",
  ] as const)("does not stop an already-running workspace on a failed %s", async (operation) => {
    const sandbox = fakeSandbox();
    const failure = new Error("initialization failed beside an active agent turn");
    sandbox.runCommand.mockRejectedValue(failure);
    // Provider lifecycle hooks do not fire when acquiring already-running compute.
    sandboxApi.getOrCreate.mockResolvedValue(sandbox);
    sandboxApi.get.mockResolvedValue(sandbox);
    await expect(new VercelWorkspaceRuntime()[operation](input)).rejects.toBe(failure);
    expect(sandbox.stop).not.toHaveBeenCalled();
    expect(sandbox.delete).not.toHaveBeenCalled();
  });

  it("does not stop a session that already stopped during initialization", async () => {
    const sandbox = fakeSandbox();
    sandbox.runCommand.mockImplementation(async () => {
      sandbox.status = "stopped";
      throw new Error("session already stopped");
    });
    sandboxApi.get.mockImplementation(async (options) => {
      await options.onResume?.(sandbox);
      return sandbox;
    });
    await expect(new VercelWorkspaceRuntime().wake(input)).rejects.toThrow(
      "session already stopped",
    );
    expect(sandbox.stop).not.toHaveBeenCalled();
  });

  it("does not touch a sandbox with a mismatched workspace reference", async () => {
    await expect(
      new VercelWorkspaceRuntime().wake({ ...input, externalRef: "ws_abcdef0123456789" }),
    ).rejects.toMatchObject({ code: "workspace_reference_invalid" });
    expect(sandboxApi.get).not.toHaveBeenCalled();
  });
});
