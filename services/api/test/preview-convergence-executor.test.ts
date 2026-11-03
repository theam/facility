import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { newId, type PreviewGenerationRepository } from "@facility/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";
import { PreviewWorkspaceGitApplicator } from "../src/stories/preview-convergence-executor.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { PREVIEW_MANAGED_REF, previewBranchRefs } from "../src/workspaces/preview-branch.js";

const execFile = promisify(execFileCallback);

describe("preview workspace Git application", () => {
  let root: string;
  let runtime: FakeWorkspaceRuntime;
  let workspace: Awaited<ReturnType<FakeWorkspaceRuntime["create"]>>;
  let remote: string;
  let source: string;
  let base: string;
  const credentials: GithubWorkspaceCredentials = {
    repositories: [{ owner: "acme", name: "app", defaultBranch: "main", role: "primary" as const }],
    environment: {},
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    gitIdentity: { name: "Facility Test", email: "facility@example.test" },
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "facility-preview-convergence-"));
    remote = join(root, "app.git");
    source = join(root, "source");
    await git(root, ["init", "--bare", "--initial-branch=main", remote]);
    await git(root, ["clone", remote, source]);
    await git(source, ["config", "user.name", "Facility Test"]);
    await git(source, ["config", "user.email", "facility@example.test"]);
    await writeFile(join(source, "README.md"), "base\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "base"]);
    await git(source, ["push", "origin", "main"]);
    base = await git(source, ["rev-parse", "HEAD"]);
    runtime = new FakeWorkspaceRuntime(join(root, "runtime"));
    workspace = await runtime.create({ id: newId("ws"), image: "facility:test" });
    await mkdir(join(workspace.volumeRef, "repos/acme"), { recursive: true });
    await git(join(workspace.volumeRef, "repos/acme"), ["clone", remote, "app"]);
    await git(join(workspace.volumeRef, "repos/acme/app"), [
      "config",
      "user.name",
      "Facility Test",
    ]);
    await git(join(workspace.volumeRef, "repos/acme/app"), [
      "config",
      "user.email",
      "facility@example.test",
    ]);
  });

  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("attaches an unchanged candidate to an owned local branch without moving or pushing work branches", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const preview = previewBranchRefs(workspace.id, "repos/acme/app");
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await applicator.apply({ workspace, credentials, repositories: [target(1, base)] });
    expect(await git(repository, ["branch", "--show-current"])).toBe(preview.branch);
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(base);
    expect(await git(repository, ["rev-parse", "main"])).toBe(base);
    expect(await git(repository, ["rev-parse", preview.ownershipRef])).toBe(base);
    await applicator.apply({ workspace, credentials, repositories: [target(1, base)] });
    expect(await git(repository, ["symbolic-ref", "HEAD"])).toBe(preview.ref);
    expect(await git(remote, ["for-each-ref", "--format=%(refname)", "refs/heads"])).toBe(
      "refs/heads/main",
    );
  });

  it("migrates a retained detached preview even when its candidate has not changed", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    await git(repository, ["checkout", "--detach", base]);
    await git(repository, ["update-ref", PREVIEW_MANAGED_REF, base]);
    await new PreviewWorkspaceGitApplicator(runtime).apply({
      workspace,
      credentials,
      repositories: [target(1, base)],
    });
    expect(await git(repository, ["symbolic-ref", "HEAD"])).toBe(
      previewBranchRefs(workspace.id, "repos/acme/app").ref,
    );
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(base);
  });

  it("preserves the agent branch and retains displaced committed work", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    await git(repository, ["switch", "-c", "feature/story"]);
    await writeFile(join(repository, "local.txt"), "committed work\n");
    await git(repository, ["add", "local.txt"]);
    await git(repository, ["commit", "-m", "local work"]);
    const local = await git(repository, ["rev-parse", "HEAD"]);
    await new PreviewWorkspaceGitApplicator(runtime).apply({
      workspace,
      credentials,
      repositories: [target(1, base)],
    });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(base);
    expect(await git(repository, ["rev-parse", "feature/story"])).toBe(local);
    expect(await git(repository, ["show", `${local}:local.txt`])).toBe("committed work");
    expect(
      await git(repository, ["for-each-ref", "--format=%(objectname)", "refs/facility/retained"]),
    ).toContain(local);
  });

  it("refuses an unowned branch collision even when its tip matches the candidate", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const preview = previewBranchRefs(workspace.id, "repos/acme/app");
    await git(repository, ["branch", preview.branch, base]);
    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: [target(1, base)],
      }),
    ).rejects.toMatchObject({ code: "preview_branch_changed", retryable: false });
    expect(await git(repository, ["branch", "--show-current"])).toBe("main");
    expect(await git(repository, ["rev-parse", preview.ref])).toBe(base);
    await expect(
      git(repository, ["rev-parse", "--verify", preview.ownershipRef]),
    ).rejects.toThrow();
  });

  it("blocks commits made directly on the preview branch without overwriting them", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await applicator.apply({ workspace, credentials, repositories: [target(1, base)] });
    await writeFile(join(repository, "README.md"), "unreviewed commit\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "unreviewed work"]);
    const local = await git(repository, ["rev-parse", "HEAD"]);
    await expect(
      applicator.apply({ workspace, credentials, repositories: [target(1, base)] }),
    ).rejects.toMatchObject({ code: "preview_branch_changed" });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(local);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe("unreviewed commit\n");
  });

  it("rejects a symbolic preview branch instead of moving its target", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const preview = previewBranchRefs(workspace.id, "repos/acme/app");
    await git(repository, ["symbolic-ref", preview.ref, "refs/heads/main"]);
    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: [target(1, base)],
      }),
    ).rejects.toMatchObject({ code: "preview_branch_changed" });
    expect(await git(repository, ["symbolic-ref", preview.ref])).toBe("refs/heads/main");
    expect(await git(repository, ["rev-parse", "main"])).toBe(base);
  });

  it("does not move an owned preview branch checked out in another worktree", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const preview = previewBranchRefs(workspace.id, "repos/acme/app");
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await applicator.apply({ workspace, credentials, repositories: [target(1, base)] });
    await git(repository, ["switch", "main"]);
    await git(repository, ["worktree", "add", join(root, "other-worktree"), preview.branch]);
    await expect(
      applicator.apply({ workspace, credentials, repositories: [target(1, base)] }),
    ).rejects.toMatchObject({ code: "preview_branch_in_use", retryable: false });
    expect(await git(repository, ["branch", "--show-current"])).toBe("main");
    expect(await git(repository, ["rev-parse", preview.ref])).toBe(base);
  });

  it("atomically rejects a reference change between inspection and publication", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const preview = previewBranchRefs(workspace.id, "repos/acme/app");
    const exec = runtime.exec.bind(runtime);
    runtime.exec = async (locator, command) => {
      if (command.command === "git" && command.args?.join(" ") === "update-ref --stdin") {
        await git(repository, ["update-ref", preview.ownershipRef, base]);
      }
      return exec(locator, command);
    };
    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: [target(1, base)],
      }),
    ).rejects.toMatchObject({ code: "preview_branch_changed" });
    await expect(git(repository, ["rev-parse", "--verify", preview.ref])).rejects.toThrow();
    await expect(git(repository, ["rev-parse", "--verify", PREVIEW_MANAGED_REF])).rejects.toThrow();
    expect(await git(repository, ["rev-parse", preview.ownershipRef])).toBe(base);
  });

  it("uses separate owned local branches in every repository", async () => {
    const related = "repos/acme/api";
    await git(join(workspace.volumeRef, "repos/acme"), ["clone", remote, "api"]);
    await new PreviewWorkspaceGitApplicator(runtime).apply({
      workspace,
      credentials: {
        ...credentials,
        repositories: [
          ...credentials.repositories,
          { owner: "acme", name: "api", defaultBranch: "main", role: "related" },
        ],
      },
      repositories: [
        target(1, base),
        { ...target(2, base), repositoryId: "repo_api", repository: "acme/api", primary: false },
      ],
    });
    const primaryBranch = await git(join(workspace.volumeRef, "repos/acme/app"), [
      "branch",
      "--show-current",
    ]);
    const relatedBranch = await git(join(workspace.volumeRef, related), [
      "branch",
      "--show-current",
    ]);
    expect(primaryBranch).not.toBe(relatedBranch);
    expect(relatedBranch).toBe(previewBranchRefs(workspace.id, related).branch);
  });

  it("combines divergent required heads and preserves unrelated local edits", async () => {
    await git(source, ["switch", "-c", "feature-one", base]);
    await writeFile(join(source, "one.txt"), "one\n");
    await git(source, ["add", "one.txt"]);
    await git(source, ["commit", "-m", "one"]);
    const first = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "feature-one"]);
    await git(source, ["switch", "-c", "feature-two", base]);
    await writeFile(join(source, "two.txt"), "two\n");
    await git(source, ["add", "two.txt"]);
    await git(source, ["commit", "-m", "two"]);
    const second = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "feature-two"]);
    const repository = join(workspace.volumeRef, "repos/acme/app");
    await writeFile(join(repository, "local-notes.txt"), "keep me\n");

    await new PreviewWorkspaceGitApplicator(runtime).apply({
      workspace,
      credentials,
      repositories: [target(1, first), target(2, second)],
    });

    expect(await git(repository, ["merge-base", "--is-ancestor", first, "HEAD"], false)).toBe("");
    expect(await git(repository, ["merge-base", "--is-ancestor", second, "HEAD"], false)).toBe("");
    expect(await readFile(join(repository, "one.txt"), "utf8")).toBe("one\n");
    expect(await readFile(join(repository, "two.txt"), "utf8")).toBe("two\n");
    expect(await readFile(join(repository, "local-notes.txt"), "utf8")).toBe("keep me\n");
  });

  it("blocks before mutation when a required change overlaps a dirty path", async () => {
    await git(source, ["switch", "-c", "overlap", base]);
    await writeFile(join(source, "README.md"), "required\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "required"]);
    const revision = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "overlap"]);
    const repository = join(workspace.volumeRef, "repos/acme/app");
    await writeFile(join(repository, "README.md"), "local\n");

    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: [target(1, revision)],
      }),
    ).rejects.toMatchObject({
      code: "preview_dirty_overlap",
      retryable: false,
      details: { paths: ["README.md"] },
    });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(base);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe("local\n");
  });

  it("blocks a local tracked overlay and retains every local commit", async () => {
    await git(source, ["switch", "-c", "included", base]);
    await writeFile(join(source, "included.txt"), "included\n");
    await git(source, ["add", "included.txt"]);
    await git(source, ["commit", "-m", "included"]);
    const revision = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "included"]);
    const repository = join(workspace.volumeRef, "repos/acme/app");
    await git(repository, ["fetch", "origin", revision]);
    await git(repository, ["merge", "--ff-only", revision]);
    await writeFile(join(repository, "README.md"), "retained branch commit\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "retained branch commit"]);
    await writeFile(join(repository, "README.md"), "uncommitted local follow-up\n");
    const before = await git(repository, ["rev-parse", "HEAD"]);
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await expect(
      applicator.apply({ workspace, credentials, repositories: [target(1, revision)] }),
    ).rejects.toMatchObject({ code: "preview_dirty_overlap" });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(before);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe(
      "uncommitted local follow-up\n",
    );
  });
  it("replaces a force-pushed sole head, removes withdrawn PRs and handles rewinds exactly", async () => {
    const repository = join(workspace.volumeRef, "repos/acme/app");
    await git(source, ["switch", "-c", "candidate", base]);
    await writeFile(join(source, "obsolete.txt"), "old feature");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "old"]);
    const old = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "candidate"]);
    const applicator = new PreviewWorkspaceGitApplicator(runtime);
    await applicator.apply({ workspace, credentials, repositories: [target(1, old)] });
    await writeFile(join(repository, "notes.txt"), "useful local data");
    await git(source, ["switch", "-c", "replacement", base]);
    await writeFile(join(source, "replacement.txt"), "new feature");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "replacement"]);
    const replacement = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "replacement"]);
    await applicator.apply({ workspace, credentials, repositories: [target(1, replacement)] });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(replacement);
    await expect(readFile(join(repository, "obsolete.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await applicator.apply({ workspace, credentials, repositories: [target(1, base)] });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(base);
    await expect(readFile(join(repository, "replacement.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await applicator.apply({ workspace, credentials, repositories: [target(1, replacement)] });
    await applicator.apply({ workspace, credentials, repositories: [] });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(base);
    expect(await readFile(join(repository, "notes.txt"), "utf8")).toBe("useful local data");
    expect(
      await git(repository, ["for-each-ref", "--format=%(objectname)", "refs/facility/retained"]),
    ).toContain(old);
  });

  it.each([
    false,
    true,
  ])("protects ignored retained data from a %s divergent candidate", async (divergent) => {
    await writeFile(join(source, ".gitignore"), "retained.json\n");
    await git(source, ["add", "."]);
    await git(source, ["commit", "-m", "ignore retained data"]);
    await git(source, ["push", "origin", "main"]);
    const repository = join(workspace.volumeRef, "repos/acme/app");
    await git(repository, ["pull", "--ff-only"]);
    await writeFile(join(repository, "retained.json"), "valuable retained data");
    await git(source, ["switch", "-c", "candidate"]);
    await writeFile(join(source, "retained.json"), "tracked default");
    await git(source, ["add", "-f", "retained.json"]);
    await git(source, ["commit", "-m", "track default"]);
    const revision = await git(source, ["rev-parse", "HEAD"]);
    await git(source, ["push", "origin", "candidate"]);
    const required = [target(1, revision)];
    if (divergent) {
      await git(source, ["switch", "-c", "parallel", "main"]);
      await writeFile(join(source, "other.txt"), "parallel");
      await git(source, ["add", "."]);
      await git(source, ["commit", "-m", "parallel"]);
      const second = await git(source, ["rev-parse", "HEAD"]);
      await git(source, ["push", "origin", "parallel"]);
      required.push(target(2, second));
    }
    const before = await git(repository, ["rev-parse", "HEAD"]);
    await expect(
      new PreviewWorkspaceGitApplicator(runtime).apply({
        workspace,
        credentials,
        repositories: required,
      }),
    ).rejects.toMatchObject({ code: "preview_checkout_blocked" });
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(before);
    expect(await readFile(join(repository, "retained.json"), "utf8")).toBe(
      "valuable retained data",
    );
  });
});

function target(pullNumber: number, headSha: string): PreviewGenerationRepository {
  return {
    repositoryId: "repo_app",
    repository: "acme/app",
    pullNumber,
    headRef: `feature-${pullNumber}`,
    headSha,
    primary: pullNumber === 1,
  };
}

async function git(cwd: string, args: string[], trim = true) {
  const result = await execFile("git", args, { cwd });
  return trim ? result.stdout.trim() : result.stdout;
}
