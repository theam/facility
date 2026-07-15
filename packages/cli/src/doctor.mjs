// `facility doctor` — check the install and tell the truth about what's left.
// Static checks run locally; the GitHub-side items it can't verify are
// printed as the explicit manual checklist instead of being assumed.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProfile, loadConfig } from "./platform-config.mjs";
import { banner, fail, heading, item, ok, warn, dim } from "./ui.mjs";

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
  if ((flags.url || flags.key || flags.profile) && !platform) {
    console.log("facility doctor needs both --url and --key, or a saved login profile.");
    return 2;
  }

  const dir = flags.dir || process.cwd();
  banner(version);

  let problems = 0;

  heading("Files");
  for (const file of REQUIRED) {
    if (existsSync(join(dir, file))) ok(file);
    else {
      fail(`${file} missing — run \`npx @theam/facility init\``);
      problems += 1;
    }
  }

  heading("Manifest");
  const manifestPath = join(dir, ".facility.json");
  if (!existsSync(manifestPath)) {
    fail(".facility.json missing");
    problems += 1;
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const models = manifest.models;
    if (models?.build && models?.review && models?.plan) {
      ok(
        `engine ${manifest.engine || "claude-code"} · models build=${models.build}, review=${models.review}, plan=${models.plan}`,
      );
    } else {
      fail("models.build, models.review, and models.plan must all be configured");
      problems += 1;
    }
    const mode = detectAnthropicAuthMode(manifest, dir);
    if (mode) ok(`Anthropic auth: ${mode}`);
    else {
      fail("Anthropic auth mode is missing or unsupported — run init with --auth=<mode>");
      problems += 1;
    }
    if (!manifest.provision) {
      warn("no provision command configured — the crew runs on a bare checkout and WILL under-verify. Set one.");
      problems += 1;
    } else ok(`provision: ${manifest.provision}`);
    if (!manifest.checks?.length) {
      warn("no check commands configured — 'verify before done' has nothing to run.");
      problems += 1;
    } else ok(`checks: ${manifest.checks.join(", ")}`);
  }

  heading("Guards");
  if (existsSync(join(dir, "guards/run.mjs"))) {
    const result = spawnSync(process.execPath, ["guards/run.mjs"], { cwd: dir, encoding: "utf8" });
    if (result.status === 0) ok("guards pass");
    else {
      fail("guards failing:");
      console.log(
        (result.stdout + result.stderr)
          .split("\n")
          .map((line) => `      ${line}`)
          .join("\n")
      );
      problems += 1;
    }
  }

  heading("GitHub automation (verify by hand or with gh)");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : {};
  const mode = detectAnthropicAuthMode(manifest, dir);
  const requirements = authRequirements(mode);
  const ghSecrets = spawnSync("gh", ["secret", "list"], { cwd: dir, encoding: "utf8" });
  const ghVariables = spawnSync("gh", ["variable", "list"], { cwd: dir, encoding: "utf8" });
  if (ghSecrets.status === 0 && ghVariables.status === 0) {
    const secrets = namesFromGhList(ghSecrets.stdout);
    const variables = namesFromGhList(ghVariables.stdout);
    for (const name of requirements.secrets) {
      if (secrets.has(name)) ok(`${name} secret exists`);
      else {
        fail(`${name} secret not found (${requirements.remediation})`);
        problems += 1;
      }
    }
    for (const name of requirements.variables) {
      if (variables.has(name)) ok(`${name} variable exists`);
      else {
        fail(`${name} variable not found (${requirements.remediation})`);
        problems += 1;
      }
    }
  } else {
    item(dim("could not query GitHub secrets/variables — check by hand:"));
    for (const name of requirements.secrets) item(dim(`  · ${name} repo/org secret`));
    for (const name of requirements.variables) item(dim(`  · ${name} repository variable`));
  }
  item(dim("  · Claude GitHub App installed on the repo"));
  item(dim("  · default branch protected: PR + 1 human review required"));
  item(dim("  · provider TEST keys (if any) live in the facility-crew Environment"));

  console.log("");
  if (problems === 0) item(`${dim("Everything checkable checks out.")}`);
  else item(`${dim(`${problems} problem${problems === 1 ? "" : "s"} found.`)}`);
  console.log("");
  return problems === 0 ? 0 : 1;
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
  if (flags.url || flags.key) {
    if (!flags.url || !flags.key) return null;
    return { url: stripSlash(flags.url), key: flags.key, profileName: flags.profile || "adhoc" };
  }
  const config = options.config || loadConfig(options.configPath);
  const { name, value } = getProfile(config, flags.profile);
  if (!value?.url || !value?.key) return null;
  return { url: stripSlash(value.url), key: value.key, profileName: name };
}

async function platformDoctor(flags, version, target, options) {
  const stdout = options.stdout || process.stdout;
  const fetchImpl = options.fetch || fetch;
  const write = (line = "") => stdout.write(`${line}\n`);
  if (!flags.json) {
    write("");
    write(`  facility v${version} — deployment readiness doctor`);
    write("");
    write(`Profile: ${target.profileName}`);
    write(`API: ${target.url}`);
    write("");
  }
  try {
    const payload = await requestDoctor(fetchImpl, target);
    if (flags.json) {
      write(JSON.stringify(payload));
      return payload.ok ? 0 : 1;
    }
    write("Readiness");
    for (const check of payload.checks || []) {
      const marker =
        check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
      write(`  [${marker}] ${check.label}`);
      write(`         ${check.message}`);
      if (check.remediation) write(`         Fix: ${check.remediation}`);
    }
    write("");
    write(payload.ok ? "Ready for production traffic." : "Not ready for production traffic.");
    write("");
    return payload.ok ? 0 : 1;
  } catch (error) {
    write(error.message || "facility doctor failed");
    return error.status === 401 ? 2 : 1;
  }
}

async function requestDoctor(fetchImpl, target) {
  const response = await fetchImpl(new URL(`${target.url}/v1/admin/doctor`), {
    method: "GET",
    headers: { authorization: `Bearer ${target.key}` },
  });
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `Facility API returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function stripSlash(value) {
  return String(value).replace(/\/$/, "");
}
