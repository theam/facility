import { execFileSync, spawn, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "facility-local-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ scripts: { dev: "vite" } })}\n`);
  return dir;
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    ...options,
  });
}

function runCliAsync(args, env) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: pkgRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

test("init --local writes a local manifest and agents without GitHub workflows", () => {
  const dir = makeRepo();
  try {
    const result = runCli(["init", "--yes", `--dir=${dir}`, "--local=shop", "--start=pnpm dev"]);
    assert.equal(result.status, 0, result.stderr);
    const manifest = readFileSync(join(dir, ".facility.yml"), "utf8");
    assert.match(manifest, /primary: "local:shop"/);
    for (const name of ["architect", "builder", "reviewer"]) {
      const agent = readFileSync(join(dir, ".agents", `${name}.md`), "utf8");
      assert.doesNotMatch(agent, /type: github|\{\{/);
    }
    assert.equal(existsSync(join(dir, ".agents", "pr-reviewer.md")), false);
    assert.match(result.stdout, /facility repos add-local/);

    const doctor = runCli(["doctor", `--dir=${dir}`, "--json"]);
    assert.equal(doctor.status, 0, doctor.stdout);
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --local rejects an alias that could name a path", () => {
  const dir = makeRepo();
  try {
    const result = runCli(["init", "--yes", `--dir=${dir}`, "--local=../escape", "--start=x"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /local repository alias/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repos add-local requires credentials and a project", () => {
  const env = { ...process.env, FACILITY_API_KEY: "", FACILITY_PROJECT_ID: "" };
  const noKey = runCli(["repos", "add-local", "/tmp", "--json"], { env });
  assert.equal(noKey.status, 1);
  assert.equal(JSON.parse(noKey.stdout).error.code, "api_key_required");
  const noProject = runCli(["repos", "add-local", "/tmp", "--json"], {
    env: { ...env, FACILITY_API_KEY: "fak_test" },
  });
  assert.equal(JSON.parse(noProject.stdout).error.code, "project_required");
  const unknown = runCli(["repos", "add-local", "/tmp", "--token=x"], { env });
  assert.match(unknown.stderr, /Unknown option/);
});

test("repos add-local registers through the API and reports what is not imported", async () => {
  const dir = makeRepo();
  writeFileSync(join(dir, "draft.txt"), "uncommitted\n");
  const requests = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
      const failing = JSON.parse(body).alias === "taken";
      response.writeHead(failing ? 409 : 200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          failing
            ? { error: { code: "local_repository_exists", message: "Already registered" } }
            : {
                manifestName: "local:shop",
                sourcePath: dir,
                defaultBranch: "main",
                headSha: "a".repeat(40),
                role: "primary",
                warnings: [],
              },
        ),
      );
    });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  const { port } = server.address();
  const env = {
    ...process.env,
    FACILITY_API_KEY: "fak_secret",
    FACILITY_API_URL: `http://127.0.0.1:${port}`,
  };
  try {
    const registered = await runCliAsync(
      ["repos", "add-local", dir, "--project=proj_1", "--alias=shop"],
      env,
    );
    assert.equal(registered.status, 0, registered.stderr);
    assert.match(registered.stdout, /draft\.txt/);
    assert.match(registered.stdout, /local:shop/);
    assert.equal(requests[0].url, "/v1/projects/proj_1/repos/local");
    assert.equal(requests[0].headers.authorization, "Bearer fak_secret");
    assert.deepEqual(requests[0].body, { path: dir, alias: "shop" });

    const conflict = await runCliAsync(
      ["repos", "add-local", dir, "--project=proj_1", "--alias=taken", "--json"],
      env,
    );
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stdout).error.code, "local_repository_exists");
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
