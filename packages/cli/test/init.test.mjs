import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");
const biome = resolve(pkgRoot, "..", "..", "node_modules", ".bin", "biome");

function makeTargetRepo() {
  const dir = mkdtempSync(join(tmpdir(), "facility-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "demo-app",
        private: true,
        scripts: { lint: "eslint .", test: "vitest run", setup: "docker compose up -d" },
      },
      null,
      2
    ) + "\n"
  );
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  return dir;
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8" });
}

test("local help and leading global flags are side-effect free", () => {
  for (const args of [
    ["init", "--help"],
    ["add", "--help"],
    ["doctor", "--help"],
    ["--profile", "missing", "projects", "--help"],
  ]) {
    const result = runCli(args, pkgRoot);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Usage/);
  }
});

test("init installs the method end to end", async (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runCli(
    [
      "init",
      "--yes",
      `--dir=${dir}`,
      "--provision=npm run setup",
      '--checks=npm run lint, npm test',
      "--org=acme",
      "--project=7",
    ],
    dir
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const expected = [
    ".github/workflows/facility-crew.yml",
    ".github/workflows/facility-review.yml",
    ".github/workflows/facility-address-review.yml",
    ".github/workflows/facility-doctor.yml",
    ".github/workflows/facility-security-sweep.yml",
    ".github/workflows/facility-watchtower.yml",
    ".github/workflows/facility-canary.yml",
    ".github/facility/architect.md",
    ".github/facility/builder.md",
    ".github/facility/doctor.md",
    ".github/facility/sweep.md",
    ".github/facility/doctor/resolve.mjs",
    ".github/facility/delivery/verify.mjs",
    ".github/facility/review/finalize.mjs",
    ".github/facility/watchtower/outcomes.mjs",
    ".github/facility/watchtower/health.mjs",
    ".github/facility/watchtower/canary.mjs",
    ".github/facility/watchtower/budgets.json",
    ".github/facility/move-board-status.sh",
    "STANDARD.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".claude/settings.json",
    ".claude/hooks/protect-branch.mjs",
    ".claude/hooks/protect-files.mjs",
    ".claude/agents/standards-reviewer.md",
    ".claude/agents/security-reviewer.md",
    ".claude/skills/working-to-standard/SKILL.md",
    ".claude/skills/reviewing-to-standard/SKILL.md",
    ".claude/skills/maintainable-software/SKILL.md",
    ".claude/commands/verify.md",
    ".claude/commands/open-pr.md",
    "guards/run.mjs",
    "guards/_kit.mjs",
    "guards/actions-pinned.mjs",
    "guards/watchtower-locked.mjs",
    ".facility.json",
  ];
  for (const file of expected) {
    assert.ok(existsSync(join(dir, file)), `missing ${file}`);
  }

  // Our placeholders are gone; GitHub Actions expressions survive.
  const crew = readFileSync(join(dir, ".github/workflows/facility-crew.yml"), "utf8");
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(crew), "unrendered facility placeholder in crew workflow");
  assert.ok(crew.includes("${{ secrets.ANTHROPIC_API_KEY }}"), "GitHub expression was mangled");
  assert.ok(!crew.includes("CLAUDE_CODE_OAUTH_TOKEN"), "API-key mode must not require OAuth");
  assert.ok(crew.includes("npm run setup"), "provision command not rendered");
  assert.ok(crew.includes("PROJECT_NUMBER: '7'"), "board step not rendered");
  assert.ok(crew.includes("npm ci"), "toolchain steps not rendered for npm");

  // Agent triggers are slash commands, never @-mentions (real GitHub users),
  // and bot-authored events can't summon the crew.
  assert.ok(crew.includes("trigger_phrase=/builder"), "builder trigger must be slash syntax");
  assert.ok(crew.includes("github.event.sender.type != 'Bot'"), "crew must refuse bot-authored events");
  const crewCodeLines = crew.split("\n").filter((line) => !line.trim().startsWith("#"));
  assert.ok(
    !crewCodeLines.some((line) => /@(builder|architect)\b/.test(line)),
    "no @-mention handles may remain outside explanatory comments"
  );

  // settings.json must be valid JSON with the checks allowlisted.
  const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
  assert.ok(settings.permissions.allow.includes("Bash(npm run lint)"));
  assert.ok(settings.permissions.deny.includes("Read(.env)"));

  // STANDARD.md carries the verification ladder and the module markers.
  const standard = readFileSync(join(dir, "STANDARD.md"), "utf8");
  assert.ok(standard.includes("`npm run lint`"));
  assert.ok(standard.includes("<!-- facility:modules:start -->"));

  // Skills are cross-tool: .agents/skills symlinks to .claude/skills, and
  // the slash commands carry the rendered verification ladder.
  assert.ok(lstatSync(join(dir, ".agents/skills")).isSymbolicLink(), ".agents/skills must be a symlink");
  assert.ok(existsSync(join(dir, ".agents/skills/working-to-standard/SKILL.md")), "symlink must resolve to the skills");
  const verifyCmd = readFileSync(join(dir, ".claude/commands/verify.md"), "utf8");
  assert.ok(verifyCmd.includes("`npm run lint`"), "verify command must carry the rendered checks");

  // Model tiering: opusplan builds, Sonnet reviews, Opus plans/repairs/sweeps.
  assert.ok(crew.includes("--model opusplan"), "builder must run on the build tier");
  assert.ok(crew.includes("--model claude-opus-4-8"), "architect must run on the plan tier");
  const review = readFileSync(join(dir, ".github/workflows/facility-review.yml"), "utf8");
  assert.ok(review.includes("--model claude-sonnet-4-6"), "review must run on the review tier");
  assert.ok(review.includes("npm ci"), "reviewer must install the detected toolchain");
  assert.ok(review.includes("npm run setup"), "reviewer must provision before inspection");
  assert.ok(review.includes("--permission-mode bypassPermissions"), "reviewer must be usable on its isolated runner");
  assert.ok(review.includes("--max-budget-usd 5"), "reviewer must have an explicit spend ceiling");
  assert.ok(review.includes("review/finalize.mjs"), "review must publish an explicit no-findings result");
  assert.ok(crew.includes("delivery/verify.mjs discover"), "builder delivery must be checked deterministically");
  assert.ok(crew.includes(".head.sha"), "existing PR delivery must capture its pre-builder head");
  assert.ok(crew.includes("if-no-files-found: error"), "a missing delivery receipt must fail closed");

  // The canary hash pinned in the crew workflow is derived from the canonical
  // probe body — the three artifacts can never drift at generation time.
  const { CANARY_PROBE_BODY } = await import(
    pathToFileURL(join(dir, ".github/facility/watchtower/canary.mjs")).href
  );
  const expectedSha = createHash("sha256").update(CANARY_PROBE_BODY.replace(/\r/g, ""), "utf8").digest("hex");
  assert.ok(crew.includes(expectedSha), "crew must pin the sha256 of the canary probe body");
  assert.ok(crew.includes("facility-canary[bot]"), "default canary bot login must be rendered");

  // Doctor watches facility-review (no other workflows exist in the fixture).
  const doctorWf = readFileSync(join(dir, ".github/workflows/facility-doctor.yml"), "utf8");
  assert.ok(doctorWf.includes("- facility-review"), "doctor watch list must include facility-review");
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(doctorWf), "unrendered placeholder in doctor workflow");

  // Manifest reflects the choices.
  const manifest = JSON.parse(readFileSync(join(dir, ".facility.json"), "utf8"));
  assert.equal(manifest.board.project, 7);
  assert.deepEqual(manifest.checks, ["npm run lint", "npm test"]);
  assert.equal(manifest.models.build, "opusplan");
  assert.equal(manifest.engine, "claude-code");
  assert.deepEqual(manifest.auth, { provider: "anthropic", mode: "api-key" });

  // Generated guards pass on the generated workflows (all actions pinned).
  const guards = spawnSync(process.execPath, ["guards/run.mjs"], { cwd: dir, encoding: "utf8" });
  assert.equal(guards.status, 0, guards.stdout + guards.stderr);

  // Generated governance assets fit an ordinary strict Biome host config;
  // adopters must not exclude Facility files to recover a green repository.
  writeFileSync(
    join(dir, "biome.json"),
    `${JSON.stringify(
      {
        $schema: "https://biomejs.dev/schemas/2.5.2/schema.json",
        files: { includes: ["**", "!!node_modules"] },
        formatter: { enabled: true, indentStyle: "space", lineWidth: 100 },
        linter: { enabled: true, rules: { preset: "recommended" } },
      },
      null,
      2,
    )}\n`,
  );
  const formatConfig = spawnSync(biome, ["format", "--write", "biome.json"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(formatConfig.status, 0, formatConfig.stdout + formatConfig.stderr);
  const strictBiome = spawnSync(biome, ["check", "."], { cwd: dir, encoding: "utf8" });
  assert.equal(strictBiome.status, 0, strictBiome.stdout + strictBiome.stderr);

  const doctor = runCli(["doctor", `--dir=${dir}`], dir);
  assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
  assert.ok(doctor.stdout.includes("models build=opusplan"));
  assert.ok(!doctor.stdout.includes("model undefined"));

  // Init is idempotent: a second run skips, never overwrites.
  const again = runCli(["init", "--yes", `--dir=${dir}`, "--provision=npm run setup"], dir);
  assert.equal(again.status, 0);
  assert.ok(again.stdout.includes("left untouched"), "second init should skip existing files");
});

test("init renders every supported Anthropic authentication mode consistently", async (t) => {
  const expectations = {
    "api-key": "anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}",
    oauth: "claude_code_oauth_token: ${{ steps.claude-auth.outputs.token }}",
    wif: "anthropic_federation_rule_id: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}",
    bedrock: 'use_bedrock: "true"',
    vertex: 'use_vertex: "true"',
  };

  for (const [mode, expected] of Object.entries(expectations)) {
    const dir = makeTargetRepo();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const result = runCli(
      [
        "init",
        "--yes",
        `--dir=${dir}`,
        `--auth=${mode}`,
        "--provision=npm run setup",
        "--checks=npm test",
      ],
      dir,
    );
    assert.equal(result.status, 0, `${mode}: ${result.stdout}${result.stderr}`);
    const crew = readFileSync(join(dir, ".github/workflows/facility-crew.yml"), "utf8");
    assert.ok(crew.includes(expected), `${mode} input missing`);
    assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(crew), `${mode} left a template placeholder`);
    const manifest = JSON.parse(readFileSync(join(dir, ".facility.json"), "utf8"));
    assert.equal(manifest.auth.mode, mode);
    const guards = spawnSync(process.execPath, ["guards/run.mjs"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(guards.status, 0, `${mode}: ${guards.stdout}${guards.stderr}`);
  }
});

test("add database module wires the triple", async (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  runCli(["init", "--yes", `--dir=${dir}`, "--provision=npm run setup", "--checks=npm test"], dir);
  const result = runCli(["add", "database", `--dir=${dir}`], dir);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  // 1. Prose: STANDARD.md section inside the markers.
  const standard = readFileSync(join(dir, "STANDARD.md"), "utf8");
  assert.ok(standard.includes("### Database (facility module)"));
  const start = standard.indexOf("<!-- facility:modules:start -->");
  const end = standard.indexOf("<!-- facility:modules:end -->");
  assert.ok(standard.indexOf("### Database") > start && standard.indexOf("### Database") < end);

  // 2. Reviewer subagent and slash command copied.
  assert.ok(existsSync(join(dir, ".claude/agents/data-security-reviewer.md")));
  assert.ok(existsSync(join(dir, ".claude/commands/new-migration.md")));

  // 3. Checks: guards copied and hook rules spliced.
  assert.ok(existsSync(join(dir, "guards/migrations-immutable.mjs")));
  assert.ok(existsSync(join(dir, "guards/migration-versions.mjs")));
  const hook = readFileSync(join(dir, ".claude/hooks/protect-files.mjs"), "utf8");
  assert.ok(hook.includes("facility module: database"));
  assert.ok(hook.includes("/* facility:module-rules */"), "marker must survive for the next module");

  // Manifest records it; adding twice is a no-op.
  const manifest = JSON.parse(readFileSync(join(dir, ".facility.json"), "utf8"));
  assert.deepEqual(manifest.modules, ["database"]);
  const again = runCli(["add", "database", `--dir=${dir}`], dir);
  assert.equal(again.status, 0);
  const manifestAgain = JSON.parse(readFileSync(join(dir, ".facility.json"), "utf8"));
  assert.deepEqual(manifestAgain.modules, ["database"]);

  // The spliced hook still parses.
  const parse = spawnSync(process.execPath, ["--check", ".claude/hooks/protect-files.mjs"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(parse.status, 0, parse.stderr);
});

test("doctor reports missing install", async (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runCli(["doctor", `--dir=${dir}`], dir);
  assert.equal(result.status, 1);
  assert.ok(result.stdout.includes("missing"));
});

test("local doctor preserves the JSON contract", async (t) => {
  const dir = makeTargetRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = runCli(["doctor", `--dir=${dir}`, "--json"], dir);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.mode, "local");
  assert.equal(payload.ok, false);
  assert.ok(payload.problems > 0);
  assert.ok(payload.checks.some((check) => check.label === ".facility.json"));
});

test("local commands reject unknown, valueless, and conflicting flags", () => {
  const unknown = runCli(["doctor", "--jsoon"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option: --jsoon/);

  const valueless = runCli(["doctor", "--dir"]);
  assert.equal(valueless.status, 1);
  assert.match(valueless.stderr, /--dir requires a value/);
  assert.doesNotMatch(valueless.stderr, /TypeError| at /);

  const conflict = runCli(["doctor", "--local", "--platform", "--json"]);
  assert.equal(conflict.status, 1);
  assert.equal(conflict.stderr, "");
  assert.equal(
    JSON.parse(conflict.stdout).error.message,
    "--local cannot be combined with platform target options",
  );
});
