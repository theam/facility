import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@facility/core";
import { createDb, migrate, orgs, projects, stories, workspaces } from "@facility/db";
import Docker from "dockerode";
import { expect, it } from "vitest";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";
import { PreviewWorkspaceGitApplicator } from "../src/stories/preview-convergence-executor.js";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { previewBranchRefs } from "../src/workspaces/preview-branch.js";
import {
  ProjectEnvironmentService,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";

it("creates work from development and retains commits and dirty files after the base advances and compute is replaced", async () => {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-development-workspace-"));
  const runtime =
    process.env.FACILITY_E2E_DOCKER === "1"
      ? new DockerWorkspaceRuntime(new Docker())
      : new FakeWorkspaceRuntime(root);
  const orgId = newId("org"),
    projectId = newId("proj"),
    storyId = newId("story"),
    workspaceId = newId("ws");
  const workspace = await runtime.create({
    id: workspaceId,
    image: process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:dev",
  });
  const command = async (script: string, cwd?: string) => {
    const result = await runtime.exec(workspace, { command: "sh", args: ["-lc", script], cwd });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    await migrate(databaseUrl);
    await db.insert(orgs).values({ id: orgId, name: orgId, slug: orgId });
    await db.insert(projects).values({ id: projectId, orgId, name: projectId, slug: projectId });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      provider: "manual",
      externalId: storyId,
      title: "Development workspace",
      branch: "feature/story",
      createdBy: { type: "key", id: "test" },
    });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      projectId,
      storyId,
      provider: "fake",
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
      state: "running",
    });
    const workspaceRoot = await command("pwd");
    await command(
      `mkdir -p branch-remotes/acme seed; git init --bare --initial-branch=main branch-remotes/acme/app.git; git init --initial-branch=main seed; cd seed; git config user.name Test; git config user.email test@example.com; git config commit.gpgsign false; git config core.hooksPath /dev/null; printf stable > README.md; git add README.md; git commit -m 'initial'; git remote add origin '${workspaceRoot}/branch-remotes/acme/app.git'; git push origin main; git switch -c develop; printf development > development.txt; git add development.txt; git commit -m 'development'; git push origin develop`,
    );
    const developmentSha = await command("git rev-parse develop", "seed");
    const manifest = parseProjectManifest(
      'version: 1\nrepositories:\n  primary: github.com/acme/app\nenvironment:\n  setup: "true"\n  start: test -n "$(git branch --show-current)"\n',
    );
    const credentials: GithubWorkspaceCredentials = {
      repositories: [
        {
          owner: "acme",
          name: "app",
          defaultBranch: "main",
          developmentBranch: "develop",
          role: "primary",
        },
      ],
      environment: {},
      expiresAt: new Date(Date.now() + 60_000),
      gitIdentity: { name: "Test", email: "test@example.com" },
    };
    const service = new ProjectEnvironmentService(
      db,
      runtime,
      `file://${workspaceRoot}/branch-remotes`,
    );
    const input = { orgId, projectId, workspace, manifest, credentials, branch: "feature/story" };
    for (const branch of ["main", "develop"])
      await expect(service.prepare({ ...input, branch })).rejects.toMatchObject({
        code: "story_branch_protected",
      });
    await service.prepare(input);
    expect(await command("git rev-parse HEAD", "repos/acme/app")).toBe(developmentSha);
    expect(await command("cat development.txt", "repos/acme/app")).toBe("development");
    await command(
      "git config commit.gpgsign false; git config core.hooksPath /dev/null; printf story > story.txt; git add story.txt; git commit -m 'story'; printf dirty > dirty.txt",
      "repos/acme/app",
    );
    const head = await command("git rev-parse HEAD", "repos/acme/app");
    await command(
      "printf advanced > advanced.txt; git add advanced.txt; git commit -m 'advance'; git push origin develop",
      "seed",
    );
    await runtime.replaceCompute(workspace);
    const resumed = await runtime.wake(workspace);
    Object.assign(workspace, resumed);
    await service.prepare(input);
    expect(await command("git rev-parse HEAD", "repos/acme/app")).toBe(head);
    expect(await command("git branch --show-current", "repos/acme/app")).toBe("feature/story");
    expect(await command("cat dirty.txt", "repos/acme/app")).toBe("dirty");
    expect(await command("test ! -f advanced.txt && echo preserved", "repos/acme/app")).toBe(
      "preserved",
    );

    await command("git push origin feature/story", "repos/acme/app");
    await command("printf retained > retained-data.txt", "repos/acme/app");
    await new PreviewWorkspaceGitApplicator(runtime).apply({
      workspace,
      credentials,
      repositories: [
        {
          repositoryId: "repo_app",
          repository: "acme/app",
          pullNumber: 7,
          headRef: "feature/story",
          headSha: head,
          primary: true,
        },
      ],
    });
    const preview = previewBranchRefs(workspace.id, "repos/acme/app");
    const candidate = await command("git rev-parse HEAD", "repos/acme/app");
    expect(await command("git branch --show-current", "repos/acme/app")).toBe(preview.branch);
    expect(await command("git rev-parse feature/story", "repos/acme/app")).toBe(head);
    expect(await command("cat advanced.txt", "repos/acme/app")).toBe("advanced");
    expect(await command("cat story.txt", "repos/acme/app")).toBe("story");
    const refreshed = await service.refreshPrepared(input);
    const protectedMain = await command("git rev-parse main", "repos/acme/app");
    // An alias must not redirect the agent handoff into the protected base.
    await command("git symbolic-ref refs/heads/feature/story refs/heads/main", "repos/acme/app");
    await runtime.replaceCompute(workspace);
    Object.assign(workspace, await runtime.wake(workspace));
    await service.prepare({ ...input, previousSetupChecksum: refreshed.setupChecksum });
    expect(await command("git branch --show-current", "repos/acme/app")).toBe("feature/story");
    expect(await command("git rev-parse HEAD", "repos/acme/app")).toBe(candidate);
    expect(await command("git rev-parse main", "repos/acme/app")).toBe(protectedMain);
    expect(
      await command(
        "git for-each-ref --format='%(symref)' refs/heads/feature/story",
        "repos/acme/app",
      ),
    ).toBe("");
    expect(await command("cat dirty.txt", "repos/acme/app")).toBe("dirty");
    expect(await command("cat retained-data.txt", "repos/acme/app")).toBe("retained");
    expect(await command(`git rev-parse ${preview.ref}`, "repos/acme/app")).toBe(candidate);
  } finally {
    await runtime.destroy(workspace);
    await client.end();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
