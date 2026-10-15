import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isInside,
  LocalRepositoryError,
  LocalRepositoryHost,
  parseLocalRepositoryRoots,
} from "../src/repositories/local.js";

describe("local repository host", () => {
  let base: string;
  let root: string;
  let outside: string;
  let host: LocalRepositoryHost;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "facility-local-host-"));
    root = join(base, "approved");
    outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    host = new LocalRepositoryHost({ roots: [root], maxFileBytes: 4_096 });
  });

  afterAll(async () => rm(base, { recursive: true, force: true }));

  it("is disabled until an operator approves a root", async () => {
    const disabled = new LocalRepositoryHost({ roots: [] });
    expect(disabled.enabled).toBe(false);
    await expectCode(disabled.inspect(join(root, "any")), "local_repositories_disabled", 403);
    expect(() => new LocalRepositoryHost({ roots: ["relative/root"] })).toThrow(/absolute/);
  });

  it("parses the roots setting and compares paths by segment", () => {
    expect(parseLocalRepositoryRoots(" /a/b: /c ::")).toEqual(["/a/b", "/c"]);
    expect(parseLocalRepositoryRoots(undefined)).toEqual([]);
    expect(isInside("/srv/code", "/srv/code")).toBe(true);
    expect(isInside("/srv/code", "/srv/code/app")).toBe(true);
    expect(isInside("/srv/code", "/srv/code-evil/app")).toBe(false);
    expect(isInside("/srv/code", "/srv/code/../etc")).toBe(false);
  });

  it("registers a repository root with its current branch, commit, and no side effects", async () => {
    const repository = await createRepository(join(root, "app"));
    const before = await git(repository, ["status", "--porcelain", "--untracked-files=all"]);
    const inspection = await host.inspect(repository);
    expect(inspection).toMatchObject({
      path: repository,
      defaultBranch: "main",
      bare: false,
      warnings: [],
    });
    expect(inspection.headSha).toBe((await git(repository, ["rev-parse", "HEAD"])).trim());
    expect(await git(repository, ["status", "--porcelain", "--untracked-files=all"])).toBe(before);
  });

  it("rejects malformed, traversing, and out-of-root paths", async () => {
    await createRepository(join(outside, "secret"));
    await expectCode(host.inspect("relative/app"), "local_repository_path_invalid", 400);
    await expectCode(host.inspect(`${root}/app\0`), "local_repository_path_invalid", 400);
    await expectCode(
      host.inspect(`${root}/../outside/secret`),
      "local_repository_path_invalid",
      400,
    );
    await expectCode(host.inspect(join(outside, "secret")), "local_repository_outside_roots", 403);
    await expectCode(host.inspect(join(root, "missing")), "local_repository_not_found", 404);
    // A sibling whose name only shares the root's prefix is outside the root.
    await createRepository(`${root}-evil`);
    await expectCode(host.inspect(`${root}-evil`), "local_repository_outside_roots", 403);
  });

  it("follows symlinks to their target and rejects links that escape an approved root", async () => {
    await symlink(join(outside, "secret"), join(root, "escape"));
    await expectCode(host.inspect(join(root, "escape")), "local_repository_outside_roots", 403);
    await symlink(join(root, "app"), join(root, "alias-link"));
    expect((await host.inspect(join(root, "alias-link"))).path).toBe(join(root, "app"));
  });

  it("rejects worktrees whose object store lives outside an approved root", async () => {
    const main = await createRepository(join(outside, "main-repo"));
    await git(main, ["worktree", "add", "-q", join(root, "worktree"), "-b", "feature"]);
    await expectCode(host.inspect(join(root, "worktree")), "local_repository_outside_roots", 403);
  });

  it("requires a Git repository root with at least one commit", async () => {
    await mkdir(join(root, "plain"));
    await expectCode(host.inspect(join(root, "plain")), "local_repository_not_git", 400);
    await mkdir(join(root, "app", "nested"), { recursive: true });
    await expectCode(host.inspect(join(root, "app", "nested")), "local_repository_not_root", 400);
    await mkdir(join(root, "empty"));
    await git(join(root, "empty"), ["init", "-q", "-b", "main"]);
    await expectCode(host.inspect(join(root, "empty")), "local_repository_empty", 400);
  });

  it("validates the default branch and requires one for a detached HEAD", async () => {
    const repository = await createRepository(join(root, "detached"));
    await git(repository, ["checkout", "-q", "--detach"]);
    await expectCode(host.inspect(repository), "local_repository_branch_required", 400);
    expect((await host.inspect(repository, "main")).defaultBranch).toBe("main");
    await expectCode(host.inspect(repository, "missing"), "local_repository_branch_not_found", 400);
    await expectCode(host.inspect(repository, "-x"), "local_repository_branch_invalid", 400);
    await expectCode(host.inspect(repository, "a..b"), "local_repository_branch_invalid", 400);
  });

  it("refuses repositories owned by an untrusted user", async () => {
    const strict = new LocalRepositoryHost({ roots: [root], ownerUids: [2_147_483_000] });
    await expectCode(strict.inspect(join(root, "app")), "local_repository_owner_untrusted", 403);
  });

  it("never runs repository hooks or fsmonitor commands", async () => {
    const repository = await createRepository(join(root, "hostile"));
    const marker = join(base, "executed");
    const script = join(base, "payload.sh");
    await writeFile(script, `#!/bin/sh\ntouch ${marker}\n`);
    await chmod(script, 0o755);
    await git(repository, ["config", "core.fsmonitor", script]);
    await mkdir(join(repository, ".git", "hooks"), { recursive: true });
    for (const hook of ["post-checkout", "reference-transaction", "pre-auto-gc"]) {
      await writeFile(join(repository, ".git", "hooks", hook), `#!/bin/sh\ntouch ${marker}\n`);
      await chmod(join(repository, ".git", "hooks", hook), 0o755);
    }
    const inspection = await host.inspect(repository);
    await host.readFile(repository, inspection.headSha, ".facility.yml");
    await host.snapshot(repository, inspection.headSha);
    expect(existsSync(marker)).toBe(false);
  });

  it("reads committed files at a pinned commit, ignoring later and uncommitted changes", async () => {
    const repository = await createRepository(join(root, "pinned"));
    const pinned = (await git(repository, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(repository, ".facility.yml"), "changed: later\n");
    await commitAll(repository, "later");
    await writeFile(join(repository, ".facility.yml"), "uncommitted: true\n");
    await writeFile(join(repository, "untracked.txt"), "local only\n");
    expect(await host.readFile(repository, pinned, ".facility.yml")).toBe("version: 1\n");
    expect(await host.readFile(repository, pinned, "missing.yml")).toBeUndefined();
    await expectCode(
      host.readFile(repository, "not-a-sha", ".facility.yml"),
      "local_repository_revision_invalid",
      400,
    );
  });

  it("returns symlinks as text instead of following them on the host", async () => {
    const repository = await createRepository(join(root, "links"));
    await mkdir(join(repository, ".agents"), { recursive: true });
    await symlink("/etc/passwd", join(repository, ".agents", "builder.md"));
    await symlink("/etc/passwd", join(repository, "linked.yml"));
    const head = await commitAll(repository, "links");
    const files = await host.files(repository, head, [".agents"]);
    expect(files.get(".agents/builder.md")).toBe("/etc/passwd");
    expect(await host.readFile(repository, head, "linked.yml")).toBeUndefined();
  });

  it("bounds configuration reads", async () => {
    const repository = await createRepository(join(root, "large"));
    await writeFile(join(repository, "big.yml"), "x".repeat(10_000));
    const head = await commitAll(repository, "big");
    await expectCode(
      host.readFile(repository, head, "big.yml"),
      "local_repository_file_too_large",
      413,
    );
  });

  it("snapshots committed history without writing to the source repository", async () => {
    const repository = await createRepository(join(root, "snapshot"));
    const pinned = (await git(repository, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(repository, "later.txt"), "later\n");
    await commitAll(repository, "later");
    await writeFile(join(repository, "dirty.txt"), "uncommitted\n");
    const refsBefore = await git(repository, ["for-each-ref"]);
    const statusBefore = await git(repository, ["status", "--porcelain", "--untracked-files=all"]);

    const bundle = await host.snapshot(repository, pinned);
    const file = join(base, "snapshot.bundle");
    await writeFile(file, bundle);
    const clone = join(base, "snapshot-clone");
    await git(base, ["init", "-q", clone]);
    await git(clone, ["fetch", "-q", file, "refs/facility/import:refs/heads/imported"]);
    expect((await git(clone, ["rev-parse", "imported"])).trim()).toBe(pinned);
    expect(await git(clone, ["ls-tree", "-r", "--name-only", "imported"])).not.toMatch(
      /later|dirty/,
    );
    expect(await git(repository, ["for-each-ref"])).toBe(refsBefore);
    expect(await git(repository, ["status", "--porcelain", "--untracked-files=all"])).toBe(
      statusBefore,
    );
    const limited = new LocalRepositoryHost({ roots: [root], maxSnapshotBytes: 16 });
    await expectCode(
      limited.snapshot(repository, pinned),
      "local_repository_snapshot_too_large",
      413,
    );
  });

  it("refuses a registered path that is later replaced by a symlink elsewhere", async () => {
    const repository = await createRepository(join(root, "replaced"));
    const inspection = await host.inspect(repository);
    await rename(repository, join(root, "replaced-original"));
    await symlink(join(outside, "secret"), repository);
    await expectCode(host.verify(inspection.path), "local_repository_outside_roots", 403);
    await rm(repository);
    await symlink(join(root, "replaced-original"), repository);
    await expectCode(host.verify(inspection.path), "local_repository_path_changed", 409);
    await expectCode(host.resolve(inspection.path, "main"), "local_repository_path_changed", 409);
  });

  it("warns about submodules and Git LFS content it cannot import", async () => {
    const repository = await createRepository(join(root, "unsupported"));
    await writeFile(
      join(repository, ".gitattributes"),
      "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
    await writeFile(
      join(repository, ".gitmodules"),
      '[submodule "vendor/lib"]\n\tpath = vendor/lib\n\turl = ../lib\n',
    );
    await git(repository, [
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${(await git(repository, ["rev-parse", "HEAD"])).trim()},vendor/lib`,
    ]);
    await git(repository, ["add", ".gitattributes", ".gitmodules"]);
    await git(repository, [
      "-c",
      "user.name=Facility Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "-m",
      "unsupported",
    ]);
    const inspection = await host.inspect(repository);
    expect(inspection.warnings.join(" ")).toMatch(/Submodules/);
    expect(inspection.warnings.join(" ")).toMatch(/LFS/);
  });

  it("lists paths without reading file content", async () => {
    const repository = join(root, "app");
    const head = (await git(repository, ["rev-parse", "HEAD"])).trim();
    expect(await host.paths(repository, head)).toEqual([".facility.yml", "README.md"]);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe("# app\n");
  });
});

async function expectCode(promise: Promise<unknown>, code: string, status: number) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LocalRepositoryError);
  expect(error).toMatchObject({ code, statusCode: status });
}

async function createRepository(path: string) {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-q", "-b", "main"]);
  await writeFile(join(path, "README.md"), "# app\n");
  await writeFile(join(path, ".facility.yml"), "version: 1\n");
  await commitAll(path, "initial");
  return path;
}

async function commitAll(path: string, message: string) {
  await git(path, ["add", "-A"]);
  await git(path, [
    "-c",
    "user.name=Facility Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "--no-verify",
    "-m",
    message,
  ]);
  return (await git(path, ["rev-parse", "HEAD"])).trim();
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout);
    });
  });
}
