import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: api }));

import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import { inputFileArchive } from "../src/workspaces/input-files.js";
import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

const bytes = Buffer.from("synthetic binary\0fixture");
const file = {
  id: "infile_0123456789abcdef",
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
const workspace = {
  id: "ws_0123456789abcdef",
  externalRef: "ws_0123456789abcdef",
  volumeRef: "volume",
  image: "fixture",
  expectedComputeRef: "current",
};

describe("binary provider transport", () => {
  it("pins Vercel transfers to the current session, without commands containing bytes", async () => {
    const writeFiles = vi.fn().mockResolvedValue(undefined),
      readFile = vi.fn().mockImplementation(async () => Readable.from([bytes]));
    const session = { sessionId: "current", writeFiles, readFile };
    api.get.mockResolvedValue({ status: "running", currentSession: () => session });
    const runtime = new VercelWorkspaceRuntime();
    const exec = vi
      .spyOn(runtime, "exec")
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    await runtime.writeInputFile(workspace, file, bytes);
    expect(writeFiles).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          content: bytes,
          path: expect.stringMatching(/^\/tmp\/facility-input-/),
        }),
      ],
      expect.anything(),
    );
    expect(await runtime.readInputFile(workspace, file)).toEqual(bytes);
    expect(JSON.stringify(exec.mock.calls)).not.toContain(bytes.toString("base64"));
    expect(JSON.stringify(exec.mock.calls)).not.toContain("synthetic binary");
    expect(
      exec.mock.calls.every(
        ([target, command]) => target.expectedComputeRef === "current" && command.resume === false,
      ),
    ).toBe(true);
    expect(api.get).toHaveBeenLastCalledWith(expect.objectContaining({ resume: false }));
    const calls = writeFiles.mock.calls.length;
    await expect(
      runtime.writeInputFile({ ...workspace, expectedComputeRef: "replaced" }, file, bytes),
    ).rejects.toThrow();
    expect(writeFiles).toHaveBeenCalledTimes(calls);
  });
  it("uses Docker's binary archives and never wakes or executes across a compute fence", async () => {
    const putArchive = vi.fn().mockResolvedValue(undefined);
    const getArchive = vi
      .fn()
      .mockImplementation(async ({ path }: { path: string }) =>
        Readable.from([inputFileArchive(path, bytes)]),
      );
    const getContainer = vi.fn().mockReturnValue({ putArchive, getArchive });
    const runtime = new DockerWorkspaceRuntime({ getContainer } as never);
    vi.spyOn(runtime, "inspect").mockResolvedValue({
      ...workspace,
      state: "running",
      computeRef: "current",
      provider: "docker",
      endpoints: [],
    });
    const exec = vi
      .spyOn(runtime, "exec")
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 1 });
    await runtime.writeInputFile(workspace, file, bytes);
    expect(Buffer.isBuffer(putArchive.mock.calls[0]?.[0])).toBe(true);
    expect(await runtime.readInputFile(workspace, file)).toEqual(bytes);
    expect(JSON.stringify(exec.mock.calls)).not.toContain("synthetic binary");
    await expect(
      runtime.readInputFile({ ...workspace, expectedComputeRef: "old" }, file),
    ).rejects.toThrow();
    expect(getContainer).toHaveBeenCalledTimes(2);
  });
});
