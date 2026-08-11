import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliveryFailure, emitRunEvents, prepareWorkspace, shipGitChanges } from "../src/index.js";
import { RunPhaseRecorder } from "../src/phases.js";
import type { RunBundle } from "../src/types.js";

type RecordedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
};

type JsonReply = { status?: number; body?: unknown };

const ENV_KEYS = [
  "FACILITY_API_URL",
  "RUN_ID",
  "RUNNER_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "FACILITY_PROJECT_ID",
  "FACILITY_PLATFORM_KEY",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
] as const;

let cleanups: Array<() => Promise<void>> = [];
let handlerFailures: unknown[] = [];
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let previousFetch: typeof fetch;

beforeEach(() => {
  cleanups = [];
  handlerFailures = [];
  previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >;
  previousFetch = globalThis.fetch;
  globalThis.fetch = async (request, init) => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error(`integration test blocked external request to ${url.origin}`);
    }
    return previousFetch(request, init);
  };
});

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    for (const key of ENV_KEYS) restoreEnv(key, previousEnv[key]);
    globalThis.fetch = previousFetch;
  }
  failures.push(...handlerFailures);
  if (failures.length > 0) throw new AggregateError(failures, "integration fixture cleanup failed");
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function startJsonServer(
  respond: (request: RecordedRequest) => JsonReply | Promise<JsonReply>,
) {
  const requests: RecordedRequest[] = [];
  const handlerErrors: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const recorded = {
        method: request.method ?? "GET",
        path: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const reply = await respond(recorded);
      response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body ?? {}));
    } catch (error) {
      handlerErrors.push(error);
      handlerFailures.push(error);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    handlerErrors,
  };
}

async function startFacilityServer(token: string) {
  return startJsonServer((request) => {
    if (request.method === "POST" && request.path === "/internal/runs/run_integration/push-token") {
      if (request.headers.authorization !== "Bearer runner-integration-token") {
        return { status: 401, body: { message: "invalid runner token" } };
      }
      return { body: { token } };
    }
    if (request.method === "POST" && request.path === "/internal/runs/run_integration/events") {
      if (request.headers.authorization !== "Bearer runner-integration-token") {
        return { status: 401, body: { message: "invalid runner token" } };
      }
      return { body: {} };
    }
    return { status: 404, body: { message: `unexpected Facility route ${request.path}` } };
  });
}

type GithubScenario =
  | "success"
  | "expired"
  | "revoked"
  | "cross-repository"
  | "stale-head"
  | "missing-oid";

async function startGithubServer(input: {
  scenario: GithubScenario;
  token: string;
  baseSha: string;
  branch?: string;
}) {
  const refs = new Map<string, string>([[input.branch ?? "main", input.baseSha]]);
  const allowedRepo = "acme/widget";
  let committed = false;
  const local = await startJsonServer((request) => {
    if (request.headers.authorization !== `Bearer ${input.token}`) {
      return { status: 401, body: { message: "unexpected GitHub token" } };
    }
    if (input.scenario === "expired") {
      return { status: 401, body: { message: `expired token ${input.token}` } };
    }
    if (input.scenario === "revoked") {
      return { status: 403, body: { message: `revoked token ${input.token}` } };
    }
    const restRepo = /^\/repos\/([^/]+\/[^/]+)\//.exec(request.path)?.[1];
    if (restRepo && restRepo !== allowedRepo) {
      return {
        status: 403,
        body: { message: `token ${input.token} is scoped to another repository` },
      };
    }

    const refPrefix = "/repos/acme/widget/git/ref/heads/";
    if (request.method === "GET" && request.path.startsWith(refPrefix)) {
      const branch = request.path.slice(refPrefix.length);
      const sha = refs.get(branch);
      return sha ? { body: { object: { sha } } } : { status: 404, body: { message: "Not Found" } };
    }
    if (request.method === "POST" && request.path === "/repos/acme/widget/git/refs") {
      const payload = JSON.parse(request.body) as { ref: string; sha: string };
      const branch = payload.ref.replace(/^refs\/heads\//, "");
      if (payload.sha !== input.baseSha || refs.has(branch)) {
        return { status: 422, body: { message: "invalid ref creation" } };
      }
      refs.set(branch, input.scenario === "stale-head" ? "concurrent_sha" : payload.sha);
      return { status: 201, body: { ref: payload.ref, object: { sha: payload.sha } } };
    }
    if (request.method === "POST" && request.path === "/graphql") {
      const payload = JSON.parse(request.body) as {
        variables: {
          input: {
            branch: { repositoryNameWithOwner: string; branchName: string };
            expectedHeadOid: string;
          };
        };
      };
      const mutation = payload.variables.input;
      if (mutation.branch.repositoryNameWithOwner !== allowedRepo) {
        return { status: 403, body: { message: "repository scope mismatch" } };
      }
      const current = refs.get(mutation.branch.branchName);
      if (mutation.expectedHeadOid !== current) {
        return { body: { errors: [{ message: "expectedHeadOid is stale or replayed" }] } };
      }
      if (input.scenario === "missing-oid") {
        return { body: { data: { createCommitOnBranch: { commit: {} } } } };
      }
      committed = true;
      refs.set(mutation.branch.branchName, "signed_sha");
      return {
        body: { data: { createCommitOnBranch: { commit: { oid: "signed_sha" } } } },
      };
    }
    return { status: 404, body: { message: `unexpected GitHub route ${request.path}` } };
  });

  const originalUrls: string[] = [];
  const githubFetch: typeof fetch = async (request, init) => {
    const url = new URL(
      typeof request === "string" ? request : request instanceof URL ? request.href : request.url,
    );
    if (url.origin !== "https://api.github.com") {
      throw new Error(`unexpected external GitHub origin ${url.origin}`);
    }
    originalUrls.push(url.href);
    return globalThis.fetch(new URL(`${url.pathname}${url.search}`, local.origin), init);
  };
  return {
    ...local,
    refs,
    originalUrls,
    githubFetch,
    committed: () => committed,
  };
}

function runBundle(cloneUrl: string, overrides: Partial<RunBundle> = {}): RunBundle {
  return {
    runId: "run_integration",
    mode: "builder",
    engine: "codex",
    contract: "Deliver the integration fixture.",
    skills: [],
    engineConfig: {},
    repo: { cloneUrl, branch: "main", expectedHeadSha: null, installationTokenRef: null },
    harness: null,
    packageInstallCmd: null,
    provisionCmd: null,
    checkCmds: [],
    gatewayUrls: { anthropic: "https://anthropic.test", openai: "https://openai.test" },
    scope: {},
    timeoutMin: 5,
    ...overrides,
  };
}

async function deliveryFixture(
  commitMessage: string,
  pullRequestTitle = "fix: deliver signed task",
  {
    repair = false,
    repairCodeChange = false,
    repairTitleAvailable = true,
  }: { repair?: boolean; repairCodeChange?: boolean; repairTitleAvailable?: boolean } = {},
) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "facility-github-delivery-"));
  cleanups.push(() => rm(fixtureRoot, { recursive: true, force: true }));
  const origin = join(fixtureRoot, "origin");
  const workspace = join(fixtureRoot, "workspace");
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  await mkdir(origin);
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: origin });
  execFileSync("git", ["config", "user.email", "facility@example.invalid"], { cwd: origin });
  execFileSync("git", ["config", "user.name", "Facility Integration"], { cwd: origin });
  await writeFile(join(origin, "README.md"), "# Signed delivery fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: origin });
  execFileSync("git", ["commit", "-m", "test: seed signed delivery fixture"], { cwd: origin });
  if (repair) {
    execFileSync("git", ["checkout", "-b", "feature/task"], { cwd: origin });
    await writeFile(join(origin, "existing.md"), "Existing pull request change.\n");
    execFileSync("git", ["add", "existing.md"], { cwd: origin });
    execFileSync("git", ["commit", "-m", "docs: document the existing behavior"], {
      cwd: origin,
    });
  }

  const bundle = runBundle(
    origin,
    repair
      ? {
          mode: "address_review",
          repo: {
            cloneUrl: origin,
            branch: "feature/task",
            expectedHeadSha: null,
            installationTokenRef: null,
          },
          scope: {
            pullRequest: {
              base: "main",
              ...(repairTitleAvailable ? { title: pullRequestTitle } : {}),
            },
          },
        }
      : {},
  );
  await prepareWorkspace(
    bundle,
    "virtual-integration-key",
    {
      platformKey: null,
      platformApiUrl: "https://platform.test",
      projectId: "project_integration",
      repoToken: null,
    },
    workspace,
  );
  bundle.repo.cloneUrl = "https://github.com/acme/widget.git";
  const repo = join(workspace, "repo");
  if (repair && !repairCodeChange) {
    await writeFile(
      join(repo, "README.md"),
      "# Signed delivery fixture\n\nClarify the existing behavior.\n",
    );
  } else {
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, "src", "task.ts"), "export const delivered = true;\n");
  }
  await mkdir(join(repo, ".agent-sdlc"), { recursive: true });
  await writeFile(
    join(repo, ".agent-sdlc", "delivery.json"),
    JSON.stringify(
      repair
        ? { branch: "feature/task", commitMessage }
        : {
            branch: "feature/task",
            commitMessage,
            pullRequest: {
              title: pullRequestTitle,
              body: "## Summary\n\n- Deliver the signed task.",
            },
          },
    ),
  );
  const baseSha = execFileSync("git", ["rev-parse", `origin/${repair ? "feature/task" : "main"}`], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  return { bundle, workspace, repo, baseSha };
}

function configureRunner(facilityOrigin: string) {
  process.env.FACILITY_API_URL = facilityOrigin;
  process.env.RUN_ID = "run_integration";
  process.env.RUNNER_TOKEN = "runner-integration-token";
}

it("delivers phase events through the authenticated runner API", async () => {
  const facility = await startFacilityServer("github-integration-token");
  configureRunner(facility.origin);
  const phases = new RunPhaseRecorder(emitRunEvents, () => 100);

  await phases.measure(
    "workspace",
    async () => undefined,
    () => ({ outcome: "succeeded" }),
  );

  const requests = facilityRequests(facility.requests, "/events");
  expect(requests).toHaveLength(1);
  expect(
    requests.every(
      (request) => request.headers.authorization === "Bearer runner-integration-token",
    ),
  ).toBe(true);
  expect(requests.map((request) => JSON.parse(request.body))).toEqual([
    [
      {
        type: "phase",
        data: {
          name: "workspace",
          status: "completed",
          duration_ms: 0,
          outcome: "succeeded",
        },
      },
    ],
  ]);
});

function facilityRequests(requests: RecordedRequest[], suffix: string) {
  return requests.filter((request) => request.path.endsWith(suffix));
}

function failureEvent(requests: RecordedRequest[]) {
  const events = facilityRequests(requests, "/events");
  expect(events).toHaveLength(1);
  const body = JSON.parse(events[0]?.body ?? "null") as Array<{
    type: string;
    data: { kind: string; error: string };
  }>;
  expect(body).toHaveLength(1);
  expect(body[0]).toMatchObject({ type: "artifact_error", data: { kind: "git_push_failed" } });
  return body[0]?.data.error ?? "";
}

describe.sequential("signed GitHub delivery integration", () => {
  it("publishes the real workspace diff with exact Conventional Commit metadata", async () => {
    const fixture = await deliveryFixture(
      "fix: deliver signed task\n\nExplain the migration.\n\nBREAKING CHANGE: use the new task API",
      "fix!: deliver signed task",
    );
    const token = "installation-token-success";
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "success",
      token,
      baseSha: fixture.baseSha,
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toEqual({
      branch: "feature/task",
      headSha: "signed_sha",
      changed: true,
      pullRequestTitle: "fix!: deliver signed task",
      pullRequestBody: "## Summary\n\n- Deliver the signed task.",
    });
    expect(deliveryFailure(fixture.bundle, result)).toBeNull();
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture.repo, encoding: "utf8" }).trim(),
    ).toBe(fixture.baseSha);
    expect(facilityRequests(facility.requests, "/push-token")).toHaveLength(1);
    expect(facilityRequests(facility.requests, "/events")).toHaveLength(0);
    expect(github.originalUrls).toEqual([
      "https://api.github.com/repos/acme/widget/git/ref/heads/feature/task",
      "https://api.github.com/repos/acme/widget/git/refs",
      "https://api.github.com/graphql",
    ]);
    expect(github.requests.map((request) => request.headers.authorization)).toEqual([
      `Bearer ${token}`,
      `Bearer ${token}`,
      `Bearer ${token}`,
    ]);
    const ref = JSON.parse(github.requests[1]?.body ?? "null");
    expect(ref).toEqual({ ref: "refs/heads/feature/task", sha: fixture.baseSha });
    const mutation = JSON.parse(github.requests[2]?.body ?? "null");
    expect(mutation.variables.input).toMatchObject({
      branch: { repositoryNameWithOwner: "acme/widget", branchName: "feature/task" },
      expectedHeadOid: fixture.baseSha,
      message: {
        headline: "fix: deliver signed task",
        body: "Delivered by Facility run run_integration.\n\nExplain the migration.\n\nBREAKING CHANGE: use the new task API",
      },
      fileChanges: {
        additions: [
          {
            path: "src/task.ts",
            contents: Buffer.from("export const delivered = true;\n").toString("base64"),
          },
        ],
      },
    });
    expect(JSON.stringify(mutation.variables.input.fileChanges)).not.toContain("delivery.json");
    expect(github.refs.get("feature/task")).toBe("signed_sha");
    expect(github.committed()).toBe(true);
    expect(facility.handlerErrors).toEqual([]);
    expect(github.handlerErrors).toEqual([]);
  });

  it.each([
    ["control character", "fix: render \u001b[31mred output", "commit_not_conventional"],
    [
      "co-author footer",
      "fix: deliver task\n\nCo-authored-by: Intruder <intruder@example.test>",
      "commit_not_conventional",
    ],
    [
      "missing body separator",
      "fix: replace the contract\nBREAKING CHANGE: migrate the client",
      "commit_body_separator_invalid",
    ],
    [
      "oversized prefix",
      `feat(${"a".repeat(112)}): x`,
      "github_signed_delivery_commit_subject_too_long",
    ],
  ])("rejects a malformed %s before acquiring a push token", async (_name, message, error) => {
    const fixture = await deliveryFixture(message);
    const token = `installation-token-malformed-${_name}`;
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "success",
      token,
      baseSha: fixture.baseSha,
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toMatchObject({ changed: true, pushError: expect.stringContaining(error) });
    expect(result).not.toHaveProperty("headSha");
    expect(deliveryFailure(fixture.bundle, result)).toBe("delivery_push_failed");
    expect(facilityRequests(facility.requests, "/push-token")).toHaveLength(0);
    expect(github.originalUrls).toEqual([]);
    expect(failureEvent(facility.requests)).toContain(error);
    expect(github.committed()).toBe(false);
  });

  it("rejects mismatched commit and PR-title impact before acquiring a push token", async () => {
    const fixture = await deliveryFixture(
      "fix: replace the public contract\n\nBREAKING CHANGE: migrate the client",
    );
    const token = "installation-token-impact-mismatch";
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "success",
      token,
      baseSha: fixture.baseSha,
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toMatchObject({
      changed: true,
      pushError: expect.stringContaining("agent_delivery_release_impact_mismatch"),
    });
    expect(result).not.toHaveProperty("headSha");
    expect(deliveryFailure(fixture.bundle, result)).toBe("delivery_push_failed");
    expect(facilityRequests(facility.requests, "/push-token")).toHaveLength(0);
    expect(github.originalUrls).toEqual([]);
    expect(failureEvent(facility.requests)).toContain("release_impact_mismatch");
    expect(github.committed()).toBe(false);
  });

  it("publishes a repair that does not raise the existing PR range impact", async () => {
    const fixture = await deliveryFixture(
      "docs: clarify the existing behavior",
      "docs: document the existing behavior",
      { repair: true },
    );
    const token = "installation-token-repair-success";
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "success",
      token,
      baseSha: fixture.baseSha,
      branch: "feature/task",
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toEqual({ branch: "feature/task", headSha: "signed_sha", changed: true });
    expect(facilityRequests(facility.requests, "/push-token")).toHaveLength(1);
    expect(github.originalUrls).toEqual(["https://api.github.com/graphql"]);
    expect(github.committed()).toBe(true);
  });

  it("publishes an impact-raising repair after the PR is truthfully retitled", async () => {
    const fixture = await deliveryFixture(
      "fix: correct the task behavior",
      "fix: correct the task behavior",
      { repair: true, repairCodeChange: true },
    );
    const token = "installation-token-retitled-repair-success";
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "success",
      token,
      baseSha: fixture.baseSha,
      branch: "feature/task",
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toEqual({ branch: "feature/task", headSha: "signed_sha", changed: true });
    expect(facilityRequests(facility.requests, "/push-token")).toHaveLength(1);
    expect(github.originalUrls).toEqual(["https://api.github.com/graphql"]);
    expect(github.committed()).toBe(true);
  });

  it.each([
    ["has an incompatible docs title", true],
    ["has no authoritative title", false],
  ] as const)("rejects an impact-raising repair that %s before acquiring a push token", async (_case, repairTitleAvailable) => {
    const fixture = await deliveryFixture(
      "fix: correct the task behavior",
      "docs: document the existing behavior",
      { repair: true, repairCodeChange: true, repairTitleAvailable },
    );
    const token = `installation-token-repair-impact-mismatch-${repairTitleAvailable}`;
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "success",
      token,
      baseSha: fixture.baseSha,
      branch: "feature/task",
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toMatchObject({
      changed: true,
      pushError: expect.stringContaining("agent_delivery_release_impact_mismatch"),
    });
    expect(facilityRequests(facility.requests, "/push-token")).toHaveLength(0);
    expect(github.originalUrls).toEqual([]);
    expect(failureEvent(facility.requests)).toContain("release_impact_mismatch");
    expect(github.committed()).toBe(false);
  });

  it.each([
    ["expired", "expired"],
    ["revoked", "revoked"],
    ["cross-repository", "another repository"],
  ] as const)("fails closed when the installation token is %s", async (scenario, error) => {
    const fixture = await deliveryFixture("fix: deliver signed task");
    if (scenario === "cross-repository") {
      fixture.bundle.repo.cloneUrl = "https://github.com/other/widget.git";
    }
    const token = `installation-token-${scenario}`;
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({ scenario, token, baseSha: fixture.baseSha });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toMatchObject({ changed: true, pushError: expect.stringContaining(error) });
    expect(result).not.toHaveProperty("headSha");
    expect(deliveryFailure(fixture.bundle, result)).toBe("delivery_push_failed");
    expect(facilityRequests(facility.requests, "/push-token")).toHaveLength(1);
    expect(github.originalUrls).toEqual([
      `https://api.github.com/repos/${scenario === "cross-repository" ? "other/widget" : "acme/widget"}/git/ref/heads/feature/task`,
    ]);
    expect(github.refs.has("feature/task")).toBe(false);
    expect(github.committed()).toBe(false);
    const eventError = failureEvent(facility.requests);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(eventError).not.toContain(token);
    expect(eventError).not.toContain("runner-integration-token");
    expect(eventError).toContain("«redacted»");
  });

  it("rejects a stale or replayed expected head without reporting a commit", async () => {
    const fixture = await deliveryFixture("fix: deliver signed task");
    const token = "installation-token-stale-head";
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "stale-head",
      token,
      baseSha: fixture.baseSha,
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toMatchObject({
      changed: true,
      pushError: expect.stringContaining("expectedHeadOid is stale or replayed"),
    });
    expect(result).not.toHaveProperty("headSha");
    expect(deliveryFailure(fixture.bundle, result)).toBe("delivery_push_failed");
    expect(github.originalUrls).toHaveLength(3);
    expect(github.refs.get("feature/task")).toBe("concurrent_sha");
    expect(github.committed()).toBe(false);
    expect(failureEvent(facility.requests)).toContain("stale or replayed");
  });

  it("rejects a malformed success response with no signed commit OID", async () => {
    const fixture = await deliveryFixture("fix: deliver signed task");
    const token = "installation-token-missing-oid";
    const facility = await startFacilityServer(token);
    const github = await startGithubServer({
      scenario: "missing-oid",
      token,
      baseSha: fixture.baseSha,
    });
    configureRunner(facility.origin);

    const result = await shipGitChanges(fixture.bundle, {
      root: fixture.workspace,
      githubFetch: github.githubFetch,
    });

    expect(result).toMatchObject({
      changed: true,
      pushError: expect.stringContaining("github_signed_delivery_missing_commit_oid"),
    });
    expect(result).not.toHaveProperty("headSha");
    expect(deliveryFailure(fixture.bundle, result)).toBe("delivery_push_failed");
    expect(github.refs.get("feature/task")).toBe(fixture.baseSha);
    expect(github.committed()).toBe(false);
    expect(failureEvent(facility.requests)).toContain("missing_commit_oid");
    expect(facility.handlerErrors).toEqual([]);
    expect(github.handlerErrors).toEqual([]);
  });

  it("keeps the delivery manifest excluded from the repository diff", async () => {
    const fixture = await deliveryFixture("fix: deliver signed task");
    const exclude = await readFile(join(fixture.repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".agent-sdlc/delivery.json");
    expect(
      execFileSync("git", ["status", "--short", "--ignored"], {
        cwd: fixture.repo,
        encoding: "utf8",
      }),
    ).toContain("!! .agent-sdlc/");
  });
});
