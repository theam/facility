import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId } from "@facility/core";
import {
  createDb,
  migrate,
  orgs,
  projects,
  stories,
  workspaceEvents,
  workspaces,
} from "@facility/db";
import { and, desc, eq } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
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
  services:
    app:
      port: 3000
      websocket: true
`);

  const credentials: GithubWorkspaceCredentials = {
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

    await runtime.replaceCompute(locator);
    await environment.prepare({
      orgId,
      projectId,
      workspace: locator,
      manifest,
      credentials,
      branch: "facility/story-environment",
      previousSetupChecksum: manifest.hash,
      readinessTimeoutMs: 2_000,
    });
    expect(await readFile(join(workspace.volumeRef, "repos/acme/app/.setup-count"), "utf8")).toBe(
      "1",
    );
    expect(
      await readFile(join(workspace.volumeRef, "repos/acme/shared/README.md"), "utf8"),
    ).toContain("shared");
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
