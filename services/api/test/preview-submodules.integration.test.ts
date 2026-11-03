import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { newId, type PreviewGenerationRepository } from "@facility/core";
import { type FacilityDb, stories, workspaces } from "@facility/db";
import Docker from "dockerode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GithubWorkspaceCredentialBroker,
  GithubWorkspaceCredentials,
} from "../src/github/workspace-credentials.js";
import type { StoryPreviewConvergenceService } from "../src/stories/preview-convergence.js";
import {
  PreviewWorkspaceGitApplicator,
  StoryPreviewConvergenceExecutor,
} from "../src/stories/preview-convergence-executor.js";
import { previewSourceFingerprint } from "../src/stories/preview-submodules.js";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { previewBranchRefs } from "../src/workspaces/preview-branch.js";
import {
  ProjectEnvironmentService,
  type ProjectManifestSource,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";
import type { WorkspaceCommand } from "../src/workspaces/runtime.js";

const execFile = promisify(execFileCallback);

describe("complete previews with connected Git submodules", () => {
  let root: string;
  let runtime: FakeWorkspaceRuntime;
  let workspace: Awaited<ReturnType<FakeWorkspaceRuntime["create"]>>;
  let parent: string;
  let child: string;
  let rawChild: string;
  let childSource: string;
  let parentHead: string;
  let childBase: string;
  let childHead: string;
  const credentials: GithubWorkspaceCredentials = {
    repositories: [
      { owner: "acme", name: "parent", defaultBranch: "main", role: "primary" },
      { owner: "acme", name: "client", defaultBranch: "main", role: "related" },
    ],
    environment: {},
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    gitIdentity: { name: "Facility Test", email: "facility@example.test" },
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "facility-preview-submodules-"));
    const childRemote = join(root, "client.git");
    const parentRemote = join(root, "parent.git");
    childSource = join(root, "client-source");
    const parentSource = join(root, "parent-source");
    for (const [remote, source] of [
      [childRemote, childSource],
      [parentRemote, parentSource],
    ] as const) {
      await git(root, ["init", "--bare", "--initial-branch=main", remote]);
      await git(root, ["clone", remote, source]);
      await git(source, ["config", "user.name", "Facility Test"]);
      await git(source, ["config", "user.email", "facility@example.test"]);
      await writeFile(join(source, "README.md"), "base\n");
      await git(source, ["add", "."]);
      await git(source, ["commit", "-m", "base"]);
      await git(source, ["push", "origin", "main"]);
    }
    childBase = await git(childSource, ["rev-parse", "HEAD"]);
    await git(parentSource, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      childRemote,
      "client",
    ]);
    await git(parentSource, [
      "config",
      "-f",
      ".gitmodules",
      "submodule.client.url",
      "https://github.com/acme/client.git",
    ]);
    await writeFile(join(parentSource, ".gitignore"), "data/\n");
    await git(parentSource, ["add", "."]);
    await git(parentSource, ["commit", "-m", "pin client"]);
    await git(parentSource, ["push", "origin", "main"]);
    await git(parentSource, ["switch", "-c", "feature/story"]);
    await writeFile(join(parentSource, "plan.md"), "reviewed plan\n");
    await git(parentSource, ["add", "plan.md"]);
    await git(parentSource, ["commit", "-m", "plan"]);
    parentHead = await git(parentSource, ["rev-parse", "HEAD"]);
    await git(parentSource, ["push", "origin", "feature/story"]);
    await git(childSource, ["switch", "-c", "feature/client"]);
    await writeFile(join(childSource, "feature.txt"), "required child\n");
    await git(childSource, ["add", "."]);
    await git(childSource, ["commit", "-m", "client feature"]);
    childHead = await git(childSource, ["rev-parse", "HEAD"]);
    await git(childSource, ["push", "origin", "feature/client"]);

    runtime = new FakeWorkspaceRuntime(join(root, "runtime"));
    workspace = await runtime.create({ id: newId("ws"), image: "facility:test" });
    const repos = join(workspace.volumeRef, "repos/acme");
    await mkdir(repos, { recursive: true });
    await git(repos, ["clone", parentRemote, "parent"]);
    await git(repos, ["clone", childRemote, "client"]);
    parent = join(repos, "parent");
    rawChild = join(repos, "client");
    child = join(parent, "client");
    await git(parent, ["switch", "feature/story"]);
    await git(parent, ["config", "submodule.client.url", childRemote]);
    await git(parent, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    await git(child, ["fetch", "origin", "feature/client"]);
    await git(child, ["switch", "-c", "feature/client", childHead]);
    await mkdir(join(parent, "data"));
    await writeFile(join(parent, "data/control.json"), '{"edited":"keep me"}\n');
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  function targets(includeChild = true): PreviewGenerationRepository[] {
    const result: PreviewGenerationRepository[] = [
      {
        repositoryId: "repo_parent",
        repository: "acme/parent",
        pullNumber: 1,
        headRef: "feature/story",
        headSha: parentHead,
        primary: true,
      },
    ];
    if (includeChild)
      result.push({
        repositoryId: "repo_client",
        repository: "acme/client",
        pullNumber: 2,
        headRef: "feature/client",
        headSha: childHead,
        primary: false,
      });
    return result;
  }

  it("composes the child head where the parent builds without changing work branches or retained data", async () => {
    expect(await git(rawChild, ["rev-parse", "HEAD"])).toBe(childBase);
    expect(await git(parent, ["status", "--porcelain"])).toBe("M client");
    const sources = await new PreviewWorkspaceGitApplicator(runtime).apply({
      workspace,
      credentials,
      repositories: targets(),
    });
    expect(await git(child, ["rev-parse", "HEAD"])).toBe(childHead);
    expect(await git(rawChild, ["rev-parse", "HEAD"])).toBe(childHead);
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(parent, ["ls-tree", "HEAD", "client"])).toContain(childBase);
    expect(sources.find((source) => source.cwd === "repos/acme/parent")?.submodules).toEqual([
      { path: "client", repository: "acme/client", pinnedSha: childBase, headSha: childHead },
    ]);
    expect(await git(parent, ["status", "--porcelain", "--untracked-files=no"])).toBe("M client");
    expect(await git(parent, ["rev-parse", "feature/story"])).toBe(parentHead);
    expect(await git(parent, ["ls-tree", "feature/story", "client"])).toContain(childBase);
    expect(await git(child, ["rev-parse", "feature/client"])).toBe(childHead);
    expect(await readFile(join(parent, "plan.md"), "utf8")).toBe("reviewed plan\n");
    expect(await readFile(join(parent, "data/control.json"), "utf8")).toBe(
      '{"edited":"keep me"}\n',
    );
  });

  it.each([
    "squash",
    "rebase",
  ] as const)("keeps later child changes after a %s integration while preserving the parent's publication pin", async (method) => {
    await git(childSource, ["switch", "main"]);
    await writeFile(join(childSource, "parallel.txt"), "independent base change\n");
    await git(childSource, ["add", "."]);
    await git(childSource, ["commit", "-m", "advance child base"]);
    if (method === "squash") {
      await git(childSource, ["merge", "--squash", "feature/client"]);
      await git(childSource, ["commit", "-m", "integrate child feature"]);
    } else {
      await git(childSource, ["cherry-pick", childHead]);
    }
    const integrated = await git(childSource, ["rev-parse", "HEAD"]);
    expect(integrated).not.toBe(childHead);
    await writeFile(join(childSource, "feature.txt"), "later reviewed child improvement\n");
    await git(childSource, ["add", "."]);
    await git(childSource, ["commit", "-m", "improve integrated child feature"]);
    const currentBase = await git(childSource, ["rev-parse", "HEAD"]);
    await git(childSource, ["push", "origin", "main"]);
    const resolveIntegration = vi.fn(async (target: PreviewGenerationRepository) =>
      target.repository === "acme/client" ? integrated : null,
    );
    const applicator = new PreviewWorkspaceGitApplicator(runtime, undefined, resolveIntegration);
    const sources = await applicator.apply({ workspace, credentials, repositories: targets() });
    await applicator.verify(workspace, sources, credentials.environment);
    expect(resolveIntegration).toHaveBeenCalledWith(targets()[1]);
    expect(await git(child, ["rev-parse", "HEAD"])).toBe(currentBase);
    expect(await git(rawChild, ["rev-parse", "HEAD"])).toBe(currentBase);
    expect(await readFile(join(child, "feature.txt"), "utf8")).toBe(
      "later reviewed child improvement\n",
    );
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(parent, ["ls-tree", "HEAD", "client"])).toContain(childBase);
    expect(await git(parent, ["ls-tree", "feature/story", "client"])).toContain(childBase);
    expect(await git(child, ["rev-parse", "feature/client"])).toBe(childHead);
    expect(await readFile(join(parent, "data/control.json"), "utf8")).toContain("keep me");
  });

  it("restores the parent's pin when a child PR is removed from the complete set", {
    timeout: 15_000,
  }, async () => {
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await applicator.apply({ workspace, credentials, repositories: targets() });
    await applicator.apply({ workspace, credentials, repositories: targets(false) });
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(child, ["rev-parse", "HEAD"])).toBe(childBase);
    expect(await git(parent, ["ls-tree", "HEAD", "client"])).toContain(childBase);
    expect(await git(child, ["rev-parse", "feature/client"])).toBe(childHead);
    expect(await readFile(join(parent, "data/control.json"), "utf8")).toContain("keep me");
  });

  it("preserves staged parent gitlinks and uncommitted child code instead of treating them as an override", async () => {
    await writeFile(join(child, "README.md"), "uncommitted child work\n");
    await git(parent, ["add", "client"]);
    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: targets(),
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(parent, ["ls-files", "--stage", "client"])).toContain(childHead);
    expect(await readFile(join(child, "README.md"), "utf8")).toBe("uncommitted child work\n");
  });

  it("does not overwrite tracked edits inside an unstaged child", async () => {
    await writeFile(join(child, "README.md"), "save this work\n");
    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: targets(),
      }),
    ).rejects.toMatchObject({ code: "preview_dirty_worktree", retryable: false });
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(rawChild, ["rev-parse", "HEAD"])).toBe(childBase);
    expect(await readFile(join(child, "README.md"), "utf8")).toBe("save this work\n");
  });

  it.each([
    "symlink",
    "gitdir",
    "commondir",
    "uninitialized",
  ])("refuses an unsafe %s checkout before changing branches", async (kind) => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "control"), "untouched");
    if (kind === "symlink") {
      await rename(child, `${child}-retained`);
      await symlink(outside, child);
    } else if (kind === "gitdir") {
      await writeFile(join(child, ".git"), `gitdir: ${outside}\n`);
    } else if (kind === "commondir") {
      const directory = await git(child, ["rev-parse", "--absolute-git-dir"]);
      await writeFile(join(directory, "commondir"), `${outside}\n`);
    } else {
      await rename(join(child, ".git"), join(child, ".git-retained"));
    }
    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: targets(),
      }),
    ).rejects.toMatchObject({ code: "preview_submodule_checkout_unsafe", retryable: false });
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(rawChild, ["rev-parse", "HEAD"])).toBe(childBase);
    expect(await readFile(join(outside, "control"), "utf8")).toBe("untouched");
  });

  it("replaces a required child head without keeping substituted code or losing edited data", {
    timeout: 15_000,
  }, async () => {
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await applicator.apply({ workspace, credentials, repositories: targets() });
    const previous = childHead;
    await rm(join(childSource, "feature.txt"));
    await writeFile(join(childSource, "replacement.txt"), "new required source\n");
    await git(childSource, ["add", "."]);
    await git(childSource, ["commit", "-m", "replace feature"]);
    childHead = await git(childSource, ["rev-parse", "HEAD"]);
    await git(childSource, ["push", "origin", "feature/client"]);
    await applicator.apply({ workspace, credentials, repositories: targets() });
    expect(await git(child, ["rev-parse", "HEAD"])).toBe(childHead);
    expect(await git(parent, ["ls-tree", "HEAD", "client"])).toContain(childBase);
    await expect(readFile(join(child, "feature.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(child, "replacement.txt"), "utf8")).toBe("new required source\n");
    expect(
      await git(child, ["for-each-ref", "--format=%(objectname)", "refs/facility/retained"]),
    ).toContain(previous);
    expect(await readFile(join(parent, "data/control.json"), "utf8")).toContain("keep me");
  });

  it("verifies the actual nested sources again after a preparation hook changes them", {
    timeout: 15_000,
  }, async () => {
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    const sources = await applicator.apply({ workspace, credentials, repositories: targets() });
    await applicator.verify(workspace, sources, {});
    await git(child, ["checkout", "--detach", childBase]);
    await expect(applicator.verify(workspace, sources, {})).rejects.toMatchObject({
      code: "preview_generation_verification_failed",
      retryable: false,
    });
  });

  it("keeps the branch-in-use protection for a linked submodule worktree", {
    timeout: 15_000,
  }, async () => {
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await applicator.apply({ workspace, credentials, repositories: targets() });
    const preview = previewBranchRefs(workspace.id, "repos/acme/parent/client");
    await git(child, ["switch", "feature/client"]);
    const other = join(root, "other-client");
    await git(child, ["worktree", "add", other, preview.branch]);
    await expect(
      applicator.apply({ workspace, credentials, repositories: targets() }),
    ).rejects.toMatchObject({ code: "preview_branch_in_use", retryable: false });
    expect(await git(other, ["rev-parse", "HEAD"])).toBe(childHead);
    expect(await git(child, ["branch", "--show-current"])).toBe("feature/client");
  });

  it("composes nested connected children and rejects a cyclic candidate", {
    timeout: 25_000,
  }, async () => {
    const remote = join(root, "lib.git");
    const source = join(root, "lib-source");
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    await git(root, ["clone", remote, source]);
    await git(source, ["config", "user.name", "Facility Test"]);
    await git(source, ["config", "user.email", "facility@example.test"]);
    await writeFile(join(source, "lib.txt"), "base\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "base library"]);
    const libBase = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "main"]);
    await git(childSource, ["-c", "protocol.file.allow=always", "submodule", "add", remote, "lib"]);
    await git(childSource, ["config", "-f", ".gitmodules", "submodule.lib.url", "../lib.git"]);
    await git(childSource, ["add", "."]);
    await git(childSource, ["commit", "-m", "pin library"]);
    childHead = await git(childSource, ["rev-parse", "HEAD"]);
    await git(childSource, ["push", "origin", "feature/client"]);
    for (const checkout of [child, rawChild]) {
      await git(checkout, ["fetch", "origin", "feature/client"]);
      await git(checkout, ["checkout", "--detach", childHead]);
      await git(checkout, ["config", "submodule.lib.url", remote]);
      await git(checkout, ["-c", "protocol.file.allow=always", "submodule", "update", "--init"]);
    }
    await git(source, ["switch", "-c", "feature/lib"]);
    await writeFile(join(source, "lib.txt"), "required library\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "library feature"]);
    const libHead = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "feature/lib"]);
    await git(join(workspace.volumeRef, "repos/acme"), ["clone", remote, "lib"]);
    const scoped = {
      ...credentials,
      repositories: [
        ...credentials.repositories,
        { owner: "acme", name: "lib", defaultBranch: "main", role: "related" as const },
      ],
    };
    const required: PreviewGenerationRepository[] = [
      ...targets(),
      {
        repositoryId: "repo_lib",
        repository: "acme/lib",
        pullNumber: 3,
        headRef: "feature/lib",
        headSha: libHead,
        primary: false,
      },
    ];
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    const sources = await applicator.apply({
      workspace,
      credentials: scoped,
      repositories: required,
    });
    await applicator.verify(workspace, sources, {});
    expect(await git(join(child, "lib"), ["rev-parse", "HEAD"])).toBe(libHead);
    expect(await readFile(join(child, "lib/lib.txt"), "utf8")).toBe("required library\n");
    expect(await git(child, ["ls-tree", "HEAD", "lib"])).toContain(libBase);
    expect(await git(parent, ["ls-tree", "feature/story", "client"])).toContain(childBase);

    await git(source, ["update-index", "--add", "--cacheinfo", `160000,${parentHead},parent`]);
    await writeFile(
      join(source, ".gitmodules"),
      '[submodule "parent"]\n\tpath = parent\n\turl = ../parent.git\n',
    );
    await git(source, ["add", ".gitmodules"]);
    await git(source, ["commit", "-m", "cyclic topology"]);
    await git(source, ["push", "origin", "feature/lib"]);
    const cyclicHead = await git(source, ["rev-parse", "HEAD"]);
    const current = await git(parent, ["rev-parse", "HEAD"]);
    await expect(
      applicator.apply({
        workspace,
        credentials: scoped,
        repositories: required.map((target) =>
          target.repository === "acme/lib" ? { ...target, headSha: cyclicHead } : target,
        ),
      }),
    ).rejects.toMatchObject({ code: "preview_submodule_topology_invalid", retryable: false });
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(current);
  });

  it("composes a portable workspace and retains edited data across compute suspension", {
    timeout: 90_000,
  }, async () => {
    const portable =
      process.env.FACILITY_E2E_DOCKER === "1"
        ? new DockerWorkspaceRuntime(new Docker())
        : new FakeWorkspaceRuntime(join(root, "portable-runtime"));
    const retained = await portable.create({
      id: newId("ws"),
      image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:dev",
    });
    const run = async (command: WorkspaceCommand) => {
      const result = await portable.exec(retained, command);
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const copy = async (cwd: string, names: string[], into = ".") => {
      const tar = await execFile("tar", ["-C", cwd, "-cf", "-", ...names], {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      });
      await run({
        command: "node",
        args: [
          "-e",
          "const fs=require('node:fs'),cp=require('node:child_process');const r=cp.spawnSync('tar',['-xf','-'],{input:Buffer.from(fs.readFileSync(0,'utf8'),'base64'),stdio:['pipe','inherit','inherit']});process.exit(r.status??1)",
        ],
        cwd: into,
        stdin: tar.stdout.toString("base64"),
      });
    };
    try {
      // Only synthetic fixture repositories cross into this disposable runtime.
      // The provider's own .facility state is never overwritten by the copy.
      await copy(workspace.volumeRef, ["repos"]);
      await run({ command: "mkdir", args: ["-p", ".preview-test-remotes"] });
      await copy(root, ["parent.git", "client.git"], ".preview-test-remotes");
      const directory = await run({ command: "pwd" });
      for (const [cwd, name] of [
        ["repos/acme/parent", "parent"],
        ["repos/acme/client", "client"],
        ["repos/acme/parent/client", "client"],
      ] as const)
        await run({
          command: "git",
          args: ["remote", "set-url", "origin", `${directory}/.preview-test-remotes/${name}.git`],
          cwd,
        });
      const applicator = new PreviewWorkspaceGitApplicator(portable);
      const sources = await applicator.apply({
        workspace: retained,
        credentials,
        repositories: targets(),
      });
      await applicator.verify(retained, sources, {});
      expect(
        await run({ command: "git", args: ["rev-parse", "HEAD"], cwd: "repos/acme/parent/client" }),
      ).toBe(childHead);
      expect(
        await run({
          command: "git",
          args: ["ls-tree", "HEAD", "client"],
          cwd: "repos/acme/parent",
        }),
      ).toContain(childBase);
      await run({
        command: "node",
        args: [
          "-e",
          "require('node:fs').writeFileSync('data/control.json','edited after preview')",
        ],
        cwd: "repos/acme/parent",
      });
      await portable.suspend(retained);
      Object.assign(retained, await portable.wake(retained));
      await applicator.verify(retained, sources, {});
      expect(
        await run({
          command: "node",
          args: [
            "-e",
            "process.stdout.write(require('node:fs').readFileSync('data/control.json','utf8'))",
          ],
          cwd: "repos/acme/parent",
        }),
      ).toBe("edited after preview");
    } finally {
      await portable.destroy(retained);
    }
  });

  it("hands a composed view to the next builder without publishing preview gitlinks or reseeding", {
    timeout: 25_000,
  }, async () => {
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    const sources = await applicator.apply({ workspace, credentials, repositories: targets() });
    const environment = new ProjectEnvironmentService(eventDatabase(), runtime);
    const manifest = buildManifest();
    const scope = { orgId: "org_test", projectId: "proj_test", workspace, credentials, manifest };
    const refreshed = await environment.refreshPrepared({
      ...scope,
      sourceFingerprint: previewSourceFingerprint(sources),
    });
    await environment.prepare({
      ...scope,
      branch: "feature/story",
      previousSetupChecksum: refreshed.setupChecksum,
    });
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(parent, ["branch", "--show-current"])).toBe("feature/story");
    expect(await git(parent, ["ls-tree", "HEAD", "client"])).toContain(childBase);
    expect(await git(child, ["rev-parse", "HEAD"])).toBe(childHead);
    expect(await readFile(join(parent, "data/built-child.txt"), "utf8")).toContain(childHead);
    expect(await readFile(join(parent, "data/control.json"), "utf8")).toContain("keep me");
  });

  it("rebuilds when a nested override is withdrawn even if both independent heads stay unchanged", {
    timeout: 25_000,
  }, async () => {
    await git(childSource, ["switch", "main"]);
    await git(childSource, ["merge", "--ff-only", "feature/client"]);
    await git(childSource, ["push", "origin", "main"]);
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    const environment = new ProjectEnvironmentService(eventDatabase(), runtime);
    const input = {
      orgId: "org_test",
      projectId: "proj_test",
      workspace,
      credentials,
      manifest: buildManifest(),
    };
    const first = await applicator.apply({ workspace, credentials, repositories: targets() });
    const prepared = await environment.refreshPrepared({
      ...input,
      sourceFingerprint: previewSourceFingerprint(first),
    });
    expect(await readFile(join(parent, "data/built-child.txt"), "utf8")).toContain(childHead);
    const second = await applicator.apply({ workspace, credentials, repositories: targets(false) });
    expect(await git(parent, ["rev-parse", "HEAD"])).toBe(parentHead);
    expect(await git(rawChild, ["rev-parse", "HEAD"])).toBe(childHead);
    expect(previewSourceFingerprint(second)).not.toBe(previewSourceFingerprint(first));
    await environment.refreshPrepared({
      ...input,
      previousSetupChecksum: prepared.setupChecksum,
      sourceFingerprint: previewSourceFingerprint(second),
    });
    expect(await readFile(join(parent, "data/built-child.txt"), "utf8")).toContain(childBase);
    expect(await readFile(join(parent, "data/control.json"), "utf8")).toContain("keep me");
  });

  it("never publishes a healthy generation when setup restored an old child pin", {
    timeout: 15_000,
  }, async () => {
    const scope = { orgId: "org_test", projectId: "proj_test", storyId: "story_test" };
    const row = {
      id: workspace.id,
      state: "running",
      environment: { image: "facility:test" },
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const limit = async () =>
              table === stories
                ? [{ status: "review", deletedAt: null }]
                : table === workspaces
                  ? [row]
                  : [];
            return { limit, orderBy: () => ({ limit }) };
          },
        }),
      }),
    } as unknown as FacilityDb;
    const fail = vi.fn(async () => undefined);
    const complete = vi.fn(async () => ({ settled: true, superseded: false }));
    const convergence = {
      claim: async () => ({
        claimed: true,
        generation: "generation",
        leaseToken: "lease",
        repositories: targets(),
      }),
      bindCompute: async (_scope: unknown, _claim: unknown, wake: () => Promise<unknown>) => {
        await wake();
        return { computeRef: (await runtime.inspect(workspace)).computeRef };
      },
      renew: async () => new Date(Date.now() + 60_000),
      read: async () => ({ state: "blocked" }),
      fail,
      complete,
    } as unknown as StoryPreviewConvergenceService;
    const manifest = parseProjectManifest(
      "version: 1\nrepositories:\n  primary: github.com/acme/parent\nenvironment:\n  start: 'true'\n",
    );
    const environment = {
      refreshPrepared: async () => {
        await git(child, ["checkout", "--detach", childBase]);
        return { setupChecksum: "healthy", endpoints: [] };
      },
    } as unknown as ProjectEnvironmentService;
    const executor = new StoryPreviewConvergenceExecutor(
      db,
      runtime,
      { issue: async () => credentials } as unknown as GithubWorkspaceCredentialBroker,
      { load: async () => manifest } as unknown as ProjectManifestSource,
      environment,
      convergence,
    );
    expect(await executor.dispatch(scope)).toMatchObject({
      state: "blocked",
      code: "preview_generation_verification_failed",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        outcome: "blocked",
        code: "preview_generation_verification_failed",
      }),
      expect.any(Date),
    );
    expect(await readFile(join(parent, "data/control.json"), "utf8")).toContain("keep me");
  });
});

async function git(cwd: string, args: string[]) {
  const result = await execFile("git", args, { cwd });
  return result.stdout.trim();
}

function buildManifest() {
  return parseProjectManifest(
    "version: 1\nrepositories:\n  primary: github.com/acme/parent\n  related:\n    - github.com/acme/client\nenvironment:\n  setup: git -C client rev-parse HEAD > data/built-child.txt\n  seed: printf overwritten > data/control.json\n  start: 'true'\n",
  );
}

function eventDatabase(): FacilityDb {
  let sequence = 1;
  return {
    update: () => ({
      set: () => ({
        where: () =>
          Object.assign(Promise.resolve(), {
            returning: async () => [{ nextEventSeq: ++sequence }],
          }),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  } as unknown as FacilityDb;
}
