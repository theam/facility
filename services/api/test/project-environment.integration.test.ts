import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@facility/core";
import {
  createDb,
  migrate,
  orgMembers,
  orgs,
  projects,
  roles,
  stories,
  storyArtifacts,
  users,
  workspaceEvents,
  workspaces,
} from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  GithubWorkspaceCredentialBroker,
  GithubWorkspaceCredentials,
} from "../src/github/workspace-credentials.js";
import type { AppConfig } from "../src/types.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import { WorkspacePreviewService } from "../src/workspaces/preview.js";
import {
  ProjectEnvironmentService,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await client`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("project environment contract", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; project environment tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), "facility-environment-"));
  const remotes = join(root, "remotes");
  const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
  const suffix = randomUUID().slice(0, 8);
  const orgId = newId("org");
  const projectId = newId("proj");
  const storyId = newId("story");
  const workspaceId = newId("ws");
  let workspace: Awaited<ReturnType<typeof runtime.create>>;

  const manifest = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/acme/app
  related:
    - github.com/acme/shared
environment:
  setup: |
    count=$(cat .setup-count 2>/dev/null || printf 0)
    printf '%s' "$((count + 1))" > .setup-count
  start: mkdir -p .facility-test && printf started > .facility-test/status
  ready: test -f .facility-test/status
  seed: mkdir -p .facility-test && printf seeded > .facility-test/seed
  browser_test: |
    test "$(cat .facility-test/seed)" = seeded
    printf screenshot > "$FACILITY_ARTIFACT_DIR/home.png"
    printf trace > "$FACILITY_ARTIFACT_DIR/browser-trace.zip"
  services:
    app:
      port: 3000
      websocket: true
`);

  const credentials: GithubWorkspaceCredentials = {
    gitIdentity: { name: "my-app[bot]", email: "12345+my-app[bot]@users.noreply.github.com" },
    repositories: [
      { owner: "acme", name: "app", defaultBranch: "main", role: "primary" },
      { owner: "acme", name: "shared", defaultBranch: "main", role: "related" },
    ],
    environment: {},
    expiresAt: new Date(Date.now() + 3_600_000),
  };

  beforeAll(async () => {
    await migrate(databaseUrl);
    await Promise.all([
      createBareRepository(remotes, "acme", "app"),
      createBareRepository(remotes, "acme", "shared"),
    ]);
    await db
      .insert(orgs)
      .values({ id: orgId, name: "Environment", slug: `environment-${suffix}`, settings: {} });
    await db.insert(projects).values({
      id: projectId,
      orgId,
      name: "Environment",
      slug: `environment-${suffix}`,
      settings: {},
    });
    await db.insert(stories).values({
      id: storyId,
      orgId,
      projectId,
      provider: "manual",
      externalId: `environment-${suffix}`,
      title: "Environment",
      createdBy: { type: "user", id: "test" },
    });
    workspace = await runtime.create({ id: workspaceId, image: "facility-runner:test" });
    await db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      projectId,
      storyId,
      provider: "fake",
      externalRef: workspace.externalRef,
      volumeRef: workspace.volumeRef,
      state: "running",
      environment: {
        image: workspace.image,
        variables: {},
        ports: [],
        resources: { cpu: 2, memoryMb: 4096 },
      },
    });
  });

  afterAll(async () => {
    await client.end();
    await rm(root, { recursive: true, force: true });
  });

  it("clones all repositories, creates the primary story branch, and runs setup once", async () => {
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);
    const locator = workspace;
    const first = await environment.prepare({
      orgId,
      projectId,
      workspace: locator,
      manifest,
      credentials,
      branch: "facility/story-environment",
      previousSetupChecksum: null,
      readinessTimeoutMs: 2_000,
    });
    expect(first.endpoints).toEqual([
      {
        service: "app",
        port: 3000,
        protocol: "http",
        websocket: true,
        url: "http://127.0.0.1:3000",
      },
    ]);
    expect(await readFile(join(workspace.volumeRef, "repos/acme/app/.setup-count"), "utf8")).toBe(
      "1",
    );
    const branch = await runtime.exec(locator, {
      command: "git",
      args: ["branch", "--show-current"],
      cwd: "repos/acme/app",
    });
    expect(branch.stdout.trim()).toBe("facility/story-environment");
    for (const cwd of ["repos/acme/app", "repos/acme/shared"]) {
      const author = await runtime.exec(locator, {
        command: "git",
        args: ["var", "GIT_AUTHOR_IDENT"],
        cwd,
      });
      expect(author.exitCode).toBe(0);
      expect(author.stdout).toMatch(
        /^my-app\[bot\] <12345\+my-app\[bot\]@users\.noreply\.github\.com> /,
      );
    }
    expect(
      await readFile(join(workspace.volumeRef, "repos/acme/app/.facility-test/seed"), "utf8"),
    ).toBe("seeded");

    const browser = await environment.runBrowserTest({
      orgId,
      projectId,
      storyId,
      workspace: locator,
      manifest,
      credentials,
    });
    expect(browser.artifacts.map((artifact) => artifact.kind).sort()).toEqual([
      "screenshot",
      "trace",
    ]);
    expect(
      await db.select().from(storyArtifacts).where(eq(storyArtifacts.storyId, storyId)),
    ).toHaveLength(2);

    // Repair existing workspaces created with the old unassociated address too.
    await runtime.exec(locator, {
      command: "git",
      args: ["config", "user.email", "facility-agent@users.noreply.github.com"],
      cwd: "repos/acme/app",
    });
    await runtime.replaceCompute(locator);
    await environment.prepare({
      orgId,
      projectId,
      workspace: locator,
      manifest,
      credentials,
      branch: "facility/story-environment",
      previousSetupChecksum: first.setupChecksum,
      readinessTimeoutMs: 2_000,
    });
    const resumedAuthor = await runtime.exec(locator, {
      command: "git",
      args: ["var", "GIT_AUTHOR_IDENT"],
      cwd: "repos/acme/app",
    });
    expect(resumedAuthor.stdout).toMatch(
      /^my-app\[bot\] <12345\+my-app\[bot\]@users\.noreply\.github\.com> /,
    );
    expect(await readFile(join(workspace.volumeRef, "repos/acme/app/.setup-count"), "utf8")).toBe(
      "1",
    );
    expect(
      await readFile(join(workspace.volumeRef, "repos/acme/shared/README.md"), "utf8"),
    ).toContain("shared");
  });

  it("opens previews on the agent's changed workspace without checkout, setup, or reseeding", async () => {
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);
    const prepared = await environment.prepare({
      orgId,
      projectId,
      workspace,
      manifest,
      credentials,
      branch: "facility/story-environment",
      cleanSetup: true,
    });
    expect(prepared.setupChecksum).toMatch(/^[a-f0-9]{64}$/);
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const git = async (args: string[]) => {
      const result = await runtime.exec(workspace, { command: "git", args, cwd: "repos/acme/app" });
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    await git(["switch", "-c", "facility/agent-current-work"]);
    await writeFile(join(repository, "README.md"), "Agent's committed implementation\n");
    await git(["add", "README.md"]);
    await git(["commit", "-m", "fix: implement the story"]);
    const head = await git(["rev-parse", "HEAD"]);
    await writeFile(join(repository, "uncommitted.txt"), "Work in progress\n");
    await writeFile(join(repository, ".facility-test/seed"), "user-created-data");
    await writeFile(join(workspace.volumeRef, ".facility/claude/session.json"), "claude-session");
    await writeFile(join(workspace.volumeRef, ".facility/codex/session.json"), "codex-session");
    const setupCount = await readFile(join(repository, ".setup-count"), "utf8");
    const userId = newId("user");
    const roleId = newId("role");
    await db
      .insert(users)
      .values({ id: userId, email: `preview-reuse-${suffix}@example.com`, status: "active" });
    await db.insert(roles).values({
      id: roleId,
      orgId,
      name: `preview-reuse-${suffix}`,
      permissions: ["workspaces:execute"],
    });
    await db.insert(orgMembers).values({ id: newId("member"), orgId, userId, roleId });
    const previews = new WorkspacePreviewService(
      db,
      {
        publicUrl: "https://api.example.com",
        previewUrl: "https://preview.example.net",
      } as AppConfig,
      runtime,
      {
        issue: async () => credentials,
      } as unknown as GithubWorkspaceCredentialBroker,
      { load: async () => manifest },
      environment,
    );

    for (const sleeping of [false, true]) {
      if (sleeping) {
        await runtime.replaceCompute(workspace);
        await rm(join(repository, ".facility-test/status"));
        await db
          .update(workspaces)
          .set({ state: "sleeping" })
          .where(eq(workspaces.id, workspaceId));
      }
      const originalExec = runtime.exec.bind(runtime);
      const exec = vi.spyOn(runtime, "exec").mockImplementation(async (locator, command) => {
        const result = await originalExec(locator, command);
        // A concurrent preparation may finish after preview open read its checksum.
        await db
          .update(workspaces)
          .set({ setupChecksum: "concurrent-preparation-checksum" })
          .where(eq(workspaces.id, workspaceId));
        return result;
      });
      try {
        const opened = await previews.open({ orgId, projectId, storyId, userId, service: "app" });
        expect(
          exec.mock.calls.every(
            ([locator]) => locator.id === workspaceId && locator.volumeRef === workspace.volumeRef,
          ),
        ).toBe(true);
        const scripts = exec.mock.calls.map(([, command]) => {
          expect(command.command).toBe("sh");
          return command.args?.[1];
        });
        expect(scripts).toEqual(
          sleeping
            ? [manifest.environment.ready, manifest.environment.start, manifest.environment.ready]
            : [manifest.environment.ready],
        );
        const token = new URL(opened.url).searchParams.get("token");
        if (!token) throw new Error("expected one-time preview token");
        await expect(previews.exchange(opened.sessionId, token)).resolves.toMatchObject({
          workspaceId,
        });
        await expect(previews.exchange(opened.sessionId, token)).rejects.toMatchObject({
          code: "preview_access_invalid",
        });
        await expect(previews.authorize(opened.sessionId, token)).resolves.toMatchObject({
          workspaceId,
        });
      } finally {
        exec.mockRestore();
      }
      expect(await git(["rev-parse", "HEAD"])).toBe(head);
      expect(await git(["branch", "--show-current"])).toBe("facility/agent-current-work");
      expect(await readFile(join(repository, "uncommitted.txt"), "utf8")).toBe(
        "Work in progress\n",
      );
      expect(await readFile(join(repository, ".facility-test/seed"), "utf8")).toBe(
        "user-created-data",
      );
      expect(await readFile(join(repository, ".setup-count"), "utf8")).toBe(setupCount);
      expect(
        await readFile(join(workspace.volumeRef, ".facility/claude/session.json"), "utf8"),
      ).toBe("claude-session");
      expect(
        await readFile(join(workspace.volumeRef, ".facility/codex/session.json"), "utf8"),
      ).toBe("codex-session");
      const persisted = (
        await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
      )[0];
      expect(persisted).toMatchObject({
        state: "running",
        setupChecksum: "concurrent-preparation-checksum",
      });
    }
    await expect(
      previews.open({ orgId: newId("org"), projectId, storyId, userId, service: "app" }),
    ).rejects.toMatchObject({ code: "story_not_found" });
  });

  it("marks successful preparation without a setup script for future preview reuse", async () => {
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);
    const noSetup = {
      ...manifest,
      environment: { ...manifest.environment, setup: undefined, seed: undefined },
    };
    const prepared = await environment.prepare({
      orgId,
      projectId,
      workspace,
      manifest: noSetup,
      credentials,
      branch: "facility/story-environment",
    });
    const persisted = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0];
    expect(persisted?.setupChecksum).toBe(prepared.setupChecksum);
  });

  it("validates declared environment before running setup and injects it ephemerally", async () => {
    const configured = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/acme/app
  related:
    - github.com/acme/shared
environment:
  setup: test -n "$FACILITY_FIXTURE_SECRET" && printf '%s' "$FACILITY_FIXTURE_SECRET"
  start: test "$FACILITY_FIXTURE_MODE" = test
  secrets: [FACILITY_FIXTURE_SECRET]
  variables: [FACILITY_FIXTURE_MODE]
`);
    const values = new Map([
      ["FACILITY_FIXTURE_SECRET", "fixture-secret-value"],
      ["FACILITY_FIXTURE_MODE", "test"],
    ]);
    const environment = new ProjectEnvironmentService(
      db,
      runtime,
      `file://${remotes}`,
      (_projectId, name) => values.get(name),
    );
    const prepared = await environment.prepare({
      orgId,
      projectId,
      workspace,
      manifest: configured,
      credentials,
      branch: "facility/story-environment",
      cleanSetup: true,
    });
    expect(prepared).toMatchObject({
      endpoints: [],
      processEnvironment: {
        FACILITY_FIXTURE_SECRET: "fixture-secret-value",
        FACILITY_FIXTURE_MODE: "test",
      },
    });
    const persisted = JSON.stringify(
      await db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, workspaceId)),
    );
    expect(persisted).not.toContain("fixture-secret-value");

    const missing = new ProjectEnvironmentService(
      db,
      runtime,
      `file://${remotes}`,
      () => undefined,
    );
    await expect(
      missing.prepare({
        orgId,
        projectId,
        workspace,
        manifest: configured,
        credentials,
        branch: "facility/story-environment",
      }),
    ).rejects.toMatchObject({ code: "project_environment_missing" });
  });

  it("cannot inject an unscoped control-plane environment variable", async () => {
    const configured = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/acme/app
  related:
    - github.com/acme/shared
environment:
  start: test -n "$DATABASE_URL"
  secrets: [DATABASE_URL]
`);
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);

    await expect(
      environment.prepare({
        orgId,
        projectId,
        workspace,
        manifest: configured,
        credentials,
        branch: "facility/story-environment",
      }),
    ).rejects.toMatchObject({
      code: "project_environment_missing",
      details: {
        missing: [
          {
            name: "DATABASE_URL",
            operatorName: `FACILITY_PROJECT_${projectId.toUpperCase()}_DATABASE_URL`,
          },
        ],
      },
    });
  });

  it("supports ordinary maintainer Git and GitHub operations with deterministic fakes", async () => {
    const token = "fixture-full-maintainer-token";
    const maintainerCredentials: GithubWorkspaceCredentials = {
      ...credentials,
      environment: {
        GH_TOKEN: token,
        GITHUB_TOKEN: token,
      },
    };
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);
    const prepared = await environment.prepare({
      orgId,
      projectId,
      workspace,
      manifest,
      credentials: maintainerCredentials,
      branch: "facility/story-environment",
    });
    const repository = join(workspace.volumeRef, "repos/acme/app");
    const shimDirectory = join(root, "github-cli");
    const callsFile = join(root, "github-cli-calls");
    await mkdir(shimDirectory, { recursive: true });
    await writeFile(
      join(shimDirectory, "gh"),
      `#!/bin/sh
test -n "$GH_TOKEN" || exit 64
printf '%s\\n' "$*" >> "$GH_CALLS"
case "$1 $2" in
  "issue create") printf 'https://github.test/acme/app/issues/101\\n' ;;
  "issue comment") printf 'https://github.test/acme/app/issues/72#issuecomment-1\\n' ;;
  "run rerun") printf 'rerun requested\\n' ;;
  "pr create") printf 'https://github.test/acme/app/pull/77\\n' ;;
  "pr checks") printf 'test pass 1m\\n' ;;
  *) exit 65 ;;
esac
`,
    );
    await chmod(join(shimDirectory, "gh"), 0o755);
    await mkdir(join(repository, ".github", "workflows"), { recursive: true });
    await writeFile(join(repository, "maintainer-change.txt"), "maintainer change\n");
    await writeFile(
      join(repository, ".github", "workflows", "agent-check.yml"),
      "name: agent-check\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
    );

    const git = async (args: string[]) => {
      const result = await runtime.exec(workspace, {
        command: "git",
        args,
        cwd: "repos/acme/app",
        env: prepared.processEnvironment,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      return result;
    };
    await git(["switch", "-c", "facility/maintainer-commands"]);
    await git(["add", "maintainer-change.txt", ".github/workflows/agent-check.yml"]);
    await git([
      "-c",
      "user.name=Facility Agent",
      "-c",
      "user.email=agent@facility.test",
      "commit",
      "-m",
      "feat: prove maintainer operations",
    ]);
    await git(["push", "--set-upstream", "origin", "facility/maintainer-commands"]);

    const gh = async (args: string[]) => {
      const result = await runtime.exec(workspace, {
        command: "gh",
        args,
        cwd: "repos/acme/app",
        env: {
          ...prepared.processEnvironment,
          GH_CALLS: callsFile,
          PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
        },
      });
      expect(result.exitCode, result.stderr).toBe(0);
    };
    await gh(["issue", "create", "--repo", "acme/app", "--title", "Agent-created issue"]);
    await gh(["issue", "comment", "72", "--repo", "acme/app", "--body", "Progress update"]);
    await gh(["run", "rerun", "9001", "--repo", "acme/app", "--failed"]);
    await gh([
      "pr",
      "create",
      "--repo",
      "acme/app",
      "--head",
      "facility/maintainer-commands",
      "--title",
      "Maintainer operations",
      "--body",
      "Validated by the deterministic fake",
    ]);
    await gh(["pr", "checks", "77", "--repo", "acme/app"]);

    const calls = await readFile(callsFile, "utf8");
    expect(calls).toContain("issue create --repo acme/app --title Agent-created issue");
    expect(calls).toContain("issue comment 72 --repo acme/app --body Progress update");
    expect(calls).toContain("run rerun 9001 --repo acme/app --failed");
    expect(calls).toContain("pr create --repo acme/app --head facility/maintainer-commands");
    expect(calls).toContain("pr checks 77 --repo acme/app");
    expect(calls).not.toContain(token);
    const branchContents = await git([
      "show",
      "origin/facility/maintainer-commands:maintainer-change.txt",
    ]);
    expect(branchContents.stdout).toBe("maintainer change\n");
    const workflowContents = await git([
      "show",
      "origin/facility/maintainer-commands:.github/workflows/agent-check.yml",
    ]);
    expect(workflowContents.stdout).toContain("name: agent-check");
  });

  it("rejects a manifest that asks for a repository outside the project", async () => {
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);
    const mismatched = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/acme/app
  related:
    - github.com/acme/not-configured
environment:
  start: "true"
`);
    await expect(
      environment.prepare({
        orgId,
        projectId,
        workspace,
        manifest: mismatched,
        credentials,
        branch: "facility/story-environment",
      }),
    ).rejects.toMatchObject({ code: "project_repository_mismatch" });
  });

  it("redacts full-access GitHub credentials from environment events and errors", async () => {
    const secret = "github-installation-token-that-must-never-be-stored";
    const protectedCredentials: GithubWorkspaceCredentials = {
      ...credentials,
      environment: {
        GH_TOKEN: secret,
        GITHUB_TOKEN: secret,
        FACILITY_GITHUB_CREDENTIALS: JSON.stringify({ "acme/app": secret }),
      },
    };
    const environment = new ProjectEnvironmentService(db, runtime, `file://${remotes}`);
    const emitsSecret = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/acme/app
  related:
    - github.com/acme/shared
environment:
  start: printf '%s' "$GH_TOKEN"
`);
    await environment.prepare({
      orgId,
      projectId,
      workspace,
      manifest: emitsSecret,
      credentials: protectedCredentials,
      branch: "facility/story-environment",
    });
    const event = (
      await db
        .select()
        .from(workspaceEvents)
        .where(and(eq(workspaceEvents.orgId, orgId), eq(workspaceEvents.workspaceId, workspaceId)))
        .orderBy(desc(workspaceEvents.seq))
        .limit(2)
    ).find((candidate) => candidate.type === "environment.start");
    expect(JSON.stringify(event?.data)).not.toContain(secret);
    expect(JSON.stringify(event?.data)).toContain("[REDACTED]");

    const failsWithSecret = parseProjectManifest(`
version: 1
repositories:
  primary: github.com/acme/app
  related:
    - github.com/acme/shared
environment:
  start: printf '%s' "$GH_TOKEN" >&2; exit 17
`);
    await expect(
      environment.prepare({
        orgId,
        projectId,
        workspace,
        manifest: failsWithSecret,
        credentials: protectedCredentials,
        branch: "facility/story-environment",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      const serialized = JSON.stringify(error);
      return !serialized.includes(secret) && serialized.includes("[REDACTED]");
    });
  });
});

async function createBareRepository(root: string, owner: string, name: string) {
  const bare = join(root, owner, `${name}.git`);
  const work = join(root, "seed", name);
  await mkdir(join(root, owner), { recursive: true });
  await mkdir(work, { recursive: true });
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  await run("git", ["init", "--initial-branch=main"], work);
  await writeFile(join(work, "README.md"), `# ${name}\n`);
  await run("git", ["add", "README.md"], work);
  await run(
    "git",
    [
      "-c",
      "user.name=Facility Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    ],
    work,
  );
  await run("git", ["remote", "add", "origin", bare], work);
  await run("git", ["push", "origin", "main"], work);
}

async function run(command: string, args: string[], cwd?: string) {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolve, reject) => {
    execFile(command, args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve();
    });
  });
}
