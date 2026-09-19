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

function frame(seq: number, stream: string, data: string) {
  return `${JSON.stringify({ seq, stream, data: Buffer.from(data).toString("base64") })}\n`;
}

function provider() {
  const getCommand = vi.fn();
  const killCommand = vi.fn().mockResolvedValue(undefined);
  const client = {
    getCommand,
    killCommand,
    getLogs: vi.fn(async function* () {
      yield { stream: "stdout", data: "native output" };
    }),
  };
  // Exercise the real SDK Command.wait/CommandFinished path. Live metadata reads
  // can keep returning exitCode:null even after a command has finished.
  const command = new Command({
    client: client as unknown as NonNullable<ConstructorParameters<typeof Command>[0]["client"]>,
    sessionId: metadata.sessionId,
    cmd: metadata,
  });
  const runCommand = vi.fn().mockResolvedValue(command);
  const readFileToBuffer = vi
    .fn()
    .mockResolvedValue(Buffer.from(frame(0, "stdout", "native output")));
  const metadataRead = vi.fn().mockResolvedValue(command);
  sandboxApi.get.mockResolvedValue({
    asUser: () => ({ runCommand }),
    currentSession: () => ({ getCommand: metadataRead, readFileToBuffer }),
  });
  return {
    getCommand,
    killCommand,
    runCommand,
    metadataRead,
    readFileToBuffer,
    getLogs: client.getLogs,
  };
}

describe("Vercel command observation through the actual SDK", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never resumes stopped compute for process cleanup", async () => {
    const { runCommand } = provider();
    sandboxApi.get.mockResolvedValue({ status: "stopped", asUser: () => ({ runCommand }) });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "sh", resume: false }),
    ).rejects.toMatchObject({ code: "workspace_not_running" });
    expect(sandboxApi.get).toHaveBeenCalledWith(expect.objectContaining({ resume: false }));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("binds cleanup to the existing session without using an auto-resuming command method", async () => {
    const { getCommand, runCommand } = provider();
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    const asUser = vi.fn();
    sandboxApi.get.mockResolvedValue({
      status: "running",
      asUser,
      currentSession: () => ({ runCommand }),
    });
    await new VercelWorkspaceRuntime().exec(workspace, {
      command: "sh",
      args: ["-c", "true"],
      resume: false,
    });
    expect(asUser).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: "sudo", args: ["-u", "node", "--", "sh", "-c", "true"] }),
    );
  });

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

  it("reconnects dropped waits and replayed logs without duplicating output or command submission", async () => {
    const { getCommand, getLogs, runCommand, killCommand } = provider();
    const disconnected = new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } });
    getCommand.mockRejectedValueOnce(disconnected).mockResolvedValue({
      json: { command: { ...metadata, exitCode: 0, durationMs: 100 } },
    });
    getLogs
      .mockImplementationOnce(async function* () {
        yield { stream: "stdout", data: "native " };
        yield { stream: "stderr", data: "warning" };
        throw disconnected;
      })
      .mockImplementation(async function* () {
        yield { stream: "stderr", data: "warning continued" };
        yield { stream: "stdout", data: "nati" };
        yield { stream: "stdout", data: "ve output" };
      });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex" }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "native output", stderr: "warning continued" });
    expect(getCommand).toHaveBeenCalledTimes(2);
    expect(getLogs).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(killCommand).not.toHaveBeenCalled();
  });

  it("recovers truncated provider logs from durable output without repeating the command", async () => {
    const { getCommand, getLogs, runCommand, readFileToBuffer, killCommand } = provider();
    const first = frame(0, "stdout", "first ");
    readFileToBuffer.mockResolvedValue(Buffer.from(first + frame(1, "stdout", "second")));
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: first };
      yield { stream: "stdout", data: first.slice(12) }; // reconnect starts mid-frame
    });
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    const onOutput = vi.fn();
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "first second" });
    expect(onOutput.mock.calls.map(([event]) => event.data).join("")).toBe("first second");
    expect(readFileToBuffer).toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledOnce();
    expect(killCommand).not.toHaveBeenCalled();
  });

  it("stops the original command when observation fails terminally", async () => {
    const { getCommand, getLogs, killCommand, runCommand } = provider();
    getCommand.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: "before failure" };
      throw Object.assign(new Error("access denied"), { status: 403 });
    });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex" }),
    ).rejects.toThrow("access denied");
    expect(killCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it.each([
    401, 403, 404, 422,
  ])("does not bypass denied journal log reads with HTTP %s", async (status) => {
    const { getCommand, getLogs, readFileToBuffer } = provider();
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "first") };
      throw Object.assign(new Error("denied"), { status });
    });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput: () => undefined }),
    ).rejects.toThrow("denied");
    expect(readFileToBuffer).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 422])("never retries a log read denied with HTTP %s", async (status) => {
    const { getCommand, getLogs, runCommand } = provider();
    const denied = Object.assign(new Error("request denied"), { response: { status } });
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: "before denial" };
      throw denied;
    });
    await expect(new VercelWorkspaceRuntime().exec(workspace, { command: "codex" })).rejects.toBe(
      denied,
    );
    expect(getLogs).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it("cancels during reconnection backoff and does not reopen the stream", async () => {
    const { getCommand, getLogs, runCommand, killCommand } = provider();
    const controller = new AbortController();
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    getLogs.mockImplementation(async function* () {
      setTimeout(() => controller.abort(), 10);
      yield { stream: "stdout", data: "before disconnect" };
      throw new TypeError("fetch failed");
    });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "workspace_command_canceled" });
    expect(getLogs).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
    expect(killCommand).toHaveBeenCalledOnce();
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
