import { Command } from "@vercel/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/sandbox")>()),
  Sandbox: sandboxApi,
}));
vi.mock("node:timers/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...original,
    setTimeout: (_ms: number, value: unknown, options: { signal?: AbortSignal }) =>
      original.setTimeout(_ms === 250 ? 250 : 1, value, options),
  };
});

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

function exitFrame(seq: number, exitCode = 0) {
  return `${JSON.stringify({ seq, type: "exit", exitCode, durationMs: 100 })}\n`;
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
    .mockResolvedValue(Buffer.from(frame(0, "stdout", "native output") + exitFrame(1)));
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

  it("retries an expired journal request without ending the command or duplicating output", async () => {
    const { getCommand, getLogs, readFileToBuffer, runCommand, killCommand } = provider();
    const actualTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => actualTimer(callback, ms === 30_000 ? 5 : ms, ...args)) as typeof setTimeout);
    getCommand.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    const first = frame(0, "stdout", "saved ");
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: first };
      throw new TypeError("terminated");
    });
    readFileToBuffer
      .mockImplementationOnce(
        (_path, { signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
      )
      .mockResolvedValue(Buffer.from(first + frame(1, "stdout", "result") + exitFrame(2)));
    const onOutput = vi.fn();
    const onObservation = vi.fn();
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput, onObservation }),
    ).resolves.toMatchObject({ stdout: "saved result", exitCode: 0 });
    expect(onOutput.mock.calls.map(([event]) => event.data).join("")).toBe("saved result");
    expect(onObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "journal",
        state: "recovering",
        reason: "read_timeout",
        nextSequence: 1,
      }),
    );
    expect(onObservation).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "journal", state: "recovered" }),
    );
    expect(readFileToBuffer).toHaveBeenCalledTimes(2);
    expect(runCommand).toHaveBeenCalledOnce();
    expect(killCommand).not.toHaveBeenCalled();
  });

  it("continues read recovery beyond the old retry count while the execution budget remains", async () => {
    const { getCommand, getLogs, readFileToBuffer, killCommand } = provider();
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "native output") };
    });
    for (let i = 0; i < 12; i++)
      readFileToBuffer.mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"));
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput: () => undefined }),
    ).resolves.toMatchObject({ stdout: "native output", exitCode: 0 });
    expect(readFileToBuffer).toHaveBeenCalledTimes(13);
    expect(killCommand).not.toHaveBeenCalled();
  });

  it("completes from the streamed exit event even if completion metadata cannot be read", async () => {
    const { getCommand, getLogs, readFileToBuffer, killCommand } = provider();
    getCommand.mockRejectedValue(new TypeError("fetch failed"));
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "finished") + exitFrame(1, 7) };
    });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput: () => undefined }),
    ).resolves.toMatchObject({ exitCode: 7, stdout: "finished" });
    expect(readFileToBuffer).not.toHaveBeenCalled();
    expect(killCommand).not.toHaveBeenCalled();
  });

  it("does not hide an output consumer failure as a recoverable stream failure", async () => {
    const { getCommand, getLogs, readFileToBuffer, killCommand } = provider();
    getCommand.mockRejectedValue(new TypeError("fetch failed"));
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "output") + exitFrame(1) };
    });
    const failure = new Error("Output consumer failed");
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, {
        command: "codex",
        onOutput: () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(readFileToBuffer).not.toHaveBeenCalled();
    expect(killCommand).toHaveBeenCalledOnce();
  });

  it("rejects a stream that continues after its exit event", async () => {
    const { getCommand, getLogs, readFileToBuffer, killCommand } = provider();
    getCommand.mockRejectedValue(new TypeError("fetch failed"));
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: exitFrame(0) + frame(1, "stdout", "late output") };
    });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput: () => undefined }),
    ).rejects.toThrow("continued after exit");
    expect(readFileToBuffer).not.toHaveBeenCalled();
    expect(killCommand).toHaveBeenCalledOnce();
  });

  it("does not mistake a quiet command or a renewed completion poll for failure", async () => {
    const { getCommand, getLogs, readFileToBuffer, killCommand } = provider();
    const actualTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => actualTimer(callback, ms === 30_000 ? 5 : ms, ...args)) as typeof setTimeout);
    getCommand.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        ),
    );
    getLogs.mockImplementation(async function* () {
      await new Promise((resolve) => actualTimer(resolve, 25));
      yield { stream: "stdout", data: frame(0, "stdout", "after silence") + exitFrame(1) };
    });
    const onObservation = vi.fn();
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, {
        command: "codex",
        onOutput: () => undefined,
        onObservation,
      }),
    ).resolves.toMatchObject({ stdout: "after silence" });
    expect(getCommand.mock.calls.length).toBeGreaterThan(1);
    expect(onObservation).not.toHaveBeenCalled();
    expect(readFileToBuffer).not.toHaveBeenCalled();
    expect(killCommand).not.toHaveBeenCalled();
  });

  it.each([
    401, 403, 404, 410, 422,
  ])("stops on a journal read denied with HTTP %s without retrying or leaking response bodies", async (status) => {
    const { getCommand, getLogs, readFileToBuffer, killCommand } = provider();
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "before denial") };
    });
    const failure = Object.assign(new Error("private response body"), {
      status,
      cause: new DOMException("Timed out", "TimeoutError"),
    });
    readFileToBuffer.mockRejectedValue(failure);
    const onObservation = vi.fn();
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, {
        command: "codex",
        onOutput: () => undefined,
        onObservation,
      }),
    ).rejects.toBe(failure);
    expect(readFileToBuffer).toHaveBeenCalledOnce();
    expect(onObservation).toHaveBeenCalledWith(
      expect.objectContaining({ state: "failed", operation: "journal", httpStatus: status }),
    );
    expect(JSON.stringify(onObservation.mock.calls)).not.toContain("private response body");
    expect(killCommand).toHaveBeenCalledOnce();
  });

  it("cancels journal recovery promptly and terminates the original command only once", async () => {
    const { getCommand, getLogs, readFileToBuffer, killCommand, runCommand } = provider();
    const controller = new AbortController();
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "saved") };
    });
    readFileToBuffer.mockImplementation(async () => {
      controller.abort();
      throw new DOMException("Timed out", "TimeoutError");
    });
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, {
        command: "codex",
        onOutput: () => undefined,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "workspace_command_canceled" });
    expect(killCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
    expect(readFileToBuffer).toHaveBeenCalledOnce();
  });

  it("bounds persistent read failures by the total execution deadline", async () => {
    const { getCommand, getLogs, readFileToBuffer, runCommand, killCommand } = provider();
    const actualTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => actualTimer(callback, ms === 18_030_000 ? 20 : ms, ...args)) as typeof setTimeout);
    getCommand.mockRejectedValue(new TypeError("fetch failed"));
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "saved") };
    });
    readFileToBuffer.mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput: () => undefined }),
    ).rejects.toMatchObject({ code: "workspace_command_timeout" });
    expect(readFileToBuffer.mock.calls.length).toBeGreaterThan(1);
    expect(killCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
  });

  it.each([
    [frame(0, "stdout", "partial"), "missing its exit"],
    [frame(0, "stdout", "partial") + exitFrame(2), "gap"],
    [
      frame(0, "stdout", "partial") + '{"seq":1,"type":"exit","exitCode":-1,"durationMs":1}\n',
      "Invalid",
    ],
  ])("never reports success from incomplete or invalid persisted completion", async (data, message) => {
    const { getCommand, getLogs, readFileToBuffer, runCommand } = provider();
    getCommand.mockResolvedValue({ json: { command: { ...metadata, exitCode: 0 } } });
    getLogs.mockImplementation(async function* () {
      yield { stream: "stdout", data: frame(0, "stdout", "partial") };
    });
    readFileToBuffer.mockResolvedValue(Buffer.from(data));
    await expect(
      new VercelWorkspaceRuntime().exec(workspace, { command: "codex", onOutput: () => undefined }),
    ).rejects.toThrow(message);
    expect(readFileToBuffer).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();
  });

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
    readFileToBuffer.mockResolvedValue(
      Buffer.from(first + frame(1, "stdout", "second") + exitFrame(2)),
    );
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
