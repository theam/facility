// biome-ignore-all lint/suspicious/noTemplateCurlyInString: This renderer intentionally emits GitHub expression and shell parameter syntax.
// biome-ignore-all lint/suspicious/noUselessEscapeInString: Backslashes are part of the generated shell token-normalization script.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Manifest, manifestFor } from "./fingerprints.js";

const SETUP_NODE_SHA = "49933ea5288caeca8642d1e84afbd3f7d6820020";
const PNPM_SHA = "b906affcce14559ad1aafd4ab0e942779e9f58b1";
const AWS_AUTH_SHA = "517a711dbcd0e402f90c77e7e2f81e849156e31d";
const GOOGLE_AUTH_SHA = "7c6bc770dae815cd3e89ee6cdf493a5fab2cc093";
const DEFAULT_VERSION = "0.3.0";

export type RenderedFile = {
  path: string;
  content: string;
  executable?: boolean;
  mode?: "100644" | "100755" | "120000";
};

export type RenderAnswers = {
  defaultBranch: string;
  packageInstallCmd?: string;
  provisionCmd?: string;
  checkCmds?: string[];
  modules?: string[];
  modelTier?: string;
  models?: {
    build?: string;
    review?: string;
    plan?: string;
    codexBuild?: string;
    codexPlan?: string;
  };
  authMode?: "api-key" | "oauth" | "wif" | "bedrock" | "vertex";
  board?: { org: string; project: number | string } | null;
  canaryBot?: string;
  packageManager?: "pnpm" | "yarn" | "npm" | "none";
  workflowNames?: string[];
  execution_lane?: Record<string, "repo" | "platform">;
  preview?: {
    enabled: boolean;
    image: string;
    command?: string[];
    port: number;
    readinessPath?: string;
    ttlHours?: number;
  };
};

export type RenderOptions = {
  version?: string;
  templateRoot?: string;
  moduleRoot?: string;
  existingFiles?: Map<string, string> | Record<string, string>;
};

export type RenderResult = {
  files: RenderedFile[];
  manifest: Manifest & { templateSet: string };
  skipped: string[];
  vars: Record<string, string>;
};

const moduleRoot = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  const packagedRoot = join(moduleRoot, "render-assets");
  return existsSync(join(packagedRoot, "packages/cli/templates/watchtower/canary.mjs"))
    ? packagedRoot
    : join(moduleRoot, "../../..");
}

function defaultTemplateRoot(): string {
  return join(repoRoot(), "packages/cli/templates");
}

function defaultModuleRoot(): string {
  return join(repoRoot(), "packages/cli/modules");
}

function existingLookup(existing?: Map<string, string> | Record<string, string>) {
  if (!existing) return new Map<string, string>();
  return existing instanceof Map ? existing : new Map(Object.entries(existing));
}

export function render(template: string, vars: Record<string, string>): string {
  const withBlocks = template.replace(
    /^[ \t]*\{\{([A-Z0-9_]+)\}\}[ \t]*\r?\n/gm,
    (match, name: string) => {
      const value = vars[name];
      if (value === undefined) return match;
      if (value === "") return "";
      return value.endsWith("\n") ? value : `${value}\n`;
    },
  );
  return withBlocks.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, name: string) => vars[name] ?? match);
}

export function hasManagedBlock(content: string): boolean {
  return content.includes("<!-- facility:start");
}

export function appendManagedBlock(content: string, block: string): string {
  const base = content.replace(/\s*$/, "");
  return base ? `${base}\n\n${block}` : block;
}

const MODULES_END = "<!-- facility:modules:end -->";

export function insertModuleSection(
  standard: string,
  section: string,
  moduleTitle: string,
): { content: string; inserted: boolean } {
  if (
    standard.includes("(facility module)") &&
    standard.includes(`### ${moduleTitle} (facility module)`)
  ) {
    return { content: standard, inserted: false };
  }
  const end = standard.indexOf(MODULES_END);
  if (end === -1) {
    const block = `\n## Modules\n\n${section.trim()}\n`;
    return { content: `${standard.replace(/\s*$/, "")}\n${block}`, inserted: true };
  }
  const before = standard.slice(0, end).replace(/[ \t]*$/, "");
  const after = standard.slice(end);
  return { content: `${before}${section.trim()}\n\n${after}`, inserted: true };
}

const HOOK_MARKER = "/* facility:module-rules */";

export function insertHookRules(
  hookSource: string,
  fragment: string,
  moduleName: string,
): { content: string; inserted: boolean } {
  const sentinel = `facility module: ${moduleName}`;
  if (hookSource.includes(sentinel)) return { content: hookSource, inserted: false };
  if (!hookSource.includes(HOOK_MARKER)) return { content: hookSource, inserted: false };
  return {
    content: hookSource.replace(HOOK_MARKER, `${fragment.trim()}\n\n${HOOK_MARKER}`),
    inserted: true,
  };
}

function toolchainSteps(packageManager: string, { conditional = false } = {}): string {
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

function boardStep(board?: RenderAnswers["board"]): string {
  if (!board?.project) return "";
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
    "          GH_TOKEN: " + "$" + "{{ secrets.PROJECTS_PAT }}",
    "          MODE: " + "$" + "{{ steps.requested-agent.outputs.mode }}",
    "          ISSUE_NODE_ID: " + "$" + "{{ github.event.issue.node_id }}",
    `          ORG: '${board.org}'`,
    `          PROJECT_NUMBER: '${board.project}'`,
    "        run: bash .github/facility/move-board-status.sh",
    "",
  ].join("\n");
}

function boardReviewStep(board?: RenderAnswers["board"]): string {
  if (!board?.project) return "";
  return [
    "",
    "      - name: Move delivered work to In Review",
    "        if: steps.delivery.outcome == 'success' && github.event.issue.pull_request == null",
    "        env:",
    "          GH_TOKEN: " + "$" + "{{ secrets.PROJECTS_PAT }}",
    "          MODE: review",
    "          ISSUE_NODE_ID: " + "$" + "{{ github.event.issue.node_id }}",
    `          ORG: '${board.org}'`,
    `          PROJECT_NUMBER: '${board.project}'`,
    "        run: bash .github/facility/move-board-status.sh",
    "",
  ].join("\n");
}

function doctorWatch(workflowNames: string[]): string {
  const watched = [...new Set([...workflowNames, "facility-review"])];
  const lines = watched.map((name) => `      - ${name}`);
  if (workflowNames.length === 0) {
    lines.unshift("      # facility: no existing check workflows detected at init time —");
    lines.unshift("      # add your CI workflow names here so the doctor watches them.");
  }
  return lines.join("\n");
}

function checksAllowJson(checks: string[]): string {
  if (!checks.length) return "";
  return checks.map((check) => `      "Bash(${check})",`).join("\n");
}

function checksList(checks: string[]): string {
  const lines = checks.length
    ? checks.map((check) => `- \`${check}\``)
    : ["- _No check commands configured yet — add your typecheck/lint/test/build commands here._"];
  lines.push("- `node guards/run.mjs` — deterministic repo invariants. Always cheap; always run.");
  lines.push("");
  lines.push(
    "Escalate beyond this list when the change touches data, auth, or critical user flows — and say which extra checks ran.",
  );
  return lines.join("\n");
}

function checksRun(checks: string[]): string {
  if (checks.length) return checks.map((command) => `          ${command}`).join("\n");
  return [
    '          echo "::error::No verification commands are configured in .facility.json."',
    "          exit 1",
  ].join("\n");
}

function previewStep(preview?: RenderAnswers["preview"]): string {
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
    '          payload="$(jq -nc --arg image "$PREVIEW_IMAGE" --argjson command "$PREVIEW_COMMAND_JSON" --argjson port "$PREVIEW_PORT" --arg readiness "$PREVIEW_READINESS_PATH" --argjson ttl "$PREVIEW_TTL_HOURS" --argjson pr \'${{ steps.delivery.outputs.pr_number }}\' --arg commit \'${{ steps.delivery.outputs.head_sha }}\' \'{image:$image,command:$command,port:$port,ttlHours:$ttl,prNumber:$pr,commitSha:$commit} + if $readiness == "" then {} else {readinessPath:$readiness} end\')"',
    '          curl --fail-with-body --silent --show-error -X POST "$FACILITY_API_URL/v1/projects/$FACILITY_PROJECT_ID/previews" -H "authorization: Bearer $FACILITY_PREVIEW_KEY" -H "content-type: application/json" -H "idempotency-key: preview-${{ github.run_id }}-${{ github.run_attempt }}" --data "$payload"',
    "",
  ].join("\n");
}

function anthropicAuthSetup(mode: RenderAnswers["authMode"], condition = ""): string {
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
      '          token="${token#export CLAUDE_CODE_OAUTH_TOKEN=}"',
      '          token="${token#CLAUDE_CODE_OAUTH_TOKEN=}"',
      '          token="${token#\\\"}"',
      '          token="${token%\\\"}"',
      '          token="${token#\\\'}"',
      '          token="${token%\\\'}"',
      "",
      '          if [ -z "$token" ]; then',
      "            echo \"::error::CLAUDE_CODE_OAUTH_TOKEN is empty. Generate it with 'claude setup-token' and store it as a repository or organization secret.\"",
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

function anthropicAuthInputs(mode: RenderAnswers["authMode"]): string {
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

function formatManifest(manifest: Record<string, unknown> & { checks: string[] }): string {
  let text = JSON.stringify(manifest, null, 2).replace(
    '  "engines": [\n    "claude-code",\n    "codex"\n  ],',
    '  "engines": ["claude-code", "codex"],',
  );
  const preview = manifest.preview as { command?: string[] } | undefined;
  if (preview?.command?.length) {
    const expanded = `    "command": [\n${preview.command
      .map((part) => `      ${JSON.stringify(part)}`)
      .join(",\n")}\n    ],`;
    text = text.replace(
      expanded,
      `    "command": [${preview.command.map((part) => JSON.stringify(part)).join(", ")}],`,
    );
  }
  const compactChecks = `  "checks": [${manifest.checks.map((check) => JSON.stringify(check)).join(", ")}],`;
  if (compactChecks.length > 100 || manifest.checks.length === 0) return `${text}\n`;
  const lines = text.split("\n");
  const start = lines.indexOf('  "checks": [');
  const end = lines.indexOf("  ],", start + 1);
  if (start < 0 || end < 0) return `${text}\n`;
  lines.splice(start, end - start + 1, compactChecks);
  return `${lines.join("\n")}\n`;
}

async function canarySha256(templateRoot: string): Promise<string> {
  const mod = (await import(pathToFileURL(join(templateRoot, "watchtower/canary.mjs")).href)) as {
    CANARY_PROBE_BODY: string;
  };
  return createHash("sha256")
    .update(mod.CANARY_PROBE_BODY.replace(/\r/g, ""), "utf8")
    .digest("hex");
}

function addOrReplace(files: Map<string, RenderedFile>, file: RenderedFile) {
  files.set(file.path, { ...file, mode: file.mode ?? (file.executable ? "100755" : "100644") });
}

export async function renderFacilityInit(
  answers: RenderAnswers,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const version = options.version ?? DEFAULT_VERSION;
  const templateRoot = options.templateRoot ?? defaultTemplateRoot();
  const moduleRoot = options.moduleRoot ?? defaultModuleRoot();
  const existing = existingLookup(options.existingFiles);
  const files = new Map<string, RenderedFile>();
  const skipped: string[] = [];
  const models = {
    build: answers.models?.build ?? "opusplan",
    review: answers.models?.review ?? "claude-sonnet-4-6",
    plan: answers.models?.plan ?? "claude-opus-4-8",
    codexBuild: answers.models?.codexBuild ?? "gpt-5.6-sol",
    codexPlan: answers.models?.codexPlan ?? "gpt-5.6-sol",
  };
  const checks = answers.checkCmds ?? [];
  const authMode = answers.authMode ?? "api-key";
  const provision =
    answers.provisionCmd ||
    'echo "facility: no provision command configured — the crew runs on a bare checkout. Set one in this workflow + .facility.json."';
  const vars = {
    FACILITY_VERSION: version,
    DEFAULT_BRANCH: answers.defaultBranch,
    BUILD_MODEL: models.build,
    REVIEW_MODEL: models.review,
    PLAN_MODEL: models.plan,
    CODEX_BUILD_MODEL: models.codexBuild,
    CODEX_PLAN_MODEL: models.codexPlan,
    CODEX_EFFORT: "xhigh",
    CODEX_VERSION: "0.144.6",
    ARCHITECT_REPO_LANE:
      answers.execution_lane?.architect === "platform" ||
      answers.execution_lane?.["/architect"] === "platform"
        ? "false"
        : "true",
    BUILDER_REPO_LANE:
      answers.execution_lane?.builder === "platform" ||
      answers.execution_lane?.["/builder"] === "platform"
        ? "false"
        : "true",
    CODEX_ARCHITECT_REPO_LANE:
      answers.execution_lane?.["codex-architect"] === "platform" ||
      answers.execution_lane?.["/codex-architect"] === "platform"
        ? "false"
        : "true",
    CODEX_BUILDER_REPO_LANE:
      answers.execution_lane?.["codex-builder"] === "platform" ||
      answers.execution_lane?.["/codex-builder"] === "platform"
        ? "false"
        : "true",
    PROVISION_CMD: provision,
    CHECKS_INLINE: checks.length ? checks.join(" ; ") : "the checks configured in STANDARD.md",
    CHECKS_LIST: checksList(checks),
    CHECKS_RUN: checksRun(checks),
    ALLOW_CHECKS_JSON: checksAllowJson(checks),
    TOOLCHAIN_STEPS: toolchainSteps(answers.packageManager ?? "none"),
    TOOLCHAIN_STEPS_CONDITIONAL: toolchainSteps(answers.packageManager ?? "none", {
      conditional: true,
    }),
    BOARD_STEP: boardStep(answers.board),
    BOARD_REVIEW_STEP: boardReviewStep(answers.board),
    CANARY_BOT: answers.canaryBot ?? "facility-canary[bot]",
    CANARY_SHA256: await canarySha256(templateRoot),
    DOCTOR_WATCH: doctorWatch(answers.workflowNames ?? []),
    ANTHROPIC_AUTH_SETUP: anthropicAuthSetup(authMode),
    ANTHROPIC_AUTH_SETUP_CREW: anthropicAuthSetup(
      authMode,
      "steps.requested-agent.outputs.run == 'true'",
    ),
    ANTHROPIC_AUTH_SETUP_CONDITIONAL: anthropicAuthSetup(
      authMode,
      "steps.workflow-change.outputs.changed != 'true'",
    ),
    ANTHROPIC_AUTH_INPUTS: anthropicAuthInputs(authMode),
    PREVIEW_STEP: previewStep(answers.preview),
  };
  const template = (relPath: string) => readFileSync(join(templateRoot, relPath), "utf8");
  const plan: RenderedFile[] = [
    {
      path: ".github/workflows/facility-crew.yml",
      content: render(template("workflows/facility-crew.yml"), vars),
    },
    {
      path: ".github/workflows/facility-codex.yml",
      content: render(template("workflows/facility-codex.yml"), vars),
    },
    {
      path: ".github/workflows/facility-review.yml",
      content: render(template("workflows/facility-review.yml"), vars),
    },
    {
      path: ".github/workflows/facility-address-review.yml",
      content: render(template("workflows/facility-address-review.yml"), vars),
    },
    {
      path: ".github/workflows/facility-doctor.yml",
      content: render(template("workflows/facility-doctor.yml"), vars),
    },
    {
      path: ".github/workflows/facility-security-sweep.yml",
      content: render(template("workflows/facility-security-sweep.yml"), vars),
    },
    {
      path: ".github/workflows/facility-watchtower.yml",
      content: render(template("workflows/facility-watchtower.yml"), vars),
    },
    {
      path: ".github/workflows/facility-canary.yml",
      content: render(template("workflows/facility-canary.yml"), vars),
    },
    {
      path: ".github/facility/architect.md",
      content: render(template("prompts/architect.md"), vars),
    },
    { path: ".github/facility/builder.md", content: render(template("prompts/builder.md"), vars) },
    { path: ".github/facility/doctor.md", content: render(template("prompts/doctor.md"), vars) },
    { path: ".github/facility/sweep.md", content: render(template("prompts/sweep.md"), vars) },
    { path: ".github/facility/doctor/resolve.mjs", content: template("doctor/resolve.mjs") },
    { path: ".github/facility/delivery/verify.mjs", content: template("delivery/verify.mjs") },
    { path: ".github/facility/receipts/collect.mjs", content: template("receipts/collect.mjs") },
    { path: ".github/facility/review/finalize.mjs", content: template("review/finalize.mjs") },
    {
      path: ".github/facility/security/sync-findings.mjs",
      content: template("security/sync-findings.mjs"),
    },
    {
      path: ".github/facility/watchtower/outcomes.mjs",
      content: template("watchtower/outcomes.mjs"),
    },
    { path: ".github/facility/watchtower/health.mjs", content: template("watchtower/health.mjs") },
    { path: ".github/facility/watchtower/canary.mjs", content: template("watchtower/canary.mjs") },
    {
      path: ".github/facility/watchtower/budgets.json",
      content: template("watchtower/budgets.json"),
    },
    {
      path: ".github/facility/move-board-status.sh",
      content: template("scripts/move-board-status.sh"),
      executable: true,
    },
    { path: "STANDARD.md", content: render(template("standard/STANDARD.md"), vars) },
    { path: ".claude/settings.json", content: render(template("claude/settings.json"), vars) },
    {
      path: ".claude/hooks/protect-branch.mjs",
      content: render(template("claude/hooks/protect-branch.mjs"), vars),
    },
    {
      path: ".claude/hooks/protect-files.mjs",
      content: template("claude/hooks/protect-files.mjs"),
    },
    {
      path: ".claude/agents/standards-reviewer.md",
      content: template("claude/agents/standards-reviewer.md"),
    },
    {
      path: ".claude/agents/security-reviewer.md",
      content: template("claude/agents/security-reviewer.md"),
    },
    {
      path: ".claude/skills/working-to-standard/SKILL.md",
      content: template("claude/skills/working-to-standard/SKILL.md"),
    },
    {
      path: ".claude/skills/reviewing-to-standard/SKILL.md",
      content: template("claude/skills/reviewing-to-standard/SKILL.md"),
    },
    {
      path: ".claude/skills/maintainable-software/SKILL.md",
      content: template("claude/skills/maintainable-software/SKILL.md"),
    },
    {
      path: ".claude/commands/verify.md",
      content: render(template("claude/commands/verify.md"), vars),
    },
    {
      path: ".claude/commands/open-pr.md",
      content: render(template("claude/commands/open-pr.md"), vars),
    },
    { path: "guards/run.mjs", content: template("guards/run.mjs") },
    { path: "guards/_kit.mjs", content: template("guards/_kit.mjs") },
    { path: "guards/actions-pinned.mjs", content: template("guards/actions-pinned.mjs") },
    { path: "guards/watchtower-locked.mjs", content: template("guards/watchtower-locked.mjs") },
    { path: "guards/README.md", content: template("guards/README.md") },
  ];
  for (const file of plan) {
    if (existing.has(file.path)) {
      skipped.push(file.path);
      continue;
    }
    addOrReplace(files, file);
  }
  const agentsBlock = render(template("standard/agents-block.md"), vars);
  for (const entry of ["AGENTS.md", "CLAUDE.md"]) {
    const current = existing.get(entry);
    if (current === undefined) {
      addOrReplace(files, {
        path: entry,
        content:
          entry === "CLAUDE.md"
            ? `Follow AGENTS.md.\n\n${agentsBlock}`
            : `# Agent instructions\n\n${agentsBlock}`,
      });
    } else if (!hasManagedBlock(current)) {
      addOrReplace(files, { path: entry, content: appendManagedBlock(current, agentsBlock) });
    } else {
      skipped.push(entry);
    }
  }
  if (existing.has(".agents/skills")) {
    skipped.push(".agents/skills");
  } else {
    addOrReplace(files, { path: ".agents/skills", content: "../.claude/skills", mode: "120000" });
  }
  const manifest = {
    facility: version,
    engine: "claude-code",
    engines: ["claude-code", "codex"],
    auth: {
      provider: "anthropic",
      mode: authMode,
      codex: { provider: "openai", mode: "api-key" },
    },
    defaultBranch: answers.defaultBranch,
    packageInstall: answers.packageInstallCmd || null,
    provision: answers.provisionCmd || null,
    checks,
    models,
    preview: answers.preview,
    canaryBot: answers.canaryBot ?? "facility-canary[bot]",
    board: answers.board?.project
      ? { org: answers.board.org, project: Number(answers.board.project) }
      : null,
    executionLane: answers.execution_lane ?? { architect: "repo", builder: "repo" },
    modules: [],
  };
  addOrReplace(files, {
    path: ".facility.json",
    content: formatManifest(manifest),
  });
  for (const moduleName of answers.modules ?? []) {
    applyModule(files, existing, moduleRoot, moduleName);
  }
  const out = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files: out,
    manifest: {
      ...manifestFor(out.map((file) => ({ path: file.path, content: file.content }))),
      templateSet: version,
    },
    skipped,
    vars,
  };
}

type ModuleManifest = {
  name: string;
  title: string;
  standardSection?: string;
  hookRules?: string;
  files?: { from: string; to: string }[];
};

function getFile(
  files: Map<string, RenderedFile>,
  existing: Map<string, string>,
  path: string,
): string | undefined {
  return files.get(path)?.content ?? existing.get(path);
}

function applyModule(
  files: Map<string, RenderedFile>,
  existing: Map<string, string>,
  moduleRoot: string,
  moduleName: string,
) {
  const moduleDir = join(moduleRoot, moduleName);
  const manifestPath = join(moduleDir, "module.json");
  if (!existsSync(manifestPath)) throw new Error(`Unknown module "${moduleName}"`);
  const module = JSON.parse(readFileSync(manifestPath, "utf8")) as ModuleManifest;
  for (const file of module.files ?? []) {
    if (!existing.has(file.to) && !files.has(file.to)) {
      addOrReplace(files, {
        path: file.to,
        content: readFileSync(join(moduleDir, file.from), "utf8"),
      });
    }
  }
  if (module.standardSection) {
    const standard = getFile(files, existing, "STANDARD.md");
    if (standard !== undefined) {
      const section = readFileSync(join(moduleDir, module.standardSection), "utf8");
      const next = insertModuleSection(standard, section, module.title);
      if (next.inserted) addOrReplace(files, { path: "STANDARD.md", content: next.content });
    }
  }
  if (module.hookRules) {
    const hook = getFile(files, existing, ".claude/hooks/protect-files.mjs");
    if (hook !== undefined) {
      const fragment = readFileSync(join(moduleDir, module.hookRules), "utf8");
      const next = insertHookRules(hook, fragment, module.name);
      if (next.inserted)
        addOrReplace(files, { path: ".claude/hooks/protect-files.mjs", content: next.content });
    }
  }
  const facilityJson = getFile(files, existing, ".facility.json");
  if (facilityJson !== undefined) {
    const parsed = JSON.parse(facilityJson) as { modules?: string[] };
    if (!parsed.modules?.includes(module.name)) {
      parsed.modules = [...(parsed.modules ?? []), module.name];
      addOrReplace(files, {
        path: ".facility.json",
        content: `${JSON.stringify(parsed, null, 2)}\n`,
      });
    }
  }
}
