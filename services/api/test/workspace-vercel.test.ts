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
    domain: (port: number) => `workspace-${port}.example.test`,
  };
}

describe("Vercel persistent workspace runtime", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a non-expiring persistent sandbox and initializes it exactly once", async () => {
    const sandbox = fakeSandbox();
    sandboxApi.getOrCreate.mockResolvedValue(sandbox);
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
    expect(sandboxApi.getOrCreate.mock.calls[0]?.[0]).not.toHaveProperty("onCreate");
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
  });

  it("resumes by Facility identity and reinitializes transient services once", async () => {
    const sandbox = fakeSandbox();
    sandboxApi.get.mockResolvedValue(sandbox);
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
  });
});
