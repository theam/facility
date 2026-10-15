import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { isSafeGitBranch } from "../workspaces/git-branch.js";

/** Local repository access is disabled until an operator approves at least one root. */
export type LocalRepositoryOptions = {
  roots: string[];
  /** Owners allowed for registered paths; defaults to the Facility process owner. */
  ownerUids?: number[];
  maxSnapshotBytes?: number;
  maxFileBytes?: number;
  gitTimeoutMs?: number;
};

export type LocalRepositoryInspection = {
  path: string;
  defaultBranch: string;
  headSha: string;
  bare: boolean;
  warnings: string[];
};

export type LocalTreeEntry = { mode: string; type: string; oid: string; path: string };

export class LocalRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "LocalRepositoryError";
  }
}

const DEFAULT_MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Read-only access to Git repositories on the machine running Facility.
 *
 * Every operation re-validates the stored canonical path against the approved
 * roots, so a path replaced by a symlink after registration is refused. Git runs
 * with system/global configuration ignored, hooks and fsmonitor disabled, and
 * replace objects ignored; Facility never writes to the source repository.
 */
export class LocalRepositoryHost {
  private readonly roots: string[];
  private readonly ownerUids: number[] | undefined;
  private readonly maxSnapshotBytes: number;
  private readonly maxFileBytes: number;
  private readonly gitTimeoutMs: number;

  constructor(options: LocalRepositoryOptions) {
    for (const root of options.roots) {
      if (!isAbsolute(root) || root.includes("\0")) {
        throw new LocalRepositoryError(
          "local_repository_root_invalid",
          "Local repository roots must be absolute paths",
          500,
        );
      }
    }
    this.roots = [...options.roots];
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    this.ownerUids = options.ownerUids ?? (uid === undefined ? undefined : [uid]);
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.gitTimeoutMs = options.gitTimeoutMs ?? 120_000;
  }

  get enabled() {
    return this.roots.length > 0;
  }

  /** Validates a user-supplied path for registration. Nothing is executed from the repository. */
  async inspect(inputPath: string, requestedBranch?: string): Promise<LocalRepositoryInspection> {
    this.assertEnabled();
    const path = await this.canonical(inputPath);
    const bare = await this.assertRepositoryRoot(path);
    const defaultBranch = requestedBranch ?? (await this.currentBranch(path));
    if (!isSafeGitBranch(defaultBranch)) {
      throw new LocalRepositoryError(
        "local_repository_branch_invalid",
        "The default branch name is not a valid Git branch",
      );
    }
    const headSha = await this.resolveBranch(path, defaultBranch);
    return { path, defaultBranch, headSha, bare, warnings: await this.warnings(path, headSha) };
  }

  /** Re-checks a registered path before any read. */
  async verify(storedPath: string): Promise<string> {
    this.assertEnabled();
    const path = await this.canonical(storedPath);
    if (path !== storedPath) {
      throw new LocalRepositoryError(
        "local_repository_path_changed",
        "The registered repository path now resolves to a different location; register it again",
        409,
      );
    }
    await this.assertRepositoryRoot(path);
    return path;
  }

  async resolve(storedPath: string, branch: string): Promise<string> {
    const path = await this.verify(storedPath);
    return this.resolveBranch(path, branch);
  }

  async readFile(storedPath: string, commit: string, file: string): Promise<string | undefined> {
    const path = await this.verify(storedPath);
    assertCommit(commit);
    const entry = (await this.tree(path, commit, [file])).find((item) => item.path === file);
    if (entry?.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      return undefined;
    }
    return this.blob(path, entry.oid);
  }

  /** Lists regular files and symlinks under the given tree prefixes at a pinned commit. */
  async files(
    storedPath: string,
    commit: string,
    prefixes: string[],
    include: (path: string) => boolean = () => true,
  ) {
    const path = await this.verify(storedPath);
    assertCommit(commit);
    const entries = await this.tree(path, commit, prefixes);
    const files = new Map<string, string>();
    for (const entry of entries) {
      // Symlinks are returned as their target text, never followed on the host.
      if (entry.type !== "blob" || !include(entry.path)) continue;
      files.set(entry.path, await this.blob(path, entry.oid));
    }
    return files;
  }

  /** Paths of files at a pinned commit, without reading their content. */
  async paths(storedPath: string, commit: string, prefixes: string[] = []) {
    const path = await this.verify(storedPath);
    assertCommit(commit);
    return (await this.tree(path, commit, prefixes))
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path);
  }

  /**
   * Packages the complete history reachable from `commit` as a Git bundle whose
   * only ref is refs/facility/import. The copy happens in a Facility-owned
   * staging repository; the source repository is only read.
   */
  async snapshot(storedPath: string, commit: string): Promise<Buffer> {
    const path = await this.verify(storedPath);
    assertCommit(commit);
    const stage = await mkdtemp(join(tmpdir(), "facility-local-snapshot-"));
    try {
      const repository = join(stage, "repository.git");
      const bundle = join(stage, "snapshot.bundle");
      await this.git(stage, ["init", "--bare", "--quiet", "--template=", repository]);
      await this.git(repository, [
        "-c",
        `safe.directory=${path}`,
        // Only this Facility-initiated fetch of a validated path may use the file transport.
        "-c",
        "protocol.file.allow=always",
        "-c",
        "protocol.version=2",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        path,
        `${commit}:refs/facility/import`,
      ]);
      await this.git(repository, ["bundle", "create", "--quiet", bundle, "refs/facility/import"]);
      const size = (await stat(bundle)).size;
      if (size > this.maxSnapshotBytes) {
        throw new LocalRepositoryError(
          "local_repository_snapshot_too_large",
          `The repository snapshot is ${size} bytes, above the ${this.maxSnapshotBytes} byte limit`,
          413,
        );
      }
      return await readFile(bundle);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  /**
   * Content the first import cannot represent faithfully yet. Both probes stay
   * bounded on very large repositories: neither lists the whole tree.
   */
  async warnings(storedPath: string, commit: string) {
    const path = await this.verify(storedPath);
    assertCommit(commit);
    const warnings: string[] = [];
    if ((await this.tree(path, commit, [".gitmodules"])).length > 0) {
      warnings.push(
        "Submodules are not imported. Their directories appear empty in Facility workspaces.",
      );
    }
    const lfs = await this.git(path, [
      "grep",
      "-l",
      "-e",
      "filter=lfs",
      commit,
      "--",
      ".gitattributes",
      "**/.gitattributes",
    ]).catch(() => "");
    if (lfs.trim()) {
      warnings.push(
        "Git LFS content is not imported. LFS files appear as pointer files in Facility workspaces.",
      );
    }
    return warnings;
  }

  private assertEnabled() {
    if (!this.enabled) {
      throw new LocalRepositoryError(
        "local_repositories_disabled",
        "Local repositories are disabled. Set FACILITY_LOCAL_REPOSITORY_ROOTS to the directories Facility may read.",
        403,
      );
    }
  }

  private async canonical(inputPath: string) {
    if (
      typeof inputPath !== "string" ||
      inputPath.length === 0 ||
      inputPath.length > 4_096 ||
      inputPath.includes("\0") ||
      !isAbsolute(inputPath) ||
      inputPath.split(/[\\/]/).includes("..")
    ) {
      throw new LocalRepositoryError(
        "local_repository_path_invalid",
        "Provide an absolute repository path without '..' segments",
      );
    }
    let path: string;
    try {
      path = await realpath(inputPath);
    } catch {
      throw new LocalRepositoryError(
        "local_repository_not_found",
        "No directory exists at that path on the Facility host",
        404,
      );
    }
    await this.assertInsideRoots(path);
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new LocalRepositoryError(
        "local_repository_not_directory",
        "The repository path is not a directory",
      );
    }
    if (this.ownerUids && !this.ownerUids.includes(info.uid)) {
      throw new LocalRepositoryError(
        "local_repository_owner_untrusted",
        "The repository is owned by a user Facility is not configured to trust",
        403,
      );
    }
    return path;
  }

  private async assertInsideRoots(path: string) {
    for (const root of this.roots) {
      const canonicalRoot = await realpath(root).catch(() => undefined);
      if (canonicalRoot && isInside(canonicalRoot, path)) return;
    }
    throw new LocalRepositoryError(
      "local_repository_outside_roots",
      "The repository is outside the directories approved for Facility",
      403,
    );
  }

  private async assertRepositoryRoot(path: string) {
    let bare: boolean;
    try {
      bare = (await this.git(path, ["rev-parse", "--is-bare-repository"])).trim() === "true";
    } catch {
      throw new LocalRepositoryError(
        "local_repository_not_git",
        "The path is not a Git repository",
      );
    }
    if (!bare) {
      const top = await realpath(
        (await this.git(path, ["rev-parse", "--show-toplevel"])).trim(),
      ).catch(() => "");
      if (top !== path) {
        throw new LocalRepositoryError(
          "local_repository_not_root",
          "Register the repository's top-level directory",
        );
      }
    }
    // Worktrees and gitfiles may point elsewhere; the object store must be approved too.
    for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
      const value = (await this.git(path, ["rev-parse", flag])).trim();
      const directory = await realpath(isAbsolute(value) ? value : join(path, value)).catch(
        () => "",
      );
      if (!directory) {
        throw new LocalRepositoryError(
          "local_repository_not_git",
          "The Git directory is not available",
        );
      }
      await this.assertInsideRoots(directory);
    }
    return bare;
  }

  private async currentBranch(path: string) {
    try {
      return (await this.git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    } catch {
      throw new LocalRepositoryError(
        "local_repository_branch_required",
        "HEAD is detached; pass the branch Facility should use as the default branch",
      );
    }
  }

  private async resolveBranch(path: string, branch: string) {
    if (!isSafeGitBranch(branch)) {
      throw new LocalRepositoryError(
        "local_repository_branch_invalid",
        "The default branch name is not a valid Git branch",
      );
    }
    try {
      const sha = (
        await this.git(path, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])
      ).trim();
      if (SHA.test(sha)) return sha;
    } catch {
      // Distinguish an empty repository from a missing branch below.
    }
    const heads = await this.git(path, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "refs/heads",
    ]).catch(() => "");
    if (!heads.trim()) {
      throw new LocalRepositoryError(
        "local_repository_empty",
        "The repository has no commits yet. Create an initial commit, then register it again.",
      );
    }
    throw new LocalRepositoryError(
      "local_repository_branch_not_found",
      `Branch ${branch} does not exist in the repository`,
    );
  }

  private async tree(path: string, commit: string, prefixes: string[]): Promise<LocalTreeEntry[]> {
    const output = await this.git(path, [
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      commit,
      ...(prefixes.length ? ["--", ...prefixes] : []),
    ]);
    return output
      .split("\0")
      .filter(Boolean)
      .flatMap((line) => {
        const tab = line.indexOf("\t");
        const [mode, type, oid] = line.slice(0, tab).split(" ");
        const entryPath = line.slice(tab + 1);
        return tab > 0 && mode && type && oid ? [{ mode, type, oid, path: entryPath }] : [];
      });
  }

  private async blob(path: string, oid: string) {
    const size = Number((await this.git(path, ["cat-file", "-s", oid])).trim());
    if (!Number.isFinite(size) || size > this.maxFileBytes) {
      throw new LocalRepositoryError(
        "local_repository_file_too_large",
        `A configuration file is larger than ${this.maxFileBytes} bytes`,
        413,
      );
    }
    return this.git(path, ["cat-file", "blob", oid]);
  }

  private git(cwd: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          `safe.directory=${cwd}`,
          ...args,
        ],
        {
          cwd,
          env: hardenedGitEnvironment(),
          encoding: "utf8",
          maxBuffer: this.maxFileBytes * 4 + 64 * 1024 * 1024,
          timeout: this.gitTimeoutMs,
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new LocalRepositoryError(
                "local_repository_git_failed",
                stderr.trim().split("\n").at(-1) || `git ${args[0]} failed`,
                409,
              ),
            );
          } else resolve(stdout);
        },
      );
    });
  }
}

/** Parses FACILITY_LOCAL_REPOSITORY_ROOTS: absolute paths separated by the platform delimiter. */
export function parseLocalRepositoryRoots(value: string | undefined) {
  return (value ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((root) => root.trim())
    .filter(Boolean);
}

export function isInside(root: string, path: string) {
  const difference = relative(root, path);
  return (
    difference === "" ||
    (difference !== ".." && !difference.startsWith(`..${sep}`) && !isAbsolute(difference))
  );
}

function assertCommit(commit: string) {
  if (!SHA.test(commit)) {
    throw new LocalRepositoryError("local_repository_revision_invalid", "Invalid commit id");
  }
}

function hardenedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: tmpdir(),
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_PROTOCOL_FROM_USER: "0",
  };
}
