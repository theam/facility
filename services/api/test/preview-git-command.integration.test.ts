import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { previewGitCommand } from "../src/workspaces/preview-git-command.js";

const execFile = promisify(execFileCallback);

describe("preview Git control records through a real shell and Git", () => {
  let root: string;
  let base: string;
  let candidate: string;
  const refs = ["refs/heads/preview", "refs/facility/owner", "refs/facility/managed"];
  const zero = "0".repeat(40);
  const git = async (...args: string[]) =>
    (await execFile("git", args, { cwd: root })).stdout.trim();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "facility-preview-git-input-"));
    await git("init", "--initial-branch=main");
    await git("config", "user.name", "Facility Fixture");
    await git("config", "user.email", "fixture@example.test");
    await git("commit", "--allow-empty", "-m", "base");
    base = await git("rev-parse", "HEAD");
    await git("commit", "--allow-empty", "-m", "candidate");
    candidate = await git("rev-parse", "HEAD");
    await git("update-ref", "refs/heads/main", base);
    await writeFile(join(root, "retained.txt"), "valuable retained data\n");
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  async function execute(args: string[], input: string) {
    const command = previewGitCommand(args, input);
    return execFile(command.command, command.args ?? [], { cwd: root });
  }
  function transaction(lastExpected = zero) {
    return [
      "start",
      "option no-deref",
      ...refs.map(
        (ref, index) => `update ${ref} ${candidate} ${index === 2 ? lastExpected : zero}`,
      ),
      "prepare",
      "commit",
      "",
    ].join("\n");
  }

  it("preserves literal bytes, including shell syntax and the here-document delimiter", async () => {
    const marker = join(root, "must-not-exist");
    const input = `-n %s ' " $HOME\nFACILITY_PREVIEW_GIT_INPUT\n$(touch ${marker})\n\`touch ${marker}\`\nutf8: ñ\n\n`;
    const expected = createHash("sha1")
      .update(`blob ${Buffer.byteLength(input)}\0`)
      .update(input)
      .digest("hex");
    expect((await execute(["hash-object", "--stdin"], input)).stdout.trim()).toBe(expected);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("commits all preview refs atomically while preserving the protected branch and retained data", async () => {
    await execute(["update-ref", "--stdin"], transaction());
    for (const ref of refs) expect(await git("rev-parse", ref)).toBe(candidate);
    expect(await git("rev-parse", "main")).toBe(base);
    expect(await readFile(join(root, "retained.txt"), "utf8")).toBe("valuable retained data\n");
  });

  it("does not publish any ref when one compare-and-swap precondition fails", async () => {
    await expect(execute(["update-ref", "--stdin"], transaction(base))).rejects.toMatchObject({
      code: 128,
    });
    expect(await git("for-each-ref", "--format=%(refname)", ...refs)).toBe("");
    expect(await git("rev-parse", "main")).toBe(base);
    expect(await readFile(join(root, "retained.txt"), "utf8")).toBe("valuable retained data\n");
  });
});
