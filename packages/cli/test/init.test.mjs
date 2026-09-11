import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");
const crew = [
  "architect",
  "builder",
  "pr-reviewer",
  "address-review",
  "ci-doctor",
  "security-audit",
];

function makeTargetRepo() {
  const dir = mkdtempSync(join(tmpdir(), "facility-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-app",
        private: true,
        scripts: { dev: "next dev", setup: "docker compose up -d", test: "vitest run" },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  return dir;
}

function runCli(args, cwd = pkgRoot) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

test("the kickstart crew uses one manifest shape and no per-agent access controls", () => {
  for (const name of crew) {
    const source = readFileSync(join(pkgRoot, "templates", "agents", `${name}.md`), "utf8");
    assert.match(source, new RegExp(`^name: ${name}$`, "m"));
    assert.match(source, /^engine: (claude_code|codex)$/m);
    assert.match(source, /^model: \S+$/m);
    assert.match(source, /^triggers:$/m);
    assert.match(source, /same full workspace/i);
    assert.doesNotMatch(source, /^(permissions|sandbox|tools):/m);
    assert.doesNotMatch(source, /receipt|HITL|budget ceiling/i);
  }
});

test("local help is side-effect free", () => {
  for (const args of [
    ["init", "--help"],
    ["doctor", "--help"],
  ]) {
    const result = runCli(args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Usage/);
  }
});

test("init installs the complete 0.12 repository contract and nothing from the legacy runtime", (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runCli(
    [
      "init",
      "--yes",
      `--dir=${dir}`,
      "--repo=acme/demo-app",
      "--provision=npm run setup",
      "--start=npm run dev",
      "--preview-readiness-command=npm test",
      "--service-port=4173",
    ],
    dir,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const expected = [".facility.yml", ...crew.map((name) => `.agents/${name}.md`)];
  for (const file of expected) assert.ok(existsSync(join(dir, file)), `missing ${file}`);
  for (const forbidden of [
    ".facility.json",
    "STANDARD.md",
    ".github/workflows/facility-crew.yml",
    ".github/facility/receipts/collect.mjs",
    ".github/facility/watchtower/budgets.json",
  ]) {
    assert.equal(existsSync(join(dir, forbidden)), false, `legacy asset written: ${forbidden}`);
  }

  const environment = readFileSync(join(dir, ".facility.yml"), "utf8");
  assert.match(environment, /primary: "github\.com\/acme\/demo-app"/);
  assert.match(environment, /setup: "npm run setup"/);
  assert.match(environment, /start: "npm run dev"/);
  assert.match(environment, /ready: "npm test"/);
  assert.match(environment, /port: 4173/);

  const again = runCli(
    ["init", "--yes", `--dir=${dir}`, "--repo=acme/demo-app", "--start=npm run dev"],
    dir,
  );
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /left untouched/);
});

test("init configures Claude and Codex models in the same agent catalog", (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runCli(
    [
      "init",
      "--yes",
      `--dir=${dir}`,
      "--repo=acme/demo-app",
      "--start=npm run dev",
      "--build-model=claude-build-custom",
      "--review-model=claude-review-custom",
      "--plan-model=claude-plan-custom",
      "--codex-build-model=codex-build-custom",
      "--codex-plan-model=codex-plan-custom",
    ],
    dir,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(dir, ".agents/architect.md"), "utf8"), /model: claude-plan-custom/);
  assert.match(readFileSync(join(dir, ".agents/pr-reviewer.md"), "utf8"), /model: claude-review-custom/);
  assert.match(readFileSync(join(dir, ".agents/builder.md"), "utf8"), /model: codex-build-custom/);
  assert.match(readFileSync(join(dir, ".agents/ci-doctor.md"), "utf8"), /model: codex-plan-custom/);
});

test("init preserves repository-owned files unless force is explicit", (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", "builder.md"), "project-owned\n");

  let result = runCli(
    ["init", "--yes", `--dir=${dir}`, "--repo=acme/demo-app", "--start=npm run dev"],
    dir,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(dir, ".agents", "builder.md"), "utf8"), "project-owned\n");

  result = runCli(
    [
      "init",
      "--yes",
      "--force",
      `--dir=${dir}`,
      "--repo=acme/demo-app",
      "--start=npm run dev",
    ],
    dir,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(dir, ".agents", "builder.md"), "utf8"), /^---\nname: builder/m);
});

test("doctor reports a missing install", (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = runCli(["doctor", `--dir=${dir}`], dir);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing/);
});

test("local doctor validates the 0.12 contract and preserves its JSON output", (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const init = runCli(
    ["init", "--yes", `--dir=${dir}`, "--repo=acme/demo-app", "--start=npm run dev"],
    dir,
  );
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const result = runCli(["doctor", `--dir=${dir}`, "--json"], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "local");
  assert.equal(payload.ok, true);
  assert.equal(payload.problems, 0);
  assert.ok(payload.checks.some((check) => check.label === "start command"));

  const manifestPath = join(dir, ".facility.yml");
  writeFileSync(
    manifestPath,
    readFileSync(manifestPath, "utf8").replace("port: 3000", "port: 65536"),
  );
  const invalidPort = runCli(["doctor", `--dir=${dir}`, "--json"], dir);
  assert.equal(invalidPort.status, 1);
  assert.match(invalidPort.stdout, /between 1 and 65535/);
});

test("local commands reject unknown and valueless flags and legacy commands", () => {
  const unknown = runCli(["doctor", "--jsoon"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --jsoon/);

  const valueless = runCli(["doctor", "--dir"]);
  assert.equal(valueless.status, 1);
  assert.match(valueless.stderr, /--dir requires a value/);

  const legacy = runCli(["runs", "--json"]);
  assert.equal(legacy.status, 1);
  assert.match(legacy.stderr, /Unknown command: runs/);
});
