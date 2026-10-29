import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceCredentialRenewal } from "../src/github/workspace-credential-renewal.js";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";
import type { WorkspaceHandle } from "../src/workspaces/runtime.js";

let root: string;
let runtime: FakeWorkspaceRuntime;
let workspace: WorkspaceHandle;
let realGh: string;
let session: WorkspaceCredentialRenewal;
let environment: Record<string, string>;
let file: string;
const report = vi.fn(async () => undefined);
function credentials(token: string): GithubWorkspaceCredentials {
  return {
    repositories: [{ owner: "acme", name: "app", role: "primary", defaultBranch: "main" }],
    gitIdentity: { name: "bot", email: "bot@example.com" },
    expiresAt: new Date(Date.now() + 3_600_000),
    environment: {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      FACILITY_GITHUB_CREDENTIALS: JSON.stringify({ "acme/app": token }),
    },
  };
}
function createSession(turn = "turn_integration") {
  return new WorkspaceCredentialRenewal(
    runtime,
    { ...workspace, expectedComputeRef: workspace.computeRef },
    turn,
    credentials("synthetic-first"),
    {
      issue: async () => credentials("synthetic-second"),
      authorized: async () => true,
      rememberSecrets: () => undefined,
      report,
      revoked: () => undefined,
    },
  );
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "facility-credential-renewal-"));
  const bin = join(root, "fixture-bin");
  await mkdir(bin);
  realGh = join(bin, "gh");
  await writeFile(
    realGh,
    `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path'); const token = process.env.GH_TOKEN || JSON.parse(fs.readFileSync(path.join(process.env.GH_CONFIG_DIR, 'hosts.yml'), 'utf8'))['github.com'].oauth_token; process.stdout.write(token);\n`,
    { mode: 0o700 },
  );
  runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
  workspace = await runtime.create({
    id: "ws_0123456789abcdef0123456789abcdef",
    image: "fake",
    environment: { PATH: `${bin}:${process.env.PATH}` },
  });
  session = createSession();
  const initial = await session.start();
  environment = session.environment(initial, true);
  file = join(dirname(configDirectory()), "credentials.json");
});
afterEach(async () => {
  await session?.stop();
  await rm(root, { recursive: true, force: true });
});
function configDirectory() {
  const value = environment.GH_CONFIG_DIR;
  if (!value) throw new Error("Missing turn-local gh configuration");
  return value;
}
async function gitCredential(host = "github.com", repository = "acme/app.git", protocol = "https") {
  return runtime.exec(workspace, {
    command: "git",
    args: ["credential", "fill"],
    env: { ...environment, GIT_TERMINAL_PROMPT: "0" },
    stdin: `protocol=${protocol}\nhost=${host}\npath=${repository}\n\n`,
  });
}
it("Git and gh consume renewed credentials after initial expiry without restarting the agent environment", async () => {
  expect((await gitCredential()).stdout).toContain("password=synthetic-first");
  expect(
    (
      await runtime.exec(workspace, {
        command: "gh",
        args: ["api", "repos/acme/app"],
        env: environment,
      })
    ).stdout,
  ).toBe("synthetic-first");
  const old = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify({ ...old, expiresAt: Date.now() - 1 }), { mode: 0o600 });
  expect((await gitCredential()).exitCode).not.toBe(0);
  await session.renew();
  expect((await gitCredential()).stdout).toContain("password=synthetic-second");
  expect(
    (
      await runtime.exec(workspace, {
        command: "gh",
        args: ["api", "repos/acme/app"],
        env: { ...environment, GH_TOKEN: "stale-inherited-value" },
      })
    ).stdout,
  ).toBe("synthetic-second");
  // A login shell can reset PATH. The real CLI still reads the renewed scoped config.
  expect(
    (
      await runtime.exec(workspace, {
        command: realGh,
        args: ["api", "repos/acme/app"],
        env: { ...environment, PATH: "/usr/bin:/bin" },
      })
    ).stdout,
  ).toBe("synthetic-second");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(join(configDirectory(), "hosts.yml"))).mode & 0o777).toBe(0o600);
});
it("denies foreign repositories, hosts and cleartext Git requests without returning a credential", async () => {
  for (const args of [
    ["github.com", "other/private.git", "https"],
    ["example.com", "acme/app.git", "https"],
    ["github.com", "acme/app.git", "http"],
    ["github.com", "../acme/app.git", "https"],
  ]) {
    const result = await gitCredential(...(args as [string, string, string]));
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("synthetic-");
  }
  for (const args of [
    ["api", "--hostname", "example.com", "user"],
    ["api", "https://example.com/user"],
    ["pr", "list", "-R", "other/private"],
  ]) {
    const result = await runtime.exec(workspace, { command: "gh", args, env: environment });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("synthetic-");
  }
});
it("fails closed on malformed, public or symlinked credential files", async () => {
  const saved = await readFile(file, "utf8");
  await writeFile(file, "{ malformed synthetic-secret");
  const result = await gitCredential();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).not.toContain("synthetic-secret");
  await writeFile(file, saved);
  await chmod(file, 0o644);
  expect((await gitCredential()).exitCode).not.toBe(0);
  await rm(file);
  const foreign = join(root, "foreign.json");
  await writeFile(foreign, saved, { mode: 0o600 });
  await symlink(foreign, file);
  expect((await gitCredential()).exitCode).not.toBe(0);
});
it("removes temporary credentials but retains real local commits and files across a resumed turn", async () => {
  await writeFile(join(workspace.volumeRef, "kept.txt"), "retained work");
  for (const args of [
    ["init", "-q"],
    ["add", "kept.txt"],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "fixture"],
  ]) {
    expect((await runtime.exec(workspace, { command: "git", args })).exitCode).toBe(0);
  }
  const before = (await runtime.exec(workspace, { command: "git", args: ["rev-parse", "HEAD"] }))
    .stdout;
  await session.stop();
  expect((await gitCredential()).exitCode).not.toBe(0);
  await expect(readFile(join(configDirectory(), "hosts.yml"))).rejects.toThrow();
  session = createSession("turn_resumed");
  environment = session.environment(await session.start(), true);
  expect(
    (await runtime.exec(workspace, { command: "git", args: ["rev-parse", "HEAD"] })).stdout,
  ).toBe(before);
  expect(await readFile(join(workspace.volumeRef, "kept.txt"), "utf8")).toBe("retained work");
  expect((await gitCredential()).stdout).toContain("password=synthetic-first");
});

it("the real GitHub CLI consumes rotated configuration offline without a migration lookup", async () => {
  const execute = promisify(execFile);
  const env = {
    ...process.env,
    ...environment,
    HTTPS_PROXY: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    GH_HOST: "github.com",
  };
  // Resolve gh using the controller PATH, bypassing the deliberately synthetic fixture binary.
  const options = { env: { ...env, PATH: process.env.PATH }, timeout: 10_000 };
  expect(
    (await execute("gh", ["auth", "token", "--hostname", "github.com"], options)).stdout.trim(),
  ).toBe("synthetic-first");
  await session.renew();
  expect(
    (await execute("gh", ["auth", "token", "--hostname", "github.com"], options)).stdout.trim(),
  ).toBe("synthetic-second");
});

it("ignores a stale lower-priority Git credential helper", async () => {
  const cached = join(root, "cached-helper.cjs");
  await writeFile(
    cached,
    "process.stdout.write('username=x-access-token\\npassword=stale-cached-credential\\n\\n');",
  );
  const config = join(root, "cached.gitconfig");
  await writeFile(config, "[credential]\nhelper = !node " + cached + "\n");
  environment.GIT_CONFIG_GLOBAL = config;
  expect((await gitCredential()).stdout).toContain("password=synthetic-first");
});
