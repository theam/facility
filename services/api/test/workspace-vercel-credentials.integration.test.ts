import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceCredentialRenewal } from "../src/github/workspace-credential-renewal.js";
import type { GithubWorkspaceCredentials } from "../src/github/workspace-credentials.js";

const sandboxApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@vercel/sandbox", () => ({ Sandbox: sandboxApi }));

import { VercelWorkspaceRuntime } from "../src/workspaces/vercel.js";

let root: string;
let renewal: WorkspaceCredentialRenewal | undefined;
afterEach(async () => {
  await renewal?.stop();
  renewal = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

async function provider() {
  root = await mkdtemp(join(tmpdir(), "facility-pinned-vercel-"));
  const bin = join(root, "provider-bin");
  await mkdir(bin);
  // Model Linux sudo's env_reset and secure_path with real child processes.
  // Nothing implicitly forwards secrets from the provider's ambient environment.
  await writeFile(
    join(bin, "sudo"),
    `#!${process.execPath}
const cp = require('node:child_process');
const args = process.argv.slice(2), env = {};
while (args.length && args[0] !== '--') {
  const arg = args.shift();
  if (arg === '-u') { if (args.shift() !== 'node') process.exit(1); }
  else if (arg.startsWith('--preserve-env=')) {
    for (const key of arg.slice(15).split(',')) if (process.env[key] !== undefined) env[key] = process.env[key];
  } else process.exit(2);
}
args.shift();
env.PATH = process.env.PROVIDER_SECURE_PATH;
const result = cp.spawnSync(args.shift(), args, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(bin, "gh"),
    `#!${process.execPath}
if (process.env.UNREQUESTED_PROVIDER_SECRET) process.exit(9);
process.stdout.write(process.env.GH_TOKEN);
`,
    { mode: 0o700 },
  );
  const path = `${bin}:${process.env.PATH}`;
  const runCommand = vi.fn((params) => {
    const child = spawn(params.cmd, params.args, {
      cwd: params.cwd === "/workspace" ? root : params.cwd,
      env: {
        PATH: path,
        PROVIDER_SECURE_PATH: path,
        UNREQUESTED_PROVIDER_SECRET: "must-not-reach-agent",
        ...Object.fromEntries(
          Object.entries(params.env ?? {}).map(([key, value]) => [
            key,
            String(value).replaceAll("/workspace/", `${root}/`),
          ]),
        ),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const finished = new Promise<{ exitCode: number }>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
    });
    return {
      cmdId: "cmd_fixture",
      wait: () => finished,
      logs: async function* () {
        await finished;
        yield { stream: "stdout", data: stdout };
        yield { stream: "stderr", data: stderr };
      },
      kill: async () => {
        child.kill();
      },
    };
  });
  const asUser = vi.fn(() => {
    throw new Error("must not use an auto-resuming command API");
  });
  sandboxApi.get.mockResolvedValue({
    status: "running",
    currentSession: () => ({ sessionId: "session_original", runCommand }),
    asUser,
  });
  const workspace = {
    id: "ws_0123456789abcdef",
    externalRef: "ws_0123456789abcdef",
    volumeRef: "snap_retained",
    image: "runner:retained",
    expectedComputeRef: "session_original",
  };
  return { runtime: new VercelWorkspaceRuntime(), workspace, runCommand, asUser };
}

function credentials(token: string): GithubWorkspaceCredentials {
  return {
    repositories: [{ owner: "acme", name: "app", role: "primary", defaultBranch: "main" }],
    gitIdentity: { name: "fixture", email: "fixture@example.test" },
    expiresAt: new Date(Date.now() + 3_600_000),
    environment: {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      FACILITY_GITHUB_CREDENTIALS: JSON.stringify({ "acme/app": token }),
    },
  };
}

it("installs, rotates and removes credentials across pinned Vercel sudo without exposing values in argv", async () => {
  const { runtime, workspace, runCommand, asUser } = await provider();
  const retained = join(root, "retained-work.txt");
  await writeFile(retained, "local work must survive");
  renewal = new WorkspaceCredentialRenewal(
    runtime,
    workspace,
    "turn_retained",
    credentials("synthetic-first"),
    {
      issue: async () => credentials("synthetic-second"),
      authorized: async () => true,
      rememberSecrets: () => undefined,
      report: async () => undefined,
      revoked: () => undefined,
    },
  );
  const environment = renewal.environment(await renewal.start(), true);
  // PATH must select the managed wrapper despite sudo's secure_path reset.
  const gh = () =>
    runtime.exec(workspace, { command: "gh", args: ["api", "repos/acme/app"], env: environment });
  expect(await gh()).toMatchObject({ exitCode: 0, stdout: "synthetic-first" });
  await renewal.renew();
  expect(await gh()).toMatchObject({ exitCode: 0, stdout: "synthetic-second" });
  expect(
    await runtime.exec(workspace, {
      command: "gh",
      args: ["api", "repos/other/private", "-R", "other/private"],
      env: environment,
    }),
  ).toMatchObject({ exitCode: 1, stdout: "" });
  await renewal.stop();
  await expect(
    readFile(join(root, ".facility/github/turn_retained/credentials.json")),
  ).rejects.toThrow();
  expect(await readFile(retained, "utf8")).toBe("local work must survive");
  const argumentsOnly = JSON.stringify(runCommand.mock.calls.map(([input]) => input.args));
  expect(argumentsOnly).not.toContain("synthetic-first");
  expect(argumentsOnly).not.toContain("synthetic-second");
  expect(asUser).not.toHaveBeenCalled();
  expect(sandboxApi.get).toHaveBeenCalledWith(expect.objectContaining({ resume: false }));
});

it("preserves literal values and the explicit home while stripping unrelated provider secrets", async () => {
  const { runtime, workspace } = await provider();
  const value = "spaces, quotes \" ' $() `whoami`\nsecond line";
  const result = await runtime.exec(workspace, {
    resume: false,
    command: "node",
    args: [
      "-e",
      "console.log(JSON.stringify({value:process.env.EXPLICIT,home:process.env.HOME,unrequested:process.env.UNREQUESTED_PROVIDER_SECRET}))",
    ],
    env: { EXPLICIT: value },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ value, home: join(root, ".facility/home") });
});
