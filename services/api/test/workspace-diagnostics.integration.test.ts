import { execFileSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: api }));

import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

const workspace = {
  id: "ws_0123456789abcdef",
  externalRef: "ws_0123456789abcdef",
  volumeRef: "snapshot_retained",
  image: "runner:test",
};

beforeEach(() => vi.clearAllMocks());
describe("provider health collection", () => {
  it("samples the original VM with an actual read-only probe, without waking or leaking secrets", async () => {
    const runCommand = vi.fn(async (command: { args: string[] }) => ({
      exitCode: 0,
      stdout: async () =>
        execFileSync(process.execPath, command.args.slice(4), {
          encoding: "utf8",
          timeout: 5000,
          env: { ...process.env, SECRET: "must-not-leak" },
        }),
    }));
    const implicitResume = vi.fn(() => {
      throw new Error("must not resume");
    });
    api.get.mockResolvedValue({
      status: "running",
      currentSession: () => ({ sessionId: "original", runCommand }),
      asUser: implicitResume,
      runCommand: implicitResume,
    });
    const result = await new VercelWorkspaceRuntime().diagnostics(
      workspace,
      process.cwd(),
      AbortSignal.timeout(8000),
    );
    expect(result).toMatchObject({
      provider: "vercel",
      state: "running",
      computeRef: "original",
      probe: "ok",
    });
    expect(result.health?.gitHead).toMatch(/^[a-f0-9]{40}$/);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(api.get).toHaveBeenCalledWith(
      expect.objectContaining({ name: workspace.id, resume: false }),
    );
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "sudo", args: expect.arrayContaining(["-u", "node", "--"]) }),
    );
    expect(implicitResume).not.toHaveBeenCalled();
  });
  it.each([
    "failed",
    "aborted",
    "stopped",
    "snapshotting",
  ])("does not start commands in a %s VM", async (state) => {
    const runCommand = vi.fn();
    api.get.mockResolvedValue({
      status: state,
      currentSession: () => ({ sessionId: "old", runCommand }),
    });
    const result = await new VercelWorkspaceRuntime().diagnostics(
      workspace,
      "/workspace",
      AbortSignal.timeout(8000),
    );
    expect(result).toEqual({ provider: "vercel", state, computeRef: "old" });
    expect(runCommand).not.toHaveBeenCalled();
  });
  it("rejects a cross-workspace reference before contacting the provider", async () => {
    await expect(
      new VercelWorkspaceRuntime().diagnostics(
        { ...workspace, externalRef: "ws_other" },
        "/workspace",
        AbortSignal.timeout(8000),
      ),
    ).rejects.toMatchObject({ code: "workspace_reference_invalid" });
    expect(api.get).not.toHaveBeenCalled();
  });
  it.each([
    401, 403, 410, 500,
  ])("does not mistake HTTP %s for a missing workspace", async (status) => {
    api.get.mockRejectedValue({ response: { status } });
    await expect(new VercelWorkspaceRuntime().inspect(workspace)).rejects.toMatchObject({
      response: { status },
    });
  });
  it("recognizes an SDK 404 while preserving the retained storage reference", async () => {
    api.get.mockRejectedValue({ response: { status: 404 } });
    await expect(new VercelWorkspaceRuntime().inspect(workspace)).resolves.toMatchObject({
      state: "destroyed",
      volumeRef: workspace.volumeRef,
    });
  });
  it.each([
    "failed",
    "aborted",
  ])("reports %s as an error rather than a sleeping machine", async (status) => {
    api.get.mockResolvedValue({ status, currentSnapshotId: "snapshot_retained" });
    await expect(new VercelWorkspaceRuntime().inspect(workspace)).resolves.toMatchObject({
      state: "error",
    });
  });
});
