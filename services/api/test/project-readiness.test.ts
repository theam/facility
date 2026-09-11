import type { FacilityDb } from "@facility/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectEnvironmentService,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";
import {
  type WorkspaceCommand,
  type WorkspaceRuntime,
  WorkspaceRuntimeError,
} from "../src/workspaces/runtime.js";

vi.mock("../src/workspaces/events.js", () => ({ appendWorkspaceEvent: vi.fn() }));

const success = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
const input = {
  orgId: "org_test",
  projectId: "proj_test",
  workspace: { id: "ws_test", image: "test", externalRef: "test", volumeRef: "test" },
  setupChecksum: "retained",
  manifest: parseProjectManifest(
    "repositories:\n  primary: github.com/acme/app\nenvironment:\n  start: start-app\n  ready: check-app\n",
  ),
  credentials: {
    gitIdentity: { name: "Test", email: "test@example.invalid" },
    repositories: [{ owner: "acme", name: "app", role: "primary" as const, defaultBranch: "main" }],
    environment: {},
    expiresAt: new Date("2030-01-01"),
  },
};

function fixture() {
  const exec = vi
    .fn<(workspace: unknown, command: WorkspaceCommand) => Promise<typeof success>>()
    .mockResolvedValue(success);
  const expose = vi.fn().mockResolvedValue([]);
  const db = {
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  } as unknown as FacilityDb;
  const service = new ProjectEnvironmentService(db, {
    exec,
    expose,
  } as unknown as WorkspaceRuntime);
  return { exec, expose, service };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("project readiness deadline", () => {
  it("bounds the initial prepared-workspace probe and reports runtime timeouts as readiness failures", async () => {
    const { exec, expose, service } = fixture();
    exec.mockRejectedValueOnce(new WorkspaceRuntimeError("workspace_command_timeout", "timed out"));
    await expect(service.startPrepared(input)).rejects.toMatchObject({
      code: "environment_not_ready",
    });
    expect(exec).toHaveBeenCalledWith(
      input.workspace,
      expect.objectContaining({ args: ["-lc", "check-app"], timeoutMs: 120_000 }),
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(expose).not.toHaveBeenCalled();
  });

  it("rejects a successful probe that completes after its deadline", async () => {
    const { exec, expose, service } = fixture();
    exec.mockImplementationOnce(async () => {
      vi.setSystemTime(120_001);
      return success;
    });
    await expect(service.startPrepared(input)).rejects.toMatchObject({
      code: "environment_not_ready",
    });
    expect(expose).not.toHaveBeenCalled();
  });

  it("uses the remaining budget for retries without reducing the start command timeout", async () => {
    const { exec, service } = fixture();
    let probes = 0;
    exec.mockImplementation(async (_workspace, command) => {
      if (command.args?.[1] !== "check-app") return success;
      probes += 1;
      if (probes === 2) vi.setSystemTime(1_000);
      return { ...success, exitCode: probes < 3 ? 1 : 0 };
    });
    const pending = service.startPrepared({ ...input, readinessTimeoutMs: 2_500 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ setupChecksum: "retained" });
    const commands = exec.mock.calls.map(([, command]) => command);
    expect(
      commands
        .filter((command) => command.args?.[1] === "check-app")
        .map((command) => command.timeoutMs),
    ).toEqual([2_500, 2_500, 1_000]);
    expect(commands.find((command) => command.args?.[1] === "start-app")?.timeoutMs).toBe(
      30 * 60 * 1_000,
    );
  });

  it("reuses a healthy prepared workspace without restarting its application", async () => {
    const { exec, expose, service } = fixture();
    await expect(service.startPrepared(input)).resolves.toMatchObject({
      setupChecksum: "retained",
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(expose).toHaveBeenCalledOnce();
  });

  it("does not replace unrelated runtime failures with timeout errors", async () => {
    const { exec, service } = fixture();
    const error = new WorkspaceRuntimeError("workspace_not_found", "missing workspace");
    exec.mockRejectedValueOnce(error);
    await expect(service.startPrepared(input)).rejects.toBe(error);
  });

  it("does not start a probe when the configured budget is exhausted", async () => {
    const { exec, service } = fixture();
    await expect(service.startPrepared({ ...input, readinessTimeoutMs: 0 })).rejects.toMatchObject({
      code: "environment_not_ready",
    });
    expect(exec).not.toHaveBeenCalled();
  });
});
