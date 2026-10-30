import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import {
  INPUT_FILE_MAX_BYTES,
  inputFileArchive,
  inputFilePath,
  readInputArchive,
  verifyInputBytes,
} from "../src/workspaces/input-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "facility-input-test-"));
  roots.push(root);
  const runtime = new FakeWorkspaceRuntime(root);
  const workspace = await runtime.create({ id: "ws_0123456789abcdef", image: "fixture" });
  const bytes = Buffer.from('{"synthetic":"input-not-instructions"}');
  const file = {
    id: "infile_0123456789abcdef",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { runtime, workspace, bytes, file };
}
describe("private workspace input files", () => {
  it("transfers binary bytes outside Git, preserves across suspend/replace, and removes only one file", async () => {
    const { runtime, workspace, bytes, file } = await fixture();
    const exec = vi.spyOn(runtime, "exec");
    await runtime.writeInputFile(workspace, file, bytes);
    expect(await readFile(inputFilePath(file.id, workspace.volumeRef))).toEqual(bytes);
    expect(await runtime.readInputFile(workspace, file)).toEqual(bytes);
    const commands = JSON.stringify(exec.mock.calls);
    expect(commands).not.toContain(bytes.toString());
    expect(commands).not.toContain(bytes.toString("base64"));
    await runtime.suspend(workspace);
    await expect(runtime.readInputFile(workspace, file)).rejects.toMatchObject({
      code: "workspace_not_running",
    });
    const resumed = await runtime.wake(workspace);
    expect(await runtime.readInputFile(resumed, file)).toEqual(bytes);
    await runtime.retireCompute({ ...resumed, expectedComputeRef: resumed.computeRef });
    await runtime.wake(workspace);
    expect(await runtime.readInputFile(workspace, file)).toEqual(bytes);
    const other = { ...file, id: "infile_1123456789abcdef" };
    await runtime.writeInputFile(workspace, other, bytes);
    await runtime.removeInputFile(workspace, file);
    await expect(runtime.readInputFile(workspace, file)).rejects.toThrow();
    expect(await runtime.readInputFile(workspace, other)).toEqual(bytes);
    await runtime.destroy(workspace);
    await expect(readFile(inputFilePath(other.id, workspace.volumeRef))).rejects.toThrow();
  });
  it("rejects traversal, oversize and changed bytes before storage", async () => {
    const { runtime, workspace, bytes, file } = await fixture();
    for (const id of ["../outside", "/tmp/input", "infile_0123456789abcdef/../../evil"])
      expect(() => inputFilePath(id)).toThrow();
    expect(() => verifyInputBytes({ ...file, size: INPUT_FILE_MAX_BYTES + 1 }, bytes)).toThrow();
    await expect(runtime.writeInputFile(workspace, file, Buffer.from("changed"))).rejects.toThrow();
    await runtime.writeInputFile(workspace, file, bytes);
    await expect(runtime.writeInputFile(workspace, file, bytes)).rejects.toThrow();
    expect(await runtime.readInputFile(workspace, file)).toEqual(bytes);
  });
  it("reports cleanup failure and removes its retained per-file staging on discard", async () => {
    const { runtime, workspace, file, bytes } = await fixture();
    const original = runtime.exec.bind(runtime);
    let stage = "",
      fail = true;
    const exec = vi.spyOn(runtime, "exec").mockImplementation(async (target, command) => {
      if (command.args?.[2] === "cleanup" && fail) {
        fail = false;
        stage = String(command.args[5]);
        return { exitCode: 1, stdout: "", stderr: "synthetic cleanup failure", durationMs: 1 };
      }
      return original(target, command);
    });
    try {
      await expect(runtime.writeInputFile(workspace, file, bytes)).rejects.toThrow(
        "input_file_cleanup_failed",
      );
      expect(await readFile(stage)).toEqual(bytes);
      await runtime.removeInputFile(workspace, file);
      await expect(readFile(stage)).rejects.toThrow();
      await expect(readFile(inputFilePath(file.id, workspace.volumeRef))).rejects.toThrow();
    } finally {
      exec.mockRestore();
    }
  });
  it("does not follow directory or target symlinks", async () => {
    const { runtime, workspace, bytes, file } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "facility-input-outside-"));
    roots.push(outside);
    await symlink(outside, join(workspace.volumeRef, ".facility", "inputs"));
    await expect(runtime.writeInputFile(workspace, file, bytes)).rejects.toThrow();
    await expect(readFile(join(outside, file.id))).rejects.toThrow();
    await rm(join(workspace.volumeRef, ".facility", "inputs"));
    await mkdir(join(workspace.volumeRef, ".facility", "inputs"));
    const victim = join(outside, "victim");
    await writeFile(victim, bytes);
    await symlink(victim, inputFilePath(file.id, workspace.volumeRef));
    await expect(runtime.readInputFile(workspace, file)).rejects.toThrow();
    await expect(runtime.writeInputFile(workspace, file, bytes)).rejects.toThrow();
    await runtime.removeInputFile(workspace, file);
    expect(await readFile(victim)).toEqual(bytes);
  });
  it("handles only one bounded regular Docker archive entry", async () => {
    const { bytes } = await fixture();
    const path = "/tmp/facility-input-fixture";
    const archive = inputFileArchive(path, bytes);
    expect(await readInputArchive(Readable.from([archive]), path)).toEqual(bytes);
    await expect(readInputArchive(Readable.from([archive]), "/tmp/wrong")).rejects.toThrow();
    const link = Buffer.from(archive);
    link[156] = 50;
    await expect(readInputArchive(Readable.from([link]), path)).rejects.toThrow();
    await expect(
      readInputArchive(Readable.from([archive.subarray(0, 513)]), path),
    ).rejects.toThrow();
  });
});
