import { Command } from "@vercel/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/sandbox")>()),
  Sandbox: sandboxApi,
}));

import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

const workspace = {
  id: "ws_0123456789abcdef",
  externalRef: "ws_0123456789abcdef",
  volumeRef: "snap_retained",
  image: "facility-runner:test",
};
const metadata = {
  id: "cmd_original",
  name: "codex",
  args: [],
  cwd: "/workspace",
  sessionId: "session_original",
  exitCode: null,
  startedAt: 0,
};

function provider() {
  const getCommand = vi.fn();
  const killCommand = vi.fn().mockResolvedValue(undefined);
  const client = {
    getCommand,
    killCommand,
    getLogs: async function* () {
      yield { stream: "stdout", data: "native output" };
    },
  };
  // Exercise the real SDK Command.wait/CommandFinished path. Live metadata reads
  // can keep returning exitCode:null even after a command has finished.
  const command = new Command({
    client: client as unknown as NonNullable<ConstructorParameters<typeof Command>[0]["client"]>,
    sessionId: metadata.sessionId,
    cmd: metadata,
  });
  const runCommand = vi.fn().mockResolvedValue(command);
  const metadataRead = vi.fn().mockResolvedValue(command);
  sandboxApi.get.mockResolvedValue({
    asUser: () => ({ runCommand }),
    currentSession: () => ({ getCommand: metadataRead }),
  });
  return { getCommand, killCommand, runCommand, metadataRead };
}

describe("Vercel command observation through the actual SDK", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renews an expired bounded wait on the same command and receives its exit status", async () => {
    const { getCommand, killCommand, runCommand, metadataRead } = provider();
    const actualTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => actualTimeout(5));
    getCommand
      .mockImplementationOnce((input: { wait?: boolean; signal?: AbortSignal }) => {
        if (!input.wait || !input.signal) throw new Error("Completion must use a bounded wait");
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason), {
            once: true,
          });
        });
      })
      .mockResolvedValue({
        json: { command: { ...metadata, exitCode: 0, durationMs: 1_200_000 } },
      });

    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex" }),
    ).resolves.toEqual({
      exitCode: 0,
      stdout: "native output",
      stderr: "",
      durationMs: 1_200_000,
    });
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 30_000);
    expect(timeout).toHaveBeenNthCalledWith(2, 30_000);
    expect(getCommand).toHaveBeenCalledTimes(2);
    for (const [input] of getCommand.mock.calls) {
      expect(input).toMatchObject({
        sessionId: "session_original",
        cmdId: "cmd_original",
        wait: true,
      });
      expect(input.signal).toBeInstanceOf(AbortSignal);
    }
    expect(runCommand).toHaveBeenCalledOnce();
    expect(metadataRead).not.toHaveBeenCalled();
    expect(killCommand).not.toHaveBeenCalled();
  });

  it("propagates revoked access without retrying a wait or resubmitting the command", async () => {
    const { getCommand, runCommand } = provider();
    const denied = Object.assign(new Error("access revoked"), { status: 403 });
    getCommand.mockRejectedValue(denied);
    await expect(new VercelWorkspaceRuntime().exec(workspace, { command: "codex" })).rejects.toBe(
      denied,
    );
    expect(getCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("cancels the command once without mistaking cancellation for an observation timeout", async () => {
    const { getCommand, killCommand, runCommand } = provider();
    const controller = new AbortController();
    getCommand.mockImplementation(
      (input: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(input.signal.reason), { once: true });
          controller.abort();
        }),
    );
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "workspace_command_canceled" });
    expect(getCommand).toHaveBeenCalledOnce();
    expect(killCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
  });
});
