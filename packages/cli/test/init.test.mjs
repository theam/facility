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

function assertWatchtowerSecurityClaims(
  { crew, canaryWorkflow, canarySource, watchtowerWorkflow, watchtowerGuard },
  scope,
) {
  const prose = (source) =>
    source
      .replace(/^\s*(?:#|\/\/)\s?/gm, " ")
      .replace(/\s+/g, " ")
      .trim();
  const crewClaims = prose(crew);
  const canaryWorkflowClaims = prose(canaryWorkflow);
  const canarySourceClaims = prose(canarySource);
  const watchtowerWorkflowClaims = prose(watchtowerWorkflow);
  const watchtowerGuardClaims = prose(watchtowerGuard);

  assert.ok(
    crewClaims.includes("does not cap replay frequency or aggregate cost"),
    `${scope}: crew must disclose replay and aggregate-cost exposure`,
  );
  assert.ok(
    canarySourceClaims.includes(
      "hash is an instruction-content gate, not a replay or cost boundary",
    ),
    `${scope}: canary must disclose credential replay and cost exposure`,
  );
  assert.ok(
    canarySourceClaims.includes("any other GitHub permissions it carries"),
    `${scope}: canary must disclose permissions outside the crew hash gate`,
  );
  assert.ok(
    canaryWorkflowClaims.includes("does not cap repeated replays or aggregate cost"),
    `${scope}: canary workflow must disclose replay and aggregate-cost exposure`,
  );

  const canaryClaims = `${crewClaims} ${canaryWorkflowClaims} ${canarySourceClaims}`;
  assert.doesNotMatch(
    canaryClaims,
    /at worst replay this fixed|never run attacker-chosen instructions|exactly ONE message/,
    `${scope}: stale leaked-App-key safety overclaim must not return`,
  );

  const mintTokenStep =
    canaryWorkflow.match(/\n      - name: Mint canary App token\n([\s\S]*?)\n      - name:/)?.[1] ?? "";
  assert.ok(mintTokenStep, `${scope}: canary token mint step must exist`);
  assert.match(
    mintTokenStep,
    /^\s+permission-issues: write$/m,
    `${scope}: minted canary token must be narrowed to issue comments`,
  );
  const permissionInputs = [...mintTokenStep.matchAll(/^\s+permission-([\w-]+):\s*(\S+)$/gm)].map(
    ([, permission, level]) => [permission, level],
  );
  assert.deepEqual(
    permissionInputs,
    [["issues", "write"]],
    `${scope}: canary token must not request unrelated App permissions`,
  );

  assert.ok(
    watchtowerGuardClaims.includes(
      "cannot tell whether Actions or a schedule is enabled or runnable",
    ),
    `${scope}: guard must disclose its structural schedule-checking limit`,
  );
  assert.doesNotMatch(
    watchtowerGuardClaims,
    /disabled schedule|stay scheduled/,
    `${scope}: guard must not claim to detect runtime schedule state`,
  );
  assert.ok(
    watchtowerWorkflowClaims.includes(
      "cannot guarantee that a schedule is enabled or runnable",
    ),
    `${scope}: watchtower workflow must disclose its structural guard limit`,
  );
  assert.doesNotMatch(
    watchtowerWorkflowClaims,
    /keeps these schedules from quietly rotting/,
    `${scope}: watchtower workflow must not overstate schedule detection`,
  );
}

test("watchtower templates state credential and schedule-checking boundaries", () => {
  const templateRoot = join(pkgRoot, "templates");
  assertWatchtowerSecurityClaims(
    {
      crew: readFileSync(join(templateRoot, "workflows/facility-crew.yml"), "utf8"),
      canaryWorkflow: readFileSync(
        join(templateRoot, "workflows/facility-canary.yml"),
        "utf8",
      ),
      canarySource: readFileSync(join(templateRoot, "watchtower/canary.mjs"), "utf8"),
      watchtowerWorkflow: readFileSync(
        join(templateRoot, "workflows/facility-watchtower.yml"),
        "utf8",
      ),
      watchtowerGuard: readFileSync(
        join(templateRoot, "guards/watchtower-locked.mjs"),
        "utf8",
      ),
    },
    "templates",
  );
});

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
      "--preview-image=ghcr.io/acme/demo:sha-abc123",
      "--preview-command=npm run start",
      "--preview-port=4173",
      "--preview-readiness-path=/healthz",
    ],
    dir
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const expected = [
    ".github/workflows/facility-crew.yml",
    ".github/workflows/facility-codex.yml",
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
    ".github/facility/receipts/collect.mjs",
    ".github/facility/review/finalize.mjs",
    ".github/facility/security/sync-findings.mjs",
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
    "guards/workflow-untrusted-interpolation.mjs",
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
  assert.ok(
    crew.includes("apps/docs/docs/reference/hardening.md"),
    "crew workflow must point to the consolidated hardening documentation",
  );
  assert.ok(!crew.includes("docs/hardening.md"), "crew workflow must not retain the obsolete docs path");
  assert.ok(
    crew.includes("Request Facility SSO-protected preview"),
    "configured delivery must request a protected preview",
  );
  assert.ok(crew.includes("FACILITY_PREVIEW_KEY"), "preview request needs a scoped Facility key");

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
  const codex = readFileSync(join(dir, ".github/workflows/facility-codex.yml"), "utf8");
  assert.ok(codex.includes("/codex-builder"), "Codex builder command must be installed");
  assert.ok(codex.includes("/codex-architect"), "Codex architect command must be installed");
  assert.ok(codex.includes("@openai/codex@0.144.6"), "Codex CLI must be version-pinned");
  assert.ok(codex.includes("FACILITY_RECEIPT_PROVIDER: codex_cli"), "Codex runs need receipts");
  assert.ok(codex.includes("actions/attest-build-provenance@43d14"), "Codex receipts must be attested");
  assert.ok(review.includes("--model claude-sonnet-4-6"), "review must run on the review tier");
  assert.ok(review.includes("npm ci"), "reviewer must install the detected toolchain");
  assert.ok(review.includes("npm run setup"), "reviewer must provision before inspection");
  assert.ok(review.includes("--permission-mode bypassPermissions"), "reviewer must be usable on its isolated runner");
  assert.ok(review.includes("--max-budget-usd 5"), "reviewer must have an explicit spend ceiling");
  assert.ok(review.includes("review/finalize.mjs"), "review must publish an explicit no-findings result");
  assert.ok(crew.includes("delivery/verify.mjs discover"), "builder delivery must be checked deterministically");
  assert.ok(crew.includes(".head.sha"), "existing PR delivery must capture its pre-builder head");
  assert.ok(crew.includes("if-no-files-found: error"), "a missing delivery receipt must fail closed");
  assert.ok(crew.includes("MODE: review"), "verified delivery must move board work to review");
  const boardScript = readFileSync(join(dir, ".github/facility/move-board-status.sh"), "utf8");
  assert.ok(boardScript.includes('review)    TARGET="$REVIEW_STATUS"'), "board script needs review mapping");

  // The canary hash pinned in the crew workflow is derived from the canonical
  // probe body — the three artifacts can never drift at generation time.
  const { CANARY_PROBE_BODY } = await import(
    pathToFileURL(join(dir, ".github/facility/watchtower/canary.mjs")).href
  );
  const expectedSha = createHash("sha256").update(CANARY_PROBE_BODY.replace(/\r/g, ""), "utf8").digest("hex");
  assert.ok(crew.includes(expectedSha), "crew must pin the sha256 of the canary probe body");
  assert.ok(crew.includes("facility-canary[bot]"), "default canary bot login must be rendered");
  const canaryWorkflow = readFileSync(
    join(dir, ".github/workflows/facility-canary.yml"),
    "utf8",
  );
  const canarySource = readFileSync(
    join(dir, ".github/facility/watchtower/canary.mjs"),
    "utf8",
  );
  assert.ok(canaryWorkflow.includes("attestations: read"), "canary must read attestations");
  assert.ok(canarySource.includes("facility-run-receipt-${run.id}-crew"));
  assert.ok(canarySource.includes("verifyReceipt(receipt)"), "canary must verify receipt digest");
  assert.ok(canarySource.includes('"attestation", "verify"'), "canary must verify OIDC provenance");

  for (const workflow of [
    "facility-crew.yml",
    "facility-codex.yml",
    "facility-review.yml",
    "facility-address-review.yml",
    "facility-doctor.yml",
    "facility-security-sweep.yml",
  ]) {
    const source = readFileSync(join(dir, ".github/workflows", workflow), "utf8");
    assert.ok(source.includes("Collect trusted agent run receipt"), `${workflow} must collect a receipt`);
    assert.ok(source.includes("actions/attest-build-provenance@43d14"), `${workflow} must attest its receipt`);
    assert.ok(source.includes("facility-run-receipt-${{ github.run_id }}"), `${workflow} must upload its receipt`);
  }

  const healthSource = readFileSync(join(dir, ".github/facility/watchtower/health.mjs"), "utf8");
  assert.ok(healthSource.includes('"facility-codex"'), "health must watch the Codex lane");
  assert.ok(healthSource.includes('"degraded"'), "health must classify partial failures");
  assert.ok(healthSource.includes('"--limit", "1"'), "health must keep one incident issue");
  const outcomesSource = readFileSync(
    join(dir, ".github/facility/watchtower/outcomes.mjs"),
    "utf8",
  );
  assert.ok(!outcomesSource.includes('"issue", "create"'), "outcomes must stay telemetry-only");
  const watchtowerWorkflow = readFileSync(
    join(dir, ".github/workflows/facility-watchtower.yml"),
    "utf8",
  );
  const watchtowerGuard = readFileSync(join(dir, "guards/watchtower-locked.mjs"), "utf8");
  assertWatchtowerSecurityClaims(
    { crew, canaryWorkflow, canarySource, watchtowerWorkflow, watchtowerGuard },
    "rendered install",
  );
  const outcomesJob = watchtowerWorkflow.match(/\n  outcomes:\n([\s\S]*?)\n  health:/)?.[1] ?? "";
  assert.ok(outcomesJob, "watchtower must contain an outcomes job");
  assert.ok(!outcomesJob.includes("issues: write"), "outcomes job must not receive issue-write permission");
  const securitySweep = readFileSync(
    join(dir, ".github/workflows/facility-security-sweep.yml"),
    "utf8",
  );
  assert.ok(securitySweep.includes("secret-scanning/alerts"), "security sweep needs secret alerts");
  assert.ok(securitySweep.includes("dependency-graph/sbom"), "security sweep needs SBOM evidence");
  assert.ok(securitySweep.includes("workflow-permissions.txt"), "security sweep needs permission evidence");
  const securityAudit = securitySweep.match(/\n  audit:\n([\s\S]*?)\n  sync-findings:/)?.[1] ?? "";
  assert.ok(securityAudit, "security sweep must contain an audit job");
  assert.ok(!securityAudit.includes("issues: write"), "security auditor must not receive issue-write permission");
  assert.ok(securitySweep.includes("sync-findings:"), "trusted job must synchronize findings");
  assert.ok(
    securitySweep.includes("security-findings.json"),
    "security sweep must publish a structured findings artifact",
  );
  assert.match(
    securitySweep,
    /path: \.agent-sdlc\/security-findings\.json\s+include-hidden-files: true/,
    "security sweep must include the hidden findings artifact",
  );

  // Doctor watches facility-review (no other workflows exist in the fixture).
  const doctorWf = readFileSync(join(dir, ".github/workflows/facility-doctor.yml"), "utf8");
  assert.match(
    doctorWf,
    /path: \.facility-doctor\/\s+include-hidden-files: true/,
    "doctor must upload its hidden repair context",
  );
  assert.match(
    securitySweep,
    /path: \.facility-sweep\/\s+include-hidden-files: true/,
    "security sweep must upload its hidden audit context",
  );
  assert.ok(doctorWf.includes("- facility-review"), "doctor watch list must include facility-review");
  assert.ok(
    !doctorWf.includes("workflow_run.conclusion == 'failure'"),
    "doctor must evaluate the complete rollup after every watched completion",
  );
  assert.ok(
    doctorWf.includes("ref: ${{ needs.resolve.outputs.head_sha }}"),
    "doctor must check out the exact approved head SHA",
  );
  assert.ok(
    doctorWf.includes("FACILITY_BOT_LOGIN: ${{ vars.FACILITY_BOT_LOGIN }}"),
    "doctor must authorize only the configured Facility App bot",
  );
  assert.ok(
    doctorWf.includes('test "$(git rev-parse HEAD)" = "$HEAD_SHA"'),
    "doctor must verify the exact checkout before attaching the PR branch",
  );
  assert.ok(!/\{\{[A-Z0-9_]+\}\}/.test(doctorWf), "unrendered placeholder in doctor workflow");
  const doctorContract = readFileSync(join(dir, ".github/facility/doctor.md"), "utf8");
  assert.ok(
    doctorContract.includes("`Scope` JSON"),
    "doctor contract must support the platform lane's injected scope",
  );

  // Manifest reflects the choices.
  const manifest = JSON.parse(readFileSync(join(dir, ".facility.json"), "utf8"));
  assert.equal(manifest.board.project, 7);
  assert.deepEqual(manifest.checks, ["npm run lint", "npm test"]);
  assert.equal(manifest.models.build, "opusplan");
  assert.equal(manifest.models.codexBuild, "gpt-5.6-sol");
  assert.deepEqual(manifest.preview, {
    enabled: true,
    image: "ghcr.io/acme/demo:sha-abc123",
    command: ["sh", "-lc", "npm run start"],
    port: 4173,
    readinessPath: "/healthz",
    ttlHours: 24,
  });
  assert.equal(manifest.engine, "claude-code");
  assert.deepEqual(manifest.engines, ["claude-code", "codex"]);
  assert.deepEqual(manifest.auth, {
    provider: "anthropic",
    mode: "api-key",
    codex: { provider: "openai", mode: "api-key" },
  });

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
