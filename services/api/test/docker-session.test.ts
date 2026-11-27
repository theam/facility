import { Duplex } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import type { WorkspaceLocator } from "../src/workspaces/runtime.js";

describe("Docker native terminal boundary", () => {
  it("attaches with a real TTY, forwards input and resize, and detaches without stopping compute", async () => {
    const writes: string[] = [];
    const stream = new Duplex({
      read() {},
      write(data, _encoding, done) {
        writes.push(data.toString());
        done();
      },
    });
    const execution = { start: vi.fn(async () => stream), resize: vi.fn(async () => undefined) };
    const container = { exec: vi.fn(async () => execution), stop: vi.fn(), remove: vi.fn() };
    const runtime = new DockerWorkspaceRuntime({
      getContainer: () => container,
    } as unknown as Docker);
    vi.spyOn(runtime, "inspect").mockResolvedValue({
      id: "ws_fixture",
      provider: "docker",
      state: "running",
      computeRef: "compute",
      volumeRef: "volume",
      endpoints: [],
    });
    const output: string[] = [];
    const terminal = await runtime.terminal({ id: "ws_fixture" } as WorkspaceLocator, {
      socket: "/workspace/.facility/interactive/turn_fixture/tty",
      cols: 80,
      rows: 24,
      onData: (data) => output.push(data.toString()),
    });
    expect(container.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        Tty: true,
        AttachStdin: true,
        User: "node",
        Cmd: [
          "dtach",
          "-a",
          "/workspace/.facility/interactive/turn_fixture/tty",
          "-E",
          "-r",
          "winch",
        ],
      }),
    );
    terminal.write(Buffer.from("a correction\r"));
    stream.push(Buffer.from("native output"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(writes).toEqual(["a correction\r"]);
    expect(output).toEqual(["native output"]);
    await terminal.resize(120, 40);
    expect(execution.resize.mock.calls).toEqual([[{ w: 80, h: 24 }], [{ w: 120, h: 40 }]]);
    terminal.close();
    expect(stream.destroyed).toBe(true);
    expect(container.stop).not.toHaveBeenCalled();
    expect(container.remove).not.toHaveBeenCalled();
  });
  it("rejects arbitrary sockets and non-running workspaces before Docker exec", async () => {
    const exec = vi.fn();
    const runtime = new DockerWorkspaceRuntime({
      getContainer: () => ({ exec }),
    } as unknown as Docker);
    const inspect = vi.spyOn(runtime, "inspect").mockResolvedValue({
      id: "ws_fixture",
      provider: "docker",
      state: "sleeping",
      volumeRef: "volume",
      endpoints: [],
    });
    const input = { socket: "/tmp/another-process.sock", cols: 80, rows: 24, onData() {} };
    await expect(runtime.terminal({} as WorkspaceLocator, input)).rejects.toMatchObject({
      code: "session_socket_invalid",
    });
    expect(inspect).not.toHaveBeenCalled();
    await expect(
      runtime.terminal({} as WorkspaceLocator, {
        ...input,
        socket: "/workspace/.facility/interactive/turn_fixture/tty",
      }),
    ).rejects.toMatchObject({ code: "workspace_not_running" });
    expect(exec).not.toHaveBeenCalled();
  });
});
