// `facility init` — install the method into a repository.
//
// Detect the stack, ask six short questions, write the files, print the
// manual steps that only a human can do. Every generated file belongs to the
// target repo afterwards; facility is the installer, not a runtime dependency.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { detect } from "./detect.mjs";
import { render, hasManagedBlock, appendManagedBlock } from "./render.mjs";
import { ask, confirm, closePrompts } from "./prompts.mjs";
import { addModule } from "./add.mjs";
import { accent, banner, bold, dim, heading, item, ok, skip, warn } from "./ui.mjs";

const CHECKOUT_SHA = "34e114876b0b11c390a56381ad16ebd13914f8d5"; // actions/checkout v4
const SETUP_NODE_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020"; // actions/setup-node v4
const PNPM_SHA = "b906affcce14559ad1aafd4ab0e942779e9f58b1"; // pnpm/action-setup v4
const AWS_AUTH_SHA = "517a711dbcd0e402f90c77e7e2f81e849156e31d"; // aws-actions/configure-aws-credentials v6.2.2
const GOOGLE_AUTH_SHA = "7c6bc770dae815cd3e89ee6cdf493a5fab2cc093"; // google-github-actions/auth v3
const AUTH_MODES = new Set(["api-key", "oauth", "wif", "bedrock", "vertex"]);

function toolchainSteps(packageManager, { conditional = false } = {}) {
  const guard = conditional ? "\n        if: steps.workflow-change.outputs.changed != 'true'" : "";
  if (packageManager === "pnpm") {
    return [
      "",
      `      - uses: pnpm/action-setup@${PNPM_SHA} # v4${guard}`,
      "",
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v4${guard}`,
      "        with:",
      "          node-version: 22",
      "          cache: pnpm",
      "",
      `      - run: pnpm install --frozen-lockfile${guard}`,
      "",
    ].join("\n");
  }
  if (packageManager === "yarn" || packageManager === "npm") {
    const installCmd = packageManager === "yarn" ? "yarn install --immutable" : "npm ci";
    return [
      "",
      `      - uses: actions/setup-node@${SETUP_NODE_SHA} # v4${guard}`,
      "        with:",
      "          node-version: 22",
      `          cache: ${packageManager}`,
      "",
      `      - run: ${installCmd}${guard}`,
      "",
    ].join("\n");
  }
  return [
    "",
    "      # facility: no Node toolchain detected. Add your language setup steps",
    "      # here (compilers, package managers) so the crew can build and test.",
    "",
  ].join("\n");
}

function boardStep(org, projectNumber) {
  if (!projectNumber) return "";
  return [
    "",
    "      # Reflect the invoked agent on the org Project board:",
    "      #   /architect -> Planning, /builder -> In Progress (accepting the plan).",
    "      # Forward-only; no-ops if PROJECTS_PAT is unset (the default",
    "      # GITHUB_TOKEN cannot write org Projects v2).",
    "      - name: Move Project board status",
    "        if: >",
    "          steps.requested-agent.outputs.run == 'true' &&",
    "          (github.event_name == 'issues' ||",
    "          (github.event_name == 'issue_comment' && github.event.issue.pull_request == null))",
    "        env:",
    "          GH_TOKEN: ${{ secrets.PROJECTS_PAT }}",
    "          MODE: ${{ steps.requested-agent.outputs.mode }}",
    "          ISSUE_NODE_ID: ${{ github.event.issue.node_id }}",
    `          ORG: '${org}'`,
    `          PROJECT_NUMBER: '${projectNumber}'`,
    "        run: bash .github/facility/move-board-status.sh",
    "",
  ].join("\n");
}

function boardReviewStep(org, projectNumber) {
  if (!projectNumber) return "";
  return [
    "",
    "      - name: Move delivered work to In Review",
    "        if: steps.delivery.outcome == 'success' && github.event.issue.pull_request == null",
    "        env:",
    "          GH_TOKEN: ${{ secrets.PROJECTS_PAT }}",
    "          MODE: review",
    "          ISSUE_NODE_ID: ${{ github.event.issue.node_id }}",
    `          ORG: '${org}'`,
    `          PROJECT_NUMBER: '${projectNumber}'`,
    "        run: bash .github/facility/move-board-status.sh",
    "",
  ].join("\n");
}

function doctorWatch(workflowNames) {
  const watched = [...new Set([...workflowNames, "facility-review"])];
  const lines = watched.map((name) => `      - ${name}`);
  if (workflowNames.length === 0) {
    lines.unshift("      # facility: no existing check workflows detected at init time —");
    lines.unshift("      # add your CI workflow names here so the doctor watches them.");
  }
  return lines.join("\n");
}

function checksAllowJson(checks) {
  if (!checks.length) return "";
  return checks.map((c) => `      "Bash(${c})",`).join("\n");
}

function checksList(checks) {
  const lines = checks.length
    ? checks.map((c) => `- \`${c}\``)
    : ["- _No check commands configured yet — add your typecheck/lint/test/build commands here._"];
  lines.push("- `node guards/run.mjs` — deterministic repo invariants. Always cheap; always run.");
  lines.push("");
  lines.push(
    "Escalate beyond this list when the change touches data, auth, or critical user flows — and say which extra checks ran."
  );
  return lines.join("\n");
}

function checksRun(checks) {
  if (checks.length) return checks.map((command) => `          ${command}`).join("\n");
  return [
    '          echo "::error::No verification commands are configured in .facility.json."',
    "          exit 1",
  ].join("\n");
}

function previewStep(preview) {
  if (!preview?.enabled) return "";
  return [
    "",
    "      - name: Request Facility SSO-protected preview",
    "        if: steps.delivery.outcome == 'success'",
    "        shell: bash",
    "        env:",
    "          FACILITY_API_URL: ${{ secrets.FACILITY_API_URL }}",
    "          FACILITY_PROJECT_ID: ${{ secrets.FACILITY_PROJECT_ID }}",
    "          FACILITY_PREVIEW_KEY: ${{ secrets.FACILITY_PREVIEW_KEY }}",
    `          PREVIEW_IMAGE: ${JSON.stringify(preview.image)}`,
    `          PREVIEW_COMMAND_JSON: ${JSON.stringify(JSON.stringify(preview.command ?? []))}`,
    `          PREVIEW_PORT: ${JSON.stringify(String(preview.port))}`,
    `          PREVIEW_READINESS_PATH: ${JSON.stringify(preview.readinessPath ?? "")}`,
    `          PREVIEW_TTL_HOURS: ${JSON.stringify(String(preview.ttlHours ?? 24))}`,
    "        run: |",
    "          set -euo pipefail",
    '          test -n "$FACILITY_API_URL" && test -n "$FACILITY_PROJECT_ID" && test -n "$FACILITY_PREVIEW_KEY"',
    "          payload=\"$(jq -nc --arg image \"$PREVIEW_IMAGE\" --argjson command \"$PREVIEW_COMMAND_JSON\" --argjson port \"$PREVIEW_PORT\" --arg readiness \"$PREVIEW_READINESS_PATH\" --argjson ttl \"$PREVIEW_TTL_HOURS\" --argjson pr '${{ steps.delivery.outputs.pr_number }}' --arg commit '${{ steps.delivery.outputs.head_sha }}' '{image:$image,command:$command,port:$port,ttlHours:$ttl,prNumber:$pr,commitSha:$commit} + if $readiness == \"\" then {} else {readinessPath:$readiness} end')\"",
    '          curl --fail-with-body --silent --show-error -X POST "$FACILITY_API_URL/v1/projects/$FACILITY_PROJECT_ID/previews" -H "authorization: Bearer $FACILITY_PREVIEW_KEY" -H "content-type: application/json" -H "idempotency-key: preview-${{ github.run_id }}-${{ github.run_attempt }}" --data "$payload"',
    "",
  ].join("\n");
}

function anthropicAuthSetup(mode, condition = "") {
  const conditional = condition ? [`        if: ${condition}`] : [];
  if (mode === "oauth") {
    return [
      "      - name: Prepare Claude Code OAuth token",
      "        id: claude-auth",
      ...conditional,
      "        shell: bash",
      "        env:",
      "          RAW_CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
      "        run: |",
      '          token="$RAW_CLAUDE_CODE_OAUTH_TOKEN"',
      "          token=\"${token//$'\\r'/}\"",
      "          token=\"${token//$'\\n'/}\"",
      '          token="${token#"${token%%[![:space:]]*}"}"',
      '          token="${token%"${token##*[![:space:]]}"}"',
      "          token=\"${token#export CLAUDE_CODE_OAUTH_TOKEN=}\"",
      "          token=\"${token#CLAUDE_CODE_OAUTH_TOKEN=}\"",
      '          token="${token#\\\"}"',
      '          token="${token%\\\"}"',
      "          token=\"${token#\\'}\"",
      "          token=\"${token%\\'}\"",
      "",
      '          if [ -z "$token" ]; then',
      '            echo "::error::CLAUDE_CODE_OAUTH_TOKEN is empty. Generate it with \'claude setup-token\' and store it as a repository or organization secret."',
      "            exit 1",
      "          fi",
      `          if printf '%s' "$token" | grep -q '[[:cntrl:]]'; then`,
      '            echo "::error::CLAUDE_CODE_OAUTH_TOKEN contains control characters after normalization."',
      "            exit 1",
      "          fi",
      "",
      '          echo "::add-mask::$token"',
      '          echo "token=$token" >> "$GITHUB_OUTPUT"',
    ].join("\n");
  }
  if (mode === "bedrock") {
    return [
      "      - name: Authenticate to AWS for Amazon Bedrock",
      ...conditional,
      `        uses: aws-actions/configure-aws-credentials@${AWS_AUTH_SHA} # v6.2.2`,
      "        with:",
      "          role-to-assume: ${{ secrets.AWS_ROLE_TO_ASSUME }}",
      "          aws-region: ${{ vars.AWS_REGION }}",
    ].join("\n");
  }
  if (mode === "vertex") {
    return [
      "      - name: Authenticate to Google Cloud for Vertex AI",
      ...conditional,
      `        uses: google-github-actions/auth@${GOOGLE_AUTH_SHA} # v3`,
      "        with:",
      "          workload_identity_provider: ${{ vars.GCP_WORKLOAD_IDENTITY_PROVIDER }}",
      "          service_account: ${{ vars.GCP_SERVICE_ACCOUNT }}",
    ].join("\n");
  }
  return "";
}

function anthropicAuthInputs(mode) {
  if (mode === "api-key") {
    return "          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}";
  }
  if (mode === "oauth") {
    return "          claude_code_oauth_token: ${{ steps.claude-auth.outputs.token }}";
  }
  if (mode === "wif") {
    return [
      "          anthropic_federation_rule_id: ${{ vars.ANTHROPIC_FEDERATION_RULE_ID }}",
      "          anthropic_organization_id: ${{ vars.ANTHROPIC_ORGANIZATION_ID }}",
      "          anthropic_service_account_id: ${{ vars.ANTHROPIC_SERVICE_ACCOUNT_ID }}",
      "          anthropic_workspace_id: ${{ vars.ANTHROPIC_WORKSPACE_ID }}",
    ].join("\n");
  }
  if (mode === "bedrock") return '          use_bedrock: "true"';
  return '          use_vertex: "true"';
}

function authOnboardingStep(mode) {
  if (mode === "api-key") {
    return "Add a dedicated, spend-capped Anthropic key:  gh secret set ANTHROPIC_API_KEY";
  }
  if (mode === "oauth") {
    return "Create the agent token:  claude setup-token  then  gh secret set CLAUDE_CODE_OAUTH_TOKEN";
  }
  if (mode === "wif") {
    return "Configure Anthropic WIF and set ANTHROPIC_FEDERATION_RULE_ID + ANTHROPIC_ORGANIZATION_ID as GitHub variables (service account/workspace are optional).";
  }
  if (mode === "bedrock") {
    return "Configure GitHub OIDC for AWS, then set AWS_ROLE_TO_ASSUME as a secret and AWS_REGION as a variable.";
  }
  return "Configure Google Workload Identity Federation, then set GCP_WORKLOAD_IDENTITY_PROVIDER + GCP_SERVICE_ACCOUNT as GitHub variables.";
}

function formatManifest(manifest) {
  let text = JSON.stringify(manifest, null, 2).replace(
    '  "engines": [\n    "claude-code",\n    "codex"\n  ],',
    '  "engines": ["claude-code", "codex"],',
  );
  if (manifest.preview?.command?.length) {
    const expanded = `    "command": [\n${manifest.preview.command
      .map((part) => `      ${JSON.stringify(part)}`)
      .join(",\n")}\n    ],`;
    text = text.replace(
      expanded,
      `    "command": [${manifest.preview.command.map((part) => JSON.stringify(part)).join(", ")}],`,
    );
  }
  const compactChecks = `  \"checks\": [${manifest.checks.map((check) => JSON.stringify(check)).join(", ")}],`;
  if (compactChecks.length > 100 || manifest.checks.length === 0) return `${text}\n`;
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === '  "checks": [');
  const end = lines.findIndex((line, index) => index > start && line === "  ],");
  if (start < 0 || end < 0) return `${text}\n`;
  lines.splice(start, end - start + 1, compactChecks);
  return `${lines.join("\n")}\n`;
}

export async function init(flags, pkgRoot, version) {
  const dir = flags.dir || process.cwd();
  const interactive = !flags.yes;

  banner(version);

  const detected = detect(dir);
  if (!detected.isGitRepo) {
    warn(`${dir} is not a git repository. Run \`git init\` first — facility installs GitHub workflows.`);
    if (interactive && !(await confirm("Continue anyway?", false))) {
      closePrompts();
      return 1;
    }
  }

  heading("Detected");
  item(`package manager   ${bold(detected.packageManager)}`);
  item(`default branch    ${bold(detected.defaultBranch)}`);
  item(`checks            ${detected.checks.length ? bold(detected.checks.join(", ")) : dim("none found")}`);
  item(`check workflows   ${detected.workflowNames.length ? bold(detected.workflowNames.join(", ")) : dim("none — the doctor watch list starts empty")}`);
  item(`deployments       ${detected.deploymentProviders.length ? bold(detected.deploymentProviders.join(", ")) : dim("none detected")}`);
  item(`project board     ${detected.board ? bold(`${detected.board.org} #${detected.board.project}`) : dim("none detected")}`);
  item(`protected preview ${detected.previewConfigured ? bold("configured") : dim("not configured")}`);
  if (detected.suggestedModules.length) item(`suggested modules ${bold(detected.suggestedModules.join(", "))}`);

  heading("A few questions");
  const defaultBranch = flags.branch || (interactive ? await ask("Default branch?", detected.defaultBranch) : detected.defaultBranch);
  const provision =
    flags.provision ??
    (interactive
      ? await ask("Provision command (DB, seeds, browsers — what the crew runs before working)?", detected.provision)
      : detected.provision);
  const checksRaw =
    flags.checks ??
    (interactive
      ? await ask("Check commands, comma-separated?", detected.checks.join(", "))
      : detected.checks.join(", "));
  const checks = checksRaw.split(",").map((c) => c.trim()).filter(Boolean);
  // Model tiering is an opinionated default, not a question: deep reasoning
  // where it matters, volume where it doesn't. Override with
  // --build-model / --review-model / --plan-model.
  const models = {
    build: flags["build-model"] || "opusplan",
    review: flags["review-model"] || "claude-sonnet-4-6",
    plan: flags["plan-model"] || "claude-opus-4-8",
    codexBuild: flags["codex-build-model"] || "gpt-5.6-sol",
    codexPlan: flags["codex-plan-model"] || "gpt-5.6-sol",
  };
  item(dim(`model tiering: ${models.build} build · ${models.review} review · ${models.plan} plan/repair/sweep · ${models.codexBuild} Codex build · ${models.codexPlan} Codex plan`));
  const anthropicAuth = String(flags.auth || "api-key").toLowerCase();
  if (!AUTH_MODES.has(anthropicAuth)) {
    throw new Error(`Unsupported --auth=${anthropicAuth}. Use api-key, oauth, wif, bedrock, or vertex.`);
  }
  item(dim(`Anthropic auth: ${anthropicAuth}`));
  const canaryBot = flags["canary-bot"] || "facility-canary[bot]";
  const preview = flags["preview-image"]
    ? {
        enabled: true,
        image: flags["preview-image"],
        command: flags["preview-command"] ? ["sh", "-lc", flags["preview-command"]] : undefined,
        port: Number(flags["preview-port"] || 3000),
        readinessPath: flags["preview-readiness-path"] || undefined,
        ttlHours: Number(flags["preview-ttl-hours"] || 24),
      }
    : undefined;
  if (
    preview &&
    (!Number.isInteger(preview.port) ||
      preview.port < 1 ||
      preview.port > 65_535 ||
      (preview.readinessPath && !preview.readinessPath.startsWith("/")) ||
      !Number.isInteger(preview.ttlHours) ||
      preview.ttlHours < 1 ||
      preview.ttlHours > 168)
  ) {
    throw new Error(
      "Preview port must be 1-65535, readiness path must start with /, and preview TTL must be 1-168 hours.",
    );
  }
  const project =
    flags.project ??
    (interactive
      ? await ask(
          "Org Project number for board moves (empty to skip)?",
          detected.board ? String(detected.board.project) : "",
        )
      : detected.board
        ? String(detected.board.project)
        : "");
  const org = project
    ? flags.org ||
      (interactive
        ? await ask("GitHub org for the Project board?", detected.board?.org ?? detected.org)
        : (detected.board?.org ?? detected.org))
    : "";
  const modulesRaw =
    flags.modules ??
    (interactive
      ? await ask("Modules to install now (analytics, database, ai-queryability, design-system)?", detected.suggestedModules.join(", "))
      : detected.suggestedModules.join(", "));
  const modules = modulesRaw.split(",").map((m) => m.trim()).filter(Boolean);

  const provisionCmd =
    provision ||
    'echo "facility: no provision command configured — the crew runs on a bare checkout. Set one in this workflow + .facility.json."';
  const checksInline = checks.length ? checks.join(" ; ") : "the checks configured in STANDARD.md";

  // The canary hash is derived from the canonical probe body so the crew
  // workflow, the canary script, and the watchtower-locked guard can never
  // drift apart at generation time.
  const { CANARY_PROBE_BODY } = await import(
    pathToFileURL(join(pkgRoot, "templates/watchtower/canary.mjs")).href
  );
  const canarySha256 = createHash("sha256").update(CANARY_PROBE_BODY.replace(/\r/g, ""), "utf8").digest("hex");

  const vars = {
    FACILITY_VERSION: version,
    DEFAULT_BRANCH: defaultBranch,
    BUILD_MODEL: models.build,
    REVIEW_MODEL: models.review,
    PLAN_MODEL: models.plan,
    CODEX_BUILD_MODEL: models.codexBuild,
    CODEX_PLAN_MODEL: models.codexPlan,
    CODEX_EFFORT: "xhigh",
    CODEX_VERSION: "0.144.6",
    ARCHITECT_REPO_LANE: "true",
    BUILDER_REPO_LANE: "true",
    CODEX_ARCHITECT_REPO_LANE: "true",
    CODEX_BUILDER_REPO_LANE: "true",
    PROVISION_CMD: provisionCmd,
    CHECKS_INLINE: checksInline,
    CHECKS_RUN: checksRun(checks),
    CHECKS_LIST: checksList(checks),
    ALLOW_CHECKS_JSON: checksAllowJson(checks),
    TOOLCHAIN_STEPS: toolchainSteps(detected.packageManager),
    TOOLCHAIN_STEPS_CONDITIONAL: toolchainSteps(detected.packageManager, { conditional: true }),
    BOARD_STEP: boardStep(org, project),
    BOARD_REVIEW_STEP: boardReviewStep(org, project),
    CANARY_BOT: canaryBot,
    CANARY_SHA256: canarySha256,
    DOCTOR_WATCH: doctorWatch(detected.workflowNames),
    ANTHROPIC_AUTH_SETUP: anthropicAuthSetup(anthropicAuth),
    ANTHROPIC_AUTH_SETUP_CREW: anthropicAuthSetup(
      anthropicAuth,
      "steps.requested-agent.outputs.run == 'true'",
    ),
    ANTHROPIC_AUTH_SETUP_CONDITIONAL: anthropicAuthSetup(
      anthropicAuth,
      "steps.workflow-change.outputs.changed != 'true'",
    ),
    ANTHROPIC_AUTH_INPUTS: anthropicAuthInputs(anthropicAuth),
    PREVIEW_STEP: previewStep(preview),
  };

  const template = (relPath) => readFileSync(join(pkgRoot, "templates", relPath), "utf8");
  const plan = [
    { to: ".github/workflows/facility-crew.yml", content: render(template("workflows/facility-crew.yml"), vars) },
    { to: ".github/workflows/facility-codex.yml", content: render(template("workflows/facility-codex.yml"), vars) },
    { to: ".github/workflows/facility-review.yml", content: render(template("workflows/facility-review.yml"), vars) },
    { to: ".github/workflows/facility-address-review.yml", content: render(template("workflows/facility-address-review.yml"), vars) },
    { to: ".github/workflows/facility-doctor.yml", content: render(template("workflows/facility-doctor.yml"), vars) },
    { to: ".github/workflows/facility-security-sweep.yml", content: render(template("workflows/facility-security-sweep.yml"), vars) },
    { to: ".github/workflows/facility-watchtower.yml", content: render(template("workflows/facility-watchtower.yml"), vars) },
    { to: ".github/workflows/facility-canary.yml", content: render(template("workflows/facility-canary.yml"), vars) },
    { to: ".github/facility/architect.md", content: render(template("prompts/architect.md"), vars) },
    { to: ".github/facility/builder.md", content: render(template("prompts/builder.md"), vars) },
    { to: ".github/facility/doctor.md", content: render(template("prompts/doctor.md"), vars) },
    { to: ".github/facility/sweep.md", content: render(template("prompts/sweep.md"), vars) },
    { to: ".github/facility/doctor/resolve.mjs", content: template("doctor/resolve.mjs") },
    { to: ".github/facility/delivery/verify.mjs", content: template("delivery/verify.mjs") },
    { to: ".github/facility/receipts/collect.mjs", content: template("receipts/collect.mjs") },
    { to: ".github/facility/review/finalize.mjs", content: template("review/finalize.mjs") },
    { to: ".github/facility/security/sync-findings.mjs", content: template("security/sync-findings.mjs") },
    { to: ".github/facility/watchtower/outcomes.mjs", content: template("watchtower/outcomes.mjs") },
    { to: ".github/facility/watchtower/health.mjs", content: template("watchtower/health.mjs") },
    { to: ".github/facility/watchtower/canary.mjs", content: template("watchtower/canary.mjs") },
    { to: ".github/facility/watchtower/budgets.json", content: template("watchtower/budgets.json") },
    { to: ".github/facility/move-board-status.sh", content: template("scripts/move-board-status.sh"), executable: true },
    { to: "STANDARD.md", content: render(template("standard/STANDARD.md"), vars) },
    { to: ".claude/settings.json", content: render(template("claude/settings.json"), vars) },
    { to: ".claude/hooks/protect-branch.mjs", content: render(template("claude/hooks/protect-branch.mjs"), vars) },
    { to: ".claude/hooks/protect-files.mjs", content: template("claude/hooks/protect-files.mjs") },
    { to: ".claude/agents/standards-reviewer.md", content: template("claude/agents/standards-reviewer.md") },
    { to: ".claude/agents/security-reviewer.md", content: template("claude/agents/security-reviewer.md") },
    { to: ".claude/skills/working-to-standard/SKILL.md", content: template("claude/skills/working-to-standard/SKILL.md") },
    { to: ".claude/skills/reviewing-to-standard/SKILL.md", content: template("claude/skills/reviewing-to-standard/SKILL.md") },
    { to: ".claude/skills/maintainable-software/SKILL.md", content: template("claude/skills/maintainable-software/SKILL.md") },
    { to: ".claude/commands/verify.md", content: render(template("claude/commands/verify.md"), vars) },
    { to: ".claude/commands/open-pr.md", content: render(template("claude/commands/open-pr.md"), vars) },
    { to: "guards/run.mjs", content: template("guards/run.mjs") },
    { to: "guards/_kit.mjs", content: template("guards/_kit.mjs") },
    { to: "guards/actions-pinned.mjs", content: template("guards/actions-pinned.mjs") },
    { to: "guards/watchtower-locked.mjs", content: template("guards/watchtower-locked.mjs") },
    { to: "guards/README.md", content: template("guards/README.md") },
  ];

  heading("Writing");
  let written = 0;
  for (const file of plan) {
    const target = join(dir, file.to);
    if (existsSync(target) && !flags.force) {
      skip(`${file.to} exists — left untouched`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    if (file.executable) chmodSync(target, 0o755);
    ok(file.to);
    written += 1;
  }

  // AGENTS.md / CLAUDE.md get a managed block, never an overwrite.
  const agentsBlock = render(template("standard/agents-block.md"), vars);
  for (const entry of ["AGENTS.md", "CLAUDE.md"]) {
    const target = join(dir, entry);
    if (!existsSync(target)) {
      writeFileSync(target, entry === "CLAUDE.md" ? `Follow AGENTS.md.\n\n${agentsBlock}` : `# Agent instructions\n\n${agentsBlock}`);
      ok(entry);
      written += 1;
    } else if (!hasManagedBlock(readFileSync(target, "utf8"))) {
      writeFileSync(target, appendManagedBlock(readFileSync(target, "utf8"), agentsBlock));
      ok(`${entry} (facility block appended)`);
      written += 1;
    } else {
      skip(`${entry} already has a facility block`);
    }
  }

  // Cross-tool: non-Claude agents discover the same skills via .agents/skills.
  const agentsSkillsLink = join(dir, ".agents/skills");
  try {
    lstatSync(agentsSkillsLink);
    skip(".agents/skills exists — left untouched");
  } catch {
    try {
      mkdirSync(join(dir, ".agents"), { recursive: true });
      symlinkSync("../.claude/skills", agentsSkillsLink, "dir");
      ok(".agents/skills → .claude/skills");
    } catch {
      warn(".agents/skills symlink could not be created (filesystem without symlink support) — skipped.");
    }
  }

  const manifest = {
    facility: version,
    engine: "claude-code",
    engines: ["claude-code", "codex"],
    auth: {
      provider: "anthropic",
      mode: anthropicAuth,
      codex: { provider: "openai", mode: "api-key" },
    },
    defaultBranch,
    packageInstall: null,
    provision: provision || null,
    checks,
    models,
    preview,
    canaryBot,
    board: project ? { org, project: Number(project) } : null,
    executionLane: { architect: "repo", builder: "repo" },
    modules: [],
  };
  writeFileSync(join(dir, ".facility.json"), formatManifest(manifest));
  ok(".facility.json");

  for (const moduleName of modules) {
    await addModule(moduleName, { dir, pkgRoot, banner: false });
  }

  heading("Done. The steps only you can do:");
  const steps = [
    authOnboardingStep(anthropicAuth),
    `Store a spend-capped ${bold("OPENAI_API_KEY")} in the ${bold("facility-codex")} Environment to enable /codex-architect and /codex-builder.`,
    `Install the Claude GitHub App on the repo (github.com/apps/claude) so crew pushes re-trigger CI.`,
    `Protect ${bold(defaultBranch)}: require a PR and one human review. The crew never merges; this makes it structural.`,
  ];
  if (project) {
    steps.push(`Add a ${bold("PROJECTS_PAT")} secret (org Projects read+write) so the crew moves the board. It no-ops until then.`);
  }
  steps.push(
    `If your tests need provider keys, put TEST-tier, spend-capped keys in a ${bold("facility-crew")} Environment — never production keys.`
  );
  steps.push(
    `Optional, for the weekly canary: create a small GitHub App, install it on the repo, set ${bold("CANARY_APP_ID")} + ${bold("CANARY_APP_PRIVATE_KEY")} in the facility-crew Environment, and re-run init with --canary-bot=<your-app>[bot] (comments posted with GITHUB_TOKEN trigger nothing). It skips politely until then.`
  );
  steps.push(`Commit, push, open an issue, and comment ${accent("/architect")} on it. That's the whole onboarding.`);
  steps.push(
    `The watchtower starts reporting on its own: nightly outcomes as telemetry/artifacts, daily health as one incident issue while unhealthy, with budgets from .github/facility/watchtower/budgets.json.`
  );
  steps.forEach((step, index) => item(`${bold(String(index + 1) + ".")} ${step}`));
  console.log("");
  item(dim(`${written} files written. Read STANDARD.md next — it is yours now.`));
  console.log("");

  closePrompts();
  return 0;
}
