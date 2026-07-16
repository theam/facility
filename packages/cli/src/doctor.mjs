// `facility doctor` — check the install and tell the truth about what's left.
// Static checks run locally; the GitHub-side items it can't verify are
// printed as the explicit manual checklist instead of being assumed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProfile, loadConfig } from "./platform-config.mjs";
import { banner, bold, dim, fail, green, heading, item, ok, red, warn, yellow } from "./ui.mjs";

const REQUIRED = [
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
  "STANDARD.md",
  "AGENTS.md",
  ".claude/hooks/protect-branch.mjs",
  ".claude/hooks/protect-files.mjs",
  ".claude/skills/working-to-standard/SKILL.md",
  ".claude/skills/reviewing-to-standard/SKILL.md",
  ".claude/skills/maintainable-software/SKILL.md",
  ".claude/commands/verify.md",
  "guards/run.mjs",
];

export async function doctor(flags, version, options = {}) {
  const platform = platformTarget(flags, options);
  if (!flags.local && platform) return platformDoctor(flags, version, platform, options);
  if ((flags.platform || flags.url || flags.key || flags.profile) && !platform) {
    const message = "facility doctor needs both --url and --key, or a saved login profile.";
    if (flags.json) {
      (options.stdout || process.stdout).write(
        `${JSON.stringify({
          mode: "platform",
          target: null,
          ok: false,
          checks: [],
          error: { code: "doctor_target_required", message },
        })}\n`,
      );
    }
    else console.log(message);
    return 2;
  }

  const dir = flags.dir || process.cwd();
  const report = inspectLocalInstall(dir, {
    runGuards: flags["run-guards"] === true,
    github: flags.github === true,
  });
  if (flags.json) {
    (options.stdout || process.stdout).write(`${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 1;
  }

  banner(version);
  renderLocalReport(report);
  console.log("");
  if (report.ok) item(`${dim("Everything checkable checks out.")}`);
  else item(`${dim(`${report.problems} problem${report.problems === 1 ? "" : "s"} found.`)}`);
  console.log("");
  return report.ok ? 0 : 1;
}

function inspectLocalInstall(dir, options = {}) {
  const checks = [];
  for (const file of REQUIRED) {
    checks.push(
      existsSync(join(dir, file))
        ? localCheck("Files", file, "pass", "Present")
        : localCheck("Files", file, "fail", "missing", "Run `npx @theam/facility init`."),
    );
  }

  const manifestPath = join(dir, ".facility.json");
  if (!existsSync(manifestPath)) {
    checks.push(localCheck("Manifest", ".facility.json", "fail", "missing"));
  } else {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      const models = manifest.models;
      checks.push(
        models?.build && models?.review && models?.plan
          ? localCheck(
              "Manifest",
              ".facility.json",
              "pass",
              `engine ${manifest.engine || "claude-code"}, models build=${models.build}, review=${models.review}, plan=${models.plan}`,
            )
          : localCheck(
              "Manifest",
              "models",
              "fail",
              "models.build, models.review, and models.plan must all be configured.",
              "Rerun init with explicit build, review, and plan models.",
            ),
      );
      const mode = detectAnthropicAuthMode(manifest, dir);
      checks.push(
        mode
          ? localCheck("Manifest", "auth", "pass", `Anthropic auth: ${mode}`)
          : localCheck(
              "Manifest",
              "auth",
              "fail",
              "Anthropic auth mode is missing or unsupported.",
              "Rerun init with --auth=<api-key|oauth|wif|bedrock|vertex>.",
            ),
      );
      checks.push(
        manifest.provision
          ? localCheck("Manifest", "provision", "pass", String(manifest.provision))
          : localCheck(
              "Manifest",
              "provision",
              "fail",
              "No provision command configured; the crew will under-verify.",
              "Set manifest.provision.",
            ),
      );
      checks.push(
        manifest.checks?.length
          ? localCheck("Manifest", "checks", "pass", manifest.checks.join(", "))
          : localCheck(
              "Manifest",
              "checks",
              "fail",
              "No check commands configured; verify-before-done has nothing to run.",
              "Set manifest.checks.",
            ),
      );
    } catch (error) {
      checks.push(
        localCheck(
          "Manifest",
          ".facility.json",
          "fail",
          `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          "Repair the manifest or rerun `npx @theam/facility init --force`.",
        ),
      );
    }
  }

  if (existsSync(join(dir, "guards/run.mjs")) && options.runGuards) {
    const result = spawnSync(process.execPath, ["guards/run.mjs"], { cwd: dir, encoding: "utf8" });
    checks.push(
      result.status === 0
        ? localCheck("Guards", "guards/run.mjs", "pass", "Guards pass")
        : localCheck(
            "Guards",
            "guards/run.mjs",
            "fail",
            "Guards failed",
            "Run `node guards/run.mjs` and fix every reported violation.",
            `${result.stdout}${result.stderr}`.trim(),
          ),
      );
  } else if (existsSync(join(dir, "guards/run.mjs"))) {
    checks.push(
      localCheck(
        "Guards",
        "guards/run.mjs",
        "warn",
        "Not executed by the static doctor.",
        "Pass --run-guards only for a trusted checkout, or run `node guards/run.mjs` directly.",
      ),
    );
  }

  let manifest = {};
  try {
    manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  } catch {
    // The manifest parse failure is already represented in checks.
  }
  const requirements = authRequirements(detectAnthropicAuthMode(manifest, dir));
  const ghSecrets = options.github
    ? spawnSync("gh", ["secret", "list"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
      })
    : undefined;
  const ghVariables = options.github
    ? spawnSync("gh", ["variable", "list"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 10_000,
      })
    : undefined;
  if (ghSecrets?.status === 0 && ghVariables?.status === 0) {
    const secrets = namesFromGhList(ghSecrets.stdout);
    const variables = namesFromGhList(ghVariables.stdout);
    for (const name of requirements.secrets) {
      checks.push(
        secrets.has(name)
          ? localCheck("GitHub", name, "pass", "Secret exists")
          : localCheck("GitHub", name, "fail", "Secret not found", requirements.remediation),
      );
    }
    for (const name of requirements.variables) {
      checks.push(
        variables.has(name)
          ? localCheck("GitHub", name, "pass", "Variable exists")
          : localCheck("GitHub", name, "fail", "Variable not found", requirements.remediation),
      );
    }
  } else if (options.github) {
    checks.push(
      localCheck(
        "GitHub",
        "automation credentials",
        "warn",
        "Could not query secrets and variables because gh is unavailable or unauthenticated.",
        "Verify the required repo/org credentials manually.",
      ),
    );
  } else {
    for (const name of requirements.secrets) {
      checks.push(
        localCheck(
          "GitHub",
          name,
          "warn",
          "Secret not queried by the offline doctor.",
          "Pass --github to query with gh, or verify it manually.",
        ),
      );
    }
    for (const name of requirements.variables) {
      checks.push(
        localCheck(
          "GitHub",
          name,
          "warn",
          "Variable not queried by the offline doctor.",
          "Pass --github to query with gh, or verify it manually.",
        ),
      );
    }
  }
  const manual = [
    "Claude GitHub App installed on the repo",
    "default branch protected: PR + 1 human review required",
    "provider TEST keys (if any) live in the facility-crew Environment",
  ];
  const problems = checks.filter((check) => check.status === "fail").length;
  return { ok: problems === 0, mode: "local", directory: dir, problems, checks, manual };
}

function localCheck(section, label, status, message, remediation, detail) {
  return {
    section,
    label,
    status,
    message,
    ...(remediation ? { remediation } : {}),
    ...(detail ? { detail } : {}),
  };
}

function renderLocalReport(report) {
  for (const section of ["Files", "Manifest", "Guards", "GitHub"]) {
    heading(section === "GitHub" ? "GitHub side (verify by hand or with gh)" : section);
    for (const check of report.checks.filter((candidate) => candidate.section === section)) {
      const message = `${check.label}${check.message && check.message !== "Present" ? ` — ${check.message}` : ""}${
        check.remediation ? ` — ${check.remediation}` : ""
      }`;
      if (check.status === "pass") ok(message);
      else if (check.status === "warn") warn(message);
      else fail(message);
      if (check.detail) {
        console.log(
          check.detail
            .split("\n")
            .map((line) => `      ${line}`)
            .join("\n"),
        );
      }
    }
  }
  for (const line of report.manual) item(dim(`  · ${line}`));
}

function detectAnthropicAuthMode(manifest, dir) {
  const configured = manifest.auth?.provider === "anthropic" ? manifest.auth.mode : undefined;
  if (["api-key", "oauth", "wif", "bedrock", "vertex"].includes(configured)) return configured;

  const workflowPath = join(dir, ".github/workflows/facility-crew.yml");
  if (!existsSync(workflowPath)) return undefined;
  const workflow = readFileSync(workflowPath, "utf8");
  if (workflow.includes("anthropic_federation_rule_id:")) return "wif";
  if (workflow.includes("use_bedrock:")) return "bedrock";
  if (workflow.includes("use_vertex:")) return "vertex";
  if (workflow.includes("anthropic_api_key:")) return "api-key";
  if (workflow.includes("claude_code_oauth_token:")) return "oauth";
  return undefined;
}

function authRequirements(mode) {
  if (mode === "api-key") {
    return {
      secrets: ["ANTHROPIC_API_KEY"],
      variables: [],
      remediation: "store a dedicated, spend-capped test key",
    };
  }
  if (mode === "oauth") {
    return {
      secrets: ["CLAUDE_CODE_OAUTH_TOKEN"],
      variables: [],
      remediation: "run `claude setup-token`, then store the token",
    };
  }
  if (mode === "wif") {
    return {
      secrets: [],
      variables: ["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"],
      remediation: "configure Anthropic Workload Identity Federation",
    };
  }
  if (mode === "bedrock") {
    return {
      secrets: ["AWS_ROLE_TO_ASSUME"],
      variables: ["AWS_REGION"],
      remediation: "configure the AWS GitHub OIDC role and Bedrock region",
    };
  }
  if (mode === "vertex") {
    return {
      secrets: [],
      variables: ["GCP_WORKLOAD_IDENTITY_PROVIDER", "GCP_SERVICE_ACCOUNT"],
      remediation: "configure Google Workload Identity Federation for Vertex AI",
    };
  }
  return { secrets: [], variables: [], remediation: "select a supported auth mode" };
}

function namesFromGhList(output) {
  return new Set(
    output
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
}

function platformTarget(flags, options) {
  if (!flags.platform && !flags.profile && !flags.url && !flags.key) return null;
  if (flags.url || flags.key) {
    if (!flags.url || !flags.key) return null;
    return { url: stripSlash(flags.url), key: flags.key, profileName: flags.profile || "adhoc" };
  }
  const configPath = options.configPath || options.env?.FACILITY_CONFIG || process.env.FACILITY_CONFIG;
  const config = options.config || loadConfig(configPath);
  const { name, value } = getProfile(config, flags.profile);
  if (!value?.url || !value?.key) return null;
  return {
    url: stripSlash(value.url),
    key: value.key,
    profileName: name,
    allowInsecure: value.allowInsecure === true,
  };
}

async function platformDoctor(flags, version, target, options) {
  const stdout = options.stdout || process.stdout;
  const fetchImpl = options.fetch || fetch;
  const write = (line = "") => stdout.write(`${line}\n`);
  if (!flags.json) {
    write("");
    write(`  ${bold("facility")} ${dim(`v${version}`)} ${dim("— deployment readiness doctor")}`);
    write("");
    write(`  ${bold("Profile")}  ${target.profileName}`);
    write(`  ${bold("API")}      ${target.url}`);
    write("");
  }
  try {
    assertSafePlatformUrl(target.url, flags, target.allowInsecure);
    const payload = await requestDoctor(fetchImpl, target, doctorTimeoutMs(flags.timeout));
    if (flags.json) {
      write(
        JSON.stringify({
          mode: "platform",
          target: { profile: target.profileName, url: target.url },
          ...payload,
        }),
      );
      return payload.ok ? 0 : 1;
    }
    write(bold("Readiness"));
    for (const check of payload.checks || []) {
      const marker =
        check.status === "pass" ? green("✓") : check.status === "warn" ? yellow("!") : red("✗");
      write(`  ${marker} ${check.label}`);
      write(`    ${dim(check.message)}`);
      if (check.remediation) write(`    ${bold("Fix:")} ${check.remediation}`);
    }
    write("");
    write(payload.ok ? "Ready for production traffic." : "Not ready for production traffic.");
    write("");
    return payload.ok ? 0 : 1;
  } catch (error) {
    if (flags.json) {
      write(JSON.stringify({
        mode: "platform",
        target: { profile: target.profileName, url: target.url },
        ok: false,
        checks: [],
        error: {
          code: error.status === 401 ? "unauthorized" : error.code || "doctor_failed",
          message: error.message || "facility doctor failed",
          ...(error.status ? { status: error.status } : {}),
        },
      }));
    } else write(error.message || "facility doctor failed");
    return error.status === 401 ? 2 : 1;
  }
}

function assertSafePlatformUrl(value, flags, profileAllowsInsecure = false) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Facility API URL must be a valid absolute URL");
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (
    parsed.protocol !== "https:" &&
    !local &&
    !flags["allow-insecure"] &&
    !profileAllowsInsecure
  ) {
    const error = new Error(
      "Refusing to send an API key over plain HTTP. Use HTTPS or pass --allow-insecure for a trusted development endpoint.",
    );
    error.code = "insecure_api_url";
    throw error;
  }
}

async function requestDoctor(fetchImpl, target, timeoutMs) {
  const response = await fetchImpl(new URL(`${target.url}/v1/admin/doctor`), {
    method: "GET",
    headers: { authorization: `Bearer ${target.key}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => undefined);
  if (!payload || typeof payload !== "object") {
    throw new Error("Facility API returned an invalid JSON response");
  }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Facility API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (typeof payload.ok !== "boolean" || !Array.isArray(payload.checks)) {
    throw new Error("Facility API returned an invalid doctor response");
  }
  return payload;
}

function doctorTimeoutMs(value) {
  if (value === undefined) return 30_000;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300) {
    const error = new Error("--timeout must be greater than 0 and at most 300 seconds");
    error.code = "invalid_flag";
    throw error;
  }
  return Math.round(seconds * 1_000);
}

function stripSlash(value) {
  return String(value).replace(/\/$/, "");
}
