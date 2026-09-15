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
  const runCommand = vi.fn().mockResolvedValue({
    exitCode: 0,
    stderr: vi.fn().mockResolvedValue(""),
  });
  return {
    name: "ws_0123456789abcdef",
    status: "running",
    currentSnapshotId: "snap_persistent",
    currentSession: () => ({
      sessionId: "session_current",
      getCommand: vi.fn().mockResolvedValue({ exitCode: 0, durationMs: 12 }),
    }),
    runCommand,
    asUser: vi.fn().mockReturnValue({ runCommand }),
    stop: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn(),
    domain: (port: number) => `https://workspace-${port}.example.test`,
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
        timeout: 24 * 60 * 60 * 1_000,
      }),
    );
    // The fake invokes the lifecycle hook: a bootstrap in both the hook and runtime would run twice.
    expect(sandboxApi.getOrCreate.mock.calls[0]?.[0].onCreate).toEqual(expect.any(Function));
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandbox.asUser).toHaveBeenCalledExactlyOnceWith("root");
    expect(sandbox.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/",
        env: { FACILITY_PREVIEW_GATEWAY_TOKEN: "x".repeat(32) },
      }),
    );
    expect(sandbox.runCommand.mock.calls[0]?.[0]).not.toHaveProperty("sudo");
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
    const bootstrap = sandbox.runCommand.mock.calls[0]?.[0].args[1];
    expect(bootstrap).toContain("chown -h root:root /workspace/.facility/docker");
    expect(bootstrap).not.toMatch(/chown\s+-R/);
    expect(bootstrap).toContain('cat "/proc/$docker_pid/comm"');
    expect(bootstrap).not.toContain('kill "$docker_pid"');
    expect(bootstrap).toContain("cat /proc/sys/kernel/random/boot_id");
    expect(bootstrap).toContain('--exec-root="/var/run/facility-docker-$docker_boot_id"');
    expect(bootstrap).toContain("--data-root=/workspace/.facility/docker");
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
    [undefined, undefined],
    [60_000, 60_000],
    [18_000_000, 18_000_000],
    [18_000_001, 18_000_000],
    [86_400_000, 18_000_000],
  ])("bounds command timeout %s to the provider limit", async (requested, expected) => {
    const runCommand = vi.fn().mockResolvedValue({
      logs: async function* () {
        yield { stream: "stdout", data: "ready" };
        yield { stream: "stderr", data: "warning" };
      },
      wait: async () => ({ exitCode: 0, durationMs: 12 }),
    });
    const asUser = vi.fn().mockReturnValue({ runCommand });
    sandboxApi.get.mockResolvedValue({ ...fakeSandbox(), asUser });
    const onOutput = vi.fn();
    await expect(
      new VercelWorkspaceRuntime().exec(input, {
        command: "node",
        args: ["--version"],
        timeoutMs: requested,
        onOutput,
      }),
    ).resolves.toEqual({ exitCode: 0, stdout: "ready", stderr: "warning", durationMs: 12 });
    expect(asUser).toHaveBeenCalledWith("node");
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "node", timeoutMs: expected, detached: true }),
    );
    expect(onOutput.mock.calls).toEqual([
      [{ stream: "stdout", data: "ready" }],
      [{ stream: "stderr", data: "warning" }],
    ]);
  });

  it("bounds observation of one long-running command without relaunching it", async () => {
    const wait = vi.fn().mockResolvedValue({ exitCode: 0, durationMs: 1_200_000 });
    const running = {
      cmdId: "cmd_long",
      wait,
      logs: async function* () {
        yield { stream: "stdout", data: "still working" };
      },
    };
    const runCommand = vi.fn().mockResolvedValue(running);
    const sandbox = { ...fakeSandbox(), asUser: () => ({ runCommand }) };
    sandboxApi.get.mockResolvedValue(sandbox);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      const output = await new VercelWorkspaceRuntime().exec(input, {
        command: "codex",
        timeoutMs: 1_800_000,
      });
      expect(output).toMatchObject({ exitCode: 0, stdout: "still working", durationMs: 1_200_000 });
      expect(runCommand).toHaveBeenCalledOnce();
      expect(wait).toHaveBeenCalledExactlyOnceWith({ signal: expect.any(AbortSignal) });
      expect(timeout).toHaveBeenCalledWith(30_000);
      expect(sandboxApi.get).toHaveBeenCalledOnce();
      expect(sandbox.stop).not.toHaveBeenCalled();
    } finally {
      timeout.mockRestore();
    }
  });

  it("surfaces a denied completion read without retrying command submission", async () => {
    const denied = Object.assign(new Error("access revoked"), { status: 403 });
    const wait = vi.fn().mockRejectedValue(denied);
    const runCommand = vi.fn().mockResolvedValue({ wait, logs: async function* () {} });
    sandboxApi.get.mockResolvedValue({ ...fakeSandbox(), asUser: () => ({ runCommand }) });
    await expect(new VercelWorkspaceRuntime().exec(input, { command: "codex" })).rejects.toBe(
      denied,
    );
    expect(runCommand).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();
  });

  it("aborts a pending completion read when the output stream fails", async () => {
    const streamError = new Error("output stream disconnected");
    const wait = vi.fn(
      (options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const runCommand = vi.fn().mockResolvedValue({
      wait,
      logs: async function* () {
        yield { stream: "stdout", data: "partial output" };
        throw streamError;
      },
    });
    sandboxApi.get.mockResolvedValue({ ...fakeSandbox(), asUser: () => ({ runCommand }) });
    await expect(new VercelWorkspaceRuntime().exec(input, { command: "codex" })).rejects.toBe(
      streamError,
    );
    expect(wait.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("uses the SDK's full HTTPS URL for exposed and inspected preview endpoints", async () => {
    sandboxApi.get.mockResolvedValue(fakeSandbox());
    const runtime = new VercelWorkspaceRuntime();
    const endpoints = await runtime.expose(input, input.ports);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.url).toMatch(/^https:\/\/workspace-\d+\.example\.test$/);
    const inspected = await runtime.inspect(input);
    expect(inspected.endpoints).toEqual(endpoints);
  });

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
