import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApiKey, newId } from "@facility/core";
import {
  apiKeys,
  createDb,
  githubInstallations,
  migrate,
  orgs,
  projectRepositories,
  projects,
  roles,
  seed,
  turnEvents,
  turns,
  workspaces,
} from "@facility/db";
import { and, asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { LocalRepositoryHost } from "../src/repositories/local.js";
import { createStoryDomain, type StoryDomain } from "../src/story-domain.js";
import type { AgentEngine, AgentTurnRequest, AgentTurnResult } from "../src/turns/engines.js";
import type { AppConfig } from "../src/types.js";
import { DockerWorkspaceRuntime } from "../src/workspaces/docker.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type { WorkspaceLocator, WorkspaceRuntime } from "../src/workspaces/runtime.js";

// The default suite uses the deterministic fake runtime. FACILITY_E2E_DOCKER=1 runs the same
// workflow against real Docker workspaces (the bundle crosses a real exec stdin).
const docker = process.env.FACILITY_E2E_DOCKER === "1";
const workspaceImage = process.env.FACILITY_WORKSPACE_TEST_IMAGE ?? "facility-runner:dev";

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

/**
 * The first-release acceptance path: a local Git repository with no remote goes
 * from registration through agent turns, review, revision, approval and export
 * with no GitHub configuration. The agent is a deterministic fake; GitHub client
 * factories throw and are counted so any GitHub dependency fails the suite.
 */
describe("local repository workflow", { timeout: docker ? 600_000 : 60_000 }, async () => {
  const reachable = await canConnect();
  if (!reachable) {
    it.skip("Postgres is unreachable at DATABASE_URL; local workflow tests skipped", () =>
      undefined);
    return;
  }

  const { db, client } = createDb(databaseUrl);
  const suffix = randomUUID().slice(0, 8);
  const base = await mkdtemp(join(tmpdir(), "facility-local-workflow-"));
  const approved = join(base, "approved");
  const outside = join(base, "outside");
  const repository = join(approved, `app-${suffix}`);
  const orgId = "org_local";
  const projectId = newId("proj");
  const githubProjectId = newId("proj");
  const otherOrgId = newId("org");
  const otherOrgProjectId = newId("proj");
  const githubCalls: string[] = [];
  const queued: string[] = [];
  const runtimeRoot = join(base, "workspaces");
  const newRuntime = (): WorkspaceRuntime =>
    docker ? new DockerWorkspaceRuntime() : new FakeWorkspaceRuntime(runtimeRoot);
  let runtime = newRuntime();

  class FakeLocalEngine implements AgentEngine {
    readonly name = "codex" as const;
    requests: AgentTurnRequest[] = [];
    leaveDirty = false;
    nextScript?: string;
    async run(request: AgentTurnRequest): Promise<AgentTurnResult> {
      this.requests.push(request);
      const n = this.requests.length;
      const custom = this.nextScript;
      this.nextScript = undefined;
      const script = custom
        ? custom
        : this.leaveDirty
          ? `printf 'draft\\n' > draft-${n}.txt`
          : `printf 'change ${n}\\n' > feature-${n}.txt && git add -A && git commit -q -m "feat: change ${n}"`;
      const result = await currentRuntime().exec(request.workspace, {
        command: "sh",
        args: ["-c", script],
        cwd: request.cwd,
      });
      if (result.exitCode !== 0) throw new Error(`fake agent failed: ${result.stderr}`);
      return {
        nativeSessionId: "codex-local-session",
        output: `completed change ${n}`,
        progress: [],
        events: [],
        exitCode: 0,
        stderr: "",
        durationMs: result.durationMs,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    }
  }
  const engine = new FakeLocalEngine();
  const currentRuntime = () => runtime;

  const config: AppConfig = {
    databaseUrl,
    secretMasterKey: Buffer.alloc(32, 12).toString("base64"),
    port: 4400,
    publicUrl: "http://localhost:4400",
    webUrl: "http://localhost:3400",
    workspaceImage: docker ? workspaceImage : "facility-runner:test",
    workspaceDriver: "docker",
    facilityInsecureDev: true,
    logLevel: "silent",
    localRepositoryRoots: [approved],
  };

  const makeDomain = (): StoryDomain =>
    createStoryDomain({
      db,
      config,
      enqueue: async (queue, data) => {
        if (queue === "turns.dispatch") queued.push(String(data.turnId));
        return null;
      },
      runtime: new Proxy({} as WorkspaceRuntime, {
        get: (_target, property) => {
          const value = Reflect.get(runtime, property);
          return typeof value === "function" ? value.bind(runtime) : value;
        },
      }),
      githubFactory: async () => {
        githubCalls.push("client");
        throw new Error("GitHub must not be used for local repositories");
      },
      maintainerTokenFactory: async () => {
        githubCalls.push("token");
        throw new Error("GitHub must not be used for local repositories");
      },
      localRepositoryHost: new LocalRepositoryHost({ roots: [approved] }),
      engines: [engine],
    });
  let domain: StoryDomain;
  let app: FastifyInstance;
  let ownerSecret = "";
  let viewerSecret = "";
  let otherOrgSecret = "";
  let storyId = "";
  let branch = "";

  const owner = () => ({ authorization: `Bearer ${ownerSecret}` });
  const api = (
    method: "GET" | "POST",
    url: string,
    payload?: unknown,
    headers: Record<string, string> = owner(),
  ) => app.inject({ method, url, payload: payload as object, headers });
  const review = (suffixPath = "") =>
    `/v1/projects/${projectId}/workspace-stories/${storyId}/local-review${suffixPath}`;

  async function dispatchQueued() {
    const turnId = queued.shift();
    if (!turnId) throw new Error("no queued turn");
    return domain.dispatcher.dispatch({ orgId, projectId, turnId });
  }

  async function send(message: string) {
    const response = await api(
      "POST",
      `/v1/projects/${projectId}/workspace-stories/${storyId}/messages`,
      { message, agent: "builder", idempotency_key: randomUUID() },
    );
    expect(response.statusCode, response.body).toBeLessThan(300);
    return dispatchQueued();
  }

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: false });
    await mkdir(approved, { recursive: true });
    await mkdir(outside, { recursive: true });
    await createRepository(repository, {
      ".facility.yml": manifest(`app-${suffix}`),
      ".agents/builder.md": agent("builder"),
      "README.md": "# app\n",
      "shared.txt": "base\n",
      ".gitignore": ".dev/\n",
    });
    // A dirty host checkout: neither change may be imported or disturbed.
    await writeFile(join(repository, "README.md"), "# app (uncommitted edit)\n");
    await writeFile(join(repository, "notes.local"), "untracked\n");

    await db.insert(orgs).values({
      id: otherOrgId,
      name: "Other tenant",
      slug: `local-other-${suffix}`,
      settings: {},
    });
    await db.insert(projects).values([
      { id: projectId, orgId, name: "Local", slug: `local-${suffix}`, settings: {} },
      { id: githubProjectId, orgId, name: "GitHub", slug: `github-${suffix}`, settings: {} },
      {
        id: otherOrgProjectId,
        orgId: otherOrgId,
        name: "Other",
        slug: `local-other-${suffix}`,
        settings: {},
      },
    ]);
    const installation = newId("ghi");
    await db.insert(githubInstallations).values({
      id: installation,
      orgId,
      installationId: Math.floor(Math.random() * 1_000_000_000) + 50_000,
      accountId: 1,
      accountLogin: `acme-${suffix}`,
      targetType: "Organization",
    });
    await db.insert(projectRepositories).values({
      id: newId("repo"),
      orgId,
      projectId: githubProjectId,
      installationId: installation,
      owner: `acme-${suffix}`,
      name: "app",
      defaultBranch: "main",
      role: "primary",
    });
    const otherRole = newId("role");
    await db.insert(roles).values({
      id: otherRole,
      orgId: otherOrgId,
      name: "owner",
      description: "Other tenant owner",
      permissions: ["*"],
    });
    const [ownerKey, viewerKey, otherKey] = await Promise.all([
      generateApiKey("fak"),
      generateApiKey("fak"),
      generateApiKey("fak"),
    ]);
    ownerSecret = ownerKey.secret;
    viewerSecret = viewerKey.secret;
    otherOrgSecret = otherKey.secret;
    await db
      .insert(apiKeys)
      .values([
        keyRow(ownerKey, orgId, "role_bundled_owner"),
        keyRow(viewerKey, orgId, "role_bundled_viewer"),
        keyRow(otherKey, otherOrgId, otherRole),
      ]);
    domain = makeDomain();
    app = await buildApp(config, { rateLimitMax: 10_000, storyDomain: domain });
  });

  afterAll(async () => {
    if (docker) {
      const rows = await db.select().from(workspaces).where(eq(workspaces.orgId, orgId));
      for (const row of rows.filter((candidate) => candidate.provider === "docker")) {
        const environment = row.environment as { image?: string };
        if (!row.externalRef || !environment.image) continue;
        await runtime
          .destroy({
            id: row.id,
            image: environment.image,
            externalRef: row.externalRef,
            volumeRef: row.volumeRef,
          })
          .catch(() => undefined);
      }
    }
    await app?.close();
    await client.end();
    await rm(base, { recursive: true, force: true });
  });

  it("reports whether local repositories are enabled", async () => {
    const response = await api("GET", "/v1/local-repositories/status");
    expect(response.json()).toMatchObject({ enabled: true, roots: [approved] });
    expect(
      (
        await api("GET", "/v1/local-repositories/status", undefined, {
          authorization: `Bearer ${viewerSecret}`,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("rejects unauthenticated, read-only, and malicious registrations", async () => {
    const url = `/v1/projects/${projectId}/repos/local`;
    expect((await api("POST", url, { path: repository }, {})).statusCode).toBe(401);
    expect(
      (await api("POST", url, { path: repository }, { authorization: "Bearer not-a-key" }))
        .statusCode,
    ).toBe(401);
    const revoked = await generateApiKey("fak");
    await db
      .insert(apiKeys)
      .values({ ...keyRow(revoked, orgId, "role_bundled_owner"), revokedAt: new Date() });
    expect(
      (await api("POST", url, { path: repository }, { authorization: `Bearer ${revoked.secret}` }))
        .statusCode,
    ).toBe(401);
    expect(
      (await api("POST", url, { path: repository }, { authorization: `Bearer ${viewerSecret}` }))
        .statusCode,
    ).toBe(403);
    // Another tenant cannot even address this project.
    expect(
      (await api("POST", url, { path: repository }, { authorization: `Bearer ${otherOrgSecret}` }))
        .statusCode,
    ).toBe(404);
    await createRepository(join(outside, "secret"), { "secret.txt": "top secret\n" });
    await symlink(join(outside, "secret"), join(approved, "link-out"));
    for (const [path, code] of [
      ["relative/path", "local_repository_path_invalid"],
      [`${approved}/../outside/secret`, "local_repository_path_invalid"],
      [join(outside, "secret"), "local_repository_outside_roots"],
      [join(approved, "link-out"), "local_repository_outside_roots"],
      [join(approved, "missing"), "local_repository_not_found"],
    ] as const) {
      const response = await api("POST", url, { path });
      expect(response.json().error?.code, path).toBe(code);
    }
    expect(
      (await api("POST", url, { path: repository, alias: "../escape" })).json().error.code,
    ).toBe("local_repository_alias_invalid");
    expect(
      await db
        .select()
        .from(projectRepositories)
        .where(eq(projectRepositories.projectId, projectId)),
    ).toEqual([]);
  });

  it("registers a local repository with no GitHub configuration", async () => {
    const response = await api("POST", `/v1/projects/${projectId}/repos/local`, {
      path: repository,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      source: "local",
      sourcePath: repository,
      name: `app-${suffix}`,
      owner: "_local",
      role: "primary",
      defaultBranch: "main",
      installationId: null,
      manifestName: `local:app-${suffix}`,
      warnings: [],
    });
    expect(response.json().importContract).toMatch(/Uncommitted and untracked files/);
    const listed = await api("GET", `/v1/projects/${projectId}/repos`);
    expect(listed.json()).toEqual([
      expect.objectContaining({ source: "local", sourcePath: repository }),
    ]);
    expect(githubCalls).toEqual([]);
  });

  it("keeps repository sources separate and host paths tenant-scoped", async () => {
    expect(
      (await api("POST", `/v1/projects/${projectId}/repos/local`, { path: repository })).json()
        .error.code,
    ).toBe("local_repository_exists");
    const mixed = await api("POST", `/v1/projects/${githubProjectId}/repos/local`, {
      path: repository,
    });
    expect(mixed.json().error.code).toBe("repository_sources_mixed");
    const github = await api("POST", `/v1/projects/${projectId}/repos`, {
      owner: "acme",
      name: "other",
    });
    expect(github.statusCode).toBeGreaterThanOrEqual(400);
    const claimed = await api(
      "POST",
      `/v1/projects/${otherOrgProjectId}/repos/local`,
      { path: repository },
      { authorization: `Bearer ${otherOrgSecret}` },
    );
    expect(claimed.json().error.code).toBe("local_repository_claimed");
  });

  it("proposes starter configuration as a local patch instead of a pull request", async () => {
    const repo = (
      await db
        .select()
        .from(projectRepositories)
        .where(eq(projectRepositories.projectId, projectId))
    )[0];
    const kickstart = await api(
      "POST",
      `/v1/projects/${projectId}/repos/${repo?.id}/local-kickstart`,
      { answers: { startCmd: "pnpm dev" } },
    );
    expect(kickstart.statusCode, kickstart.body).toBe(200);
    const body = kickstart.json();
    // Existing project-owned files are never proposed again.
    expect(body.skipped).toEqual(expect.arrayContaining([".facility.yml", ".agents/builder.md"]));
    expect(body.files.map((file: { path: string }) => file.path).sort()).toEqual([
      ".agents/architect.md",
      ".agents/reviewer.md",
    ]);
    const clone = join(base, "kickstart-clone");
    await git(base, ["clone", "-q", repository, clone]);
    await writeFile(join(base, "kickstart.patch"), body.patch);
    await git(clone, ["apply", "--check", join(base, "kickstart.patch")]);
    expect(await git(repository, ["status", "--porcelain"])).not.toContain(".agents/architect.md");

    const githubKickstart = await api(
      "GET",
      `/v1/projects/${projectId}/kickstart/preview?repoId=${repo?.id}`,
    );
    expect(githubKickstart.json().error.code).toBe("github_repository_required");
    expect(githubCalls).toEqual([]);
  });

  it("never offers local review, or GitHub credentials, for a GitHub project", async () => {
    const response = await api(
      "GET",
      `/v1/projects/${githubProjectId}/workspace-stories/story_missing/local-review`,
    );
    expect(response.json().error.code).toBe("local_review_unavailable");
    expect(githubCalls).toEqual([]);
  });

  it("loads agents and configuration from the committed repository", async () => {
    const agents = await api("GET", `/v1/projects/${projectId}/story-agents`);
    expect(agents.statusCode, agents.body).toBe(200);
    expect(JSON.stringify(agents.json())).toContain("builder");
    expect(githubCalls).toEqual([]);
  });

  it("runs an agent turn in an imported workspace without GitHub credentials", async () => {
    const hostHead = await git(repository, ["rev-parse", "HEAD"]);
    const started = await api("POST", `/v1/projects/${projectId}/workspace-stories`, {
      title: "Add a feature",
      message: "Add feature one",
      agent: "builder",
      idempotency_key: randomUUID(),
    });
    expect(started.statusCode, started.body).toBe(202);
    storyId = started.json().story.id;
    const outcome = await dispatchQueued();
    expect(outcome).toMatchObject({ claimed: true, state: "succeeded" });
    expect(githubCalls).toEqual([]);

    const request = engine.requests[0];
    expect(request?.environment?.GH_TOKEN).toBeUndefined();
    expect(request?.environment?.FACILITY_GITHUB_CREDENTIALS).toBeUndefined();
    expect(request?.prompt).toMatch(/no remote and no GitHub access/);
    expect(request?.cwd).toBe(`repos/_local/app-${suffix}`);

    const workspace = (
      await db.select().from(workspaces).where(eq(workspaces.storyId, storyId))
    )[0];
    const primary = (
      await db
        .select()
        .from(projectRepositories)
        .where(eq(projectRepositories.projectId, projectId))
    )[0];
    expect(workspace?.sourceRevisions[primary?.id ?? ""]).toMatchObject({
      revision: hostHead,
      initialRevision: hostHead,
      branch: "main",
    });
    const sourceEvent = (
      await db
        .select()
        .from(turnEvents)
        .where(
          and(eq(turnEvents.turnId, request?.turnId ?? ""), eq(turnEvents.type, "turn.source")),
        )
    )[0];
    expect(sourceEvent?.data).toMatchObject({
      source: "local",
      configurationRevision: { commitSha: hostHead },
    });

    // Only committed content was imported, and the host checkout is untouched.
    const locator = request?.workspace as WorkspaceLocator;
    const inWorkspace = (script: string) =>
      runtime.exec(locator, { command: "sh", args: ["-c", script], cwd: request?.cwd });
    expect((await inWorkspace("cat README.md")).stdout).toBe("# app\n");
    expect((await inWorkspace("test -e notes.local")).exitCode).not.toBe(0);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe(
      "# app (uncommitted edit)\n",
    );
    expect(await git(repository, ["rev-parse", "HEAD"])).toBe(hostHead);
    expect(await git(repository, ["branch", "--list", "facility/*"])).toBe("");
  });

  it("shows committed changes for review and ties approval to one commit", async () => {
    const state = await api("GET", review());
    expect(state.statusCode, state.body).toBe(200);
    const body = state.json();
    branch = body.branch;
    expect(body).toMatchObject({
      currentBranch: branch,
      dirty: false,
      approval: { status: "none" },
      exportable: false,
      blockers: ["approval_required"],
    });
    expect(body.commits.map((commit: { subject: string }) => commit.subject)).toEqual([
      "feat: change 1",
    ]);
    expect(body.changedFiles).toEqual([{ status: "A", path: "feature-1.txt" }]);

    const mismatch = await api("POST", review("/approve"), { commit_sha: "a".repeat(40) });
    expect(mismatch.json().error.code).toBe("review_commit_mismatch");
    const viewerApprove = await api(
      "POST",
      review("/approve"),
      { commit_sha: body.headSha },
      { authorization: `Bearer ${viewerSecret}` },
    );
    expect(viewerApprove.statusCode).toBe(403);
    const otherTenant = await api("GET", review(), undefined, {
      authorization: `Bearer ${otherOrgSecret}`,
    });
    expect(otherTenant.statusCode).toBe(404);

    const approved = await api("POST", review("/approve"), {
      commit_sha: body.headSha,
      note: "Looks right",
    });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({
      approval: { status: "approved", commitSha: body.headSha, note: "Looks right" },
      exportable: true,
    });
  });

  it("runs configured checks against the tested commit", async () => {
    const checked = await api("POST", review("/checks"));
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().checks).toEqual([
      expect.objectContaining({ name: "feature", exitCode: 0, commitSha: checked.json().headSha }),
    ]);
  });

  it("invalidates approval when a revision adds commits", async () => {
    const requested = await api("POST", review("/request-changes"), {
      note: "Also add feature two",
    });
    expect(requested.json().approval.status).toBe("changes_requested");
    expect((await send("Also add feature two")).state).toBe("succeeded");
    const state = (await api("GET", review())).json();
    expect(state.commits).toHaveLength(2);
    expect(state.checks).toEqual([]);

    await api("POST", review("/approve"), { commit_sha: state.commits[0].sha }).then((response) =>
      expect(response.json().error.code).toBe("review_commit_mismatch"),
    );
    // An approval of an older commit never exports the newer head.
    const stale = await api("POST", review("/exports"));
    expect(stale.json().error.code).toBe("approval_required");
  });

  it("treats uncommitted work as unfinished", async () => {
    engine.leaveDirty = true;
    expect((await send("Draft something")).state).toBe("succeeded");
    engine.leaveDirty = false;
    const state = (await api("GET", review())).json();
    expect(state.dirty).toBe(true);
    expect(state.blockers).toContain("uncommitted_changes");
    const approve = await api("POST", review("/approve"), { commit_sha: state.headSha });
    expect(approve.json().error.code).toBe("uncommitted_changes");
    // The next revision commits the draft together with its own change.
    expect((await send("Commit everything")).state).toBe("succeeded");
    expect((await api("GET", review())).json().dirty).toBe(false);
  });

  it("exports approved history as a bundle and patch the user imports explicitly", async () => {
    const state = (await api("GET", review())).json();
    const approved = await api("POST", review("/approve"), { commit_sha: state.headSha });
    expect(approved.json().approval.status).toBe("approved");
    const exported = await api("POST", review("/exports"));
    expect(exported.statusCode, exported.body).toBe(200);
    const record = exported.json().export;
    expect(record).toMatchObject({
      headSha: state.headSha,
      baseSha: state.baseSha,
      commitCount: 3,
      branch,
    });
    expect(record.instructions[0]).toContain(record.reviewBranch);

    const bundle = await app.inject({
      method: "GET",
      url: review(`/exports/${record.id}/bundle`),
      headers: owner(),
    });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.headers["content-type"]).toContain("application/octet-stream");
    expect(bundle.headers["x-facility-bundle-sha256"]).toBe(record.bundleSha256);
    const patch = await app.inject({
      method: "GET",
      url: review(`/exports/${record.id}/patch`),
      headers: { authorization: `Bearer ${viewerSecret}` },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.body).toContain("feat: change 1");
    expect(
      (
        await app.inject({
          method: "GET",
          url: review(`/exports/${record.id}/bundle`),
          headers: { authorization: `Bearer ${otherOrgSecret}` },
        })
      ).statusCode,
    ).toBe(404);

    // Import into the user's (still dirty) checkout: a new branch, nothing merged.
    const file = join(base, `${record.id}.bundle`);
    await writeFile(file, bundle.rawPayload);
    const mainBefore = await git(repository, ["rev-parse", "main"]);
    await git(repository, [
      "fetch",
      "-q",
      file,
      `refs/heads/${branch}:refs/heads/${record.reviewBranch}`,
    ]);
    expect(await git(repository, ["rev-parse", record.reviewBranch])).toBe(state.headSha);
    expect(await git(repository, ["rev-parse", "main"])).toBe(mainBefore);
    expect(await readFile(join(repository, "README.md"), "utf8")).toBe(
      "# app (uncommitted edit)\n",
    );

    // The patch applies to a clean clone of the source commit.
    const clone = join(base, "patch-clone");
    await git(base, ["clone", "-q", repository, clone]);
    await writeFile(join(base, "story.patch"), patch.body);
    await git(clone, ["checkout", "-q", state.baseSha]);
    await git(clone, [
      "-c",
      "user.name=Reviewer",
      "-c",
      "user.email=reviewer@example.com",
      "am",
      "-q",
      join(base, "story.patch"),
    ]);
    expect(await git(clone, ["ls-files"])).toContain("feature-1.txt");

    // Exporting is not merging; the workspace stays available for further revisions.
    const after = (await api("GET", review())).json();
    expect(after.exports).toHaveLength(1);
    expect(after.approval.status).toBe("approved");
  });

  it("refreshes from the host explicitly without moving the story branch", async () => {
    const before = (await api("GET", review())).json();
    await writeFile(join(repository, "shared.txt"), "host change\n");
    await git(repository, ["add", "shared.txt"]);
    await git(repository, [
      "-c",
      "user.name=Host",
      "-c",
      "user.email=host@example.com",
      "commit",
      "-q",
      "-m",
      "host change",
    ]);
    const hostHead = await git(repository, ["rev-parse", "HEAD"]);

    // A new turn does not import the host change on its own.
    expect((await send("Add another feature")).state).toBe("succeeded");
    const unrefreshed = (await api("GET", review())).json();
    expect(unrefreshed.sourceRevision).toBe(before.sourceRevision);

    const refreshed = await api("POST", review("/refresh-source"), {});
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().refresh).toMatchObject({
      previous: before.sourceRevision,
      revision: hostHead,
      defaultBranchUpdated: true,
    });
    expect(refreshed.json().sourceRevision).toBe(hostHead);
    expect(refreshed.json().headSha).toBe(unrefreshed.headSha);
    expect(refreshed.json().initialSourceRevision).toBe(before.initialSourceRevision);
  });

  it("leaves export/import conflicts to the user's merge, never to Facility", async () => {
    // The story edits a file the host has changed independently since the import.
    engine.nextScript = `printf 'story version\\n' > shared.txt && git commit -q -am "feat: story edits shared"`;
    expect((await send("Edit the shared file")).state).toBe("succeeded");
    const state = (await api("GET", review())).json();
    expect(state.changedFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "shared.txt" })]),
    );
    await api("POST", review("/approve"), { commit_sha: state.headSha });
    const exported = (await api("POST", review("/exports"))).json().export;
    const earlier = (await api("GET", review())).json().exports.at(-1);
    expect(exported.reviewBranch).not.toBe(earlier.reviewBranch);

    const bundle = await app.inject({
      method: "GET",
      url: review(`/exports/${exported.id}/bundle`),
      headers: owner(),
    });
    const file = join(base, `${exported.id}.bundle`);
    await writeFile(file, bundle.rawPayload);
    const clone = join(base, "conflict-clone");
    await git(base, ["clone", "-q", repository, clone]);
    await git(clone, [
      "fetch",
      "-q",
      file,
      `refs/heads/${branch}:refs/heads/${exported.reviewBranch}`,
    ]);
    const mainBefore = await git(clone, ["rev-parse", "HEAD"]);
    const merge = await git(clone, [
      "-c",
      "user.name=Reviewer",
      "-c",
      "user.email=reviewer@example.com",
      "merge",
      "--no-edit",
      exported.reviewBranch,
    ]).then(
      () => "merged",
      () => "conflicted",
    );
    expect(merge).toBe("conflicted");
    expect(await git(clone, ["diff", "--name-only", "--diff-filter=U"])).toBe("shared.txt");
    await git(clone, ["merge", "--abort"]);
    expect(await git(clone, ["rev-parse", "HEAD"])).toBe(mainBefore);
    expect(await readFile(join(clone, "shared.txt"), "utf8")).toBe("host change\n");
  });

  it("resumes a story after the runtime loses its in-memory state", async () => {
    runtime = newRuntime();
    const workspace = (
      await db.select().from(workspaces).where(eq(workspaces.storyId, storyId))
    )[0];
    const revisions = workspace?.sourceRevisions;
    expect((await send("Continue after restart")).state).toBe("succeeded");
    const resumed = (await db.select().from(workspaces).where(eq(workspaces.storyId, storyId)))[0];
    expect(resumed?.sourceRevisions).toEqual(revisions);
    expect((await api("GET", review())).json().commits.length).toBeGreaterThanOrEqual(5);
  });

  it("imports again after an interrupted import left an empty repository", async () => {
    const started = await api("POST", `/v1/projects/${projectId}/workspace-stories`, {
      title: "Recover interrupted import",
      message: "Add a feature after a failed import",
      agent: "builder",
      idempotency_key: randomUUID(),
    });
    expect(started.statusCode, started.body).toBe(202);
    const row = (
      await db.select().from(workspaces).where(eq(workspaces.storyId, started.json().story.id))
    )[0];
    const environment = row?.environment as { image: string };
    const locator: WorkspaceLocator = {
      id: row?.id ?? "",
      image: environment.image,
      externalRef: row?.externalRef ?? "",
      volumeRef: row?.volumeRef ?? "",
    };
    // What an import that failed after `git init` leaves behind.
    const partial = await runtime.exec(locator, {
      command: "sh",
      args: ["-c", `mkdir -p repos/_local && git init -q repos/_local/app-${suffix}`],
    });
    expect(partial.exitCode, partial.stderr).toBe(0);
    expect(await dispatchQueued()).toMatchObject({ state: "succeeded" });
    const readme = await runtime.exec(locator, {
      command: "cat",
      args: ["README.md"],
      cwd: `repos/_local/app-${suffix}`,
    });
    expect(readme.stdout).toBe("# app\n");
  });

  it("runs concurrent stories in separate workspaces and branches", async () => {
    const starts = await Promise.all(
      ["First parallel story", "Second parallel story"].map((title) =>
        api("POST", `/v1/projects/${projectId}/workspace-stories`, {
          title,
          message: title,
          agent: "builder",
          idempotency_key: randomUUID(),
        }),
      ),
    );
    const ids = starts.map((response) => response.json().story.id as string);
    const outcomes = await Promise.all([dispatchQueued(), dispatchQueued()]);
    expect(outcomes.map((outcome) => outcome.claimed && outcome.state)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    const rows = await db
      .select({ storyId: workspaces.storyId, volumeRef: workspaces.volumeRef })
      .from(workspaces)
      .where(eq(workspaces.projectId, projectId))
      .orderBy(asc(workspaces.createdAt));
    const volumes = rows.filter((row) => ids.includes(row.storyId)).map((row) => row.volumeRef);
    expect(new Set(volumes).size).toBe(2);
    expect(githubCalls).toEqual([]);
  });

  it("refuses a registered path that is replaced after registration", async () => {
    const second = join(approved, `replaced-${suffix}`);
    await createRepository(second, {
      ".gitignore": ".dev/\n",
      ".facility.yml": manifest(`replaced-${suffix}`),
      ".agents/builder.md": agent("builder"),
    });
    const replacedProject = newId("proj");
    await db.insert(projects).values({
      id: replacedProject,
      orgId,
      name: "Replaced",
      slug: `replaced-${suffix}`,
      settings: {},
    });
    const registered = await api("POST", `/v1/projects/${replacedProject}/repos/local`, {
      path: second,
    });
    expect(registered.statusCode, registered.body).toBe(200);
    await rename(second, `${second}-moved`);
    await symlink(join(outside, "secret"), second);
    const started = await api("POST", `/v1/projects/${replacedProject}/workspace-stories`, {
      title: "Should not start",
      message: "Read the secret",
      agent: "builder",
      idempotency_key: randomUUID(),
    });
    expect(started.statusCode).toBe(403);
    expect(started.json().error.code).toBe("local_repository_outside_roots");
    expect(JSON.stringify(started.json())).not.toContain("top secret");
    // Moving the original back behind a different symlink is still a changed path.
    await rm(second);
    await symlink(`${second}-moved`, second);
    const moved = await api("POST", `/v1/projects/${replacedProject}/workspace-stories`, {
      title: "Should not start",
      message: "Still refused",
      agent: "builder",
      idempotency_key: randomUUID(),
    });
    expect(moved.json().error.code).toBe("local_repository_path_changed");
  });

  it("works when the default branch is named like the story branch namespace", async () => {
    const path = join(approved, `facility-branch-${suffix}`);
    await createRepository(path, {
      ".gitignore": ".dev/\n",
      ".facility.yml": manifest(`facility-branch-${suffix}`),
      ".agents/builder.md": agent("builder"),
      "README.md": "# namespaced\n",
    });
    await git(path, ["branch", "-m", "main", "facility"]);
    const namespaced = newId("proj");
    await db.insert(projects).values({
      id: namespaced,
      orgId,
      name: "Namespaced",
      slug: `namespaced-${suffix}`,
      settings: {},
    });
    const registered = await api("POST", `/v1/projects/${namespaced}/repos/local`, { path });
    expect(registered.json().defaultBranch).toBe("facility");
    const started = await api("POST", `/v1/projects/${namespaced}/workspace-stories`, {
      title: "Namespaced default branch",
      message: "Add a feature",
      agent: "builder",
      idempotency_key: randomUUID(),
    });
    expect(started.statusCode, started.body).toBe(202);
    const turnId = queued.shift() ?? "";
    const outcome = await domain.dispatcher.dispatch({ orgId, projectId: namespaced, turnId });
    expect(outcome).toMatchObject({ claimed: true, state: "succeeded" });
    const story = await api(
      "GET",
      `/v1/projects/${namespaced}/workspace-stories/${started.json().story.id}/local-review`,
    );
    expect(story.json()).toMatchObject({
      currentBranch: expect.stringMatching(/^facility\//),
      repository: { defaultBranch: "facility" },
    });
    expect(story.json().commits).toHaveLength(1);
  });

  it("never requires GitHub credentials to execute a local turn (regression)", async () => {
    const turnRows = await db.select().from(turns).where(eq(turns.projectId, projectId));
    expect(turnRows.length).toBeGreaterThanOrEqual(6);
    expect(turnRows.every((turn) => turn.state === "succeeded")).toBe(true);
    expect(githubCalls).toEqual([]);
  });

  function keyRow(
    key: Awaited<ReturnType<typeof generateApiKey>>,
    keyOrgId: string,
    roleId: string,
  ) {
    return {
      id: key.id,
      orgId: keyOrgId,
      name: `local-${key.last4}`,
      prefix: key.lookup,
      last4: key.last4,
      hash: key.hash,
      scopeType: "org",
      projectId: null,
      roleId,
    };
  }
});

function manifest(alias: string) {
  return `version: 1
repositories:
  primary: local:${alias}
  related: []
environment:
  start: mkdir -p .dev && printf running > .dev/status
  ready: test -f .dev/status
  checks:
    feature: test -f feature-1.txt
  services:
    app:
      port: 3000
`;
}

function agent(name: string) {
  return `---
name: ${name}
description: Implements stories.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
  - type: ui
---
Implement the request and commit it.
`;
}

async function createRepository(path: string, files: Record<string, string>) {
  await mkdir(path, { recursive: true });
  await git(path, ["init", "-q", "-b", "main"]);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(join(path, file, ".."), { recursive: true });
    await writeFile(join(path, file), content);
  }
  await git(path, ["add", "-A"]);
  await git(path, [
    "-c",
    "user.name=Facility Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
}

function git(cwd: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile("git", args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}
