// Stack detection: read the target repo and propose sensible defaults so
// `init` asks six short questions instead of twenty.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// A non-Node repo used to start on the "empty job site" the method warns
// against: detection only knew package.json, so a Python project got an empty
// check list and a "add your language setup steps" stub. Detect the next
// biggest ecosystem too, so the crew gets a real toolchain to build and verify
// against. Zero runtime dependencies — no TOML parser, just presence checks and
// narrow text probes; `init` still asks the operator to confirm every default.
function detectPython(dir) {
  const has = (file) => existsSync(join(dir, file));
  const pyproject = has("pyproject.toml") ? readFileSync(join(dir, "pyproject.toml"), "utf8") : "";
  const isPython =
    has("pyproject.toml") || has("requirements.txt") || has("setup.py") || has("setup.cfg") || has("Pipfile") || has("Pipfile.lock");
  if (!isPython) return null;

  // Tool selection drives both the install command and how checks are invoked
  // (poetry/pipenv run inside their managed environment; pip runs in place).
  let packageManager;
  let prefix;
  let install;
  if (has("poetry.lock") || /\[tool\.poetry/.test(pyproject)) {
    packageManager = "poetry";
    prefix = "poetry run ";
    install = "poetry install";
  } else if (has("Pipfile") || has("Pipfile.lock")) {
    packageManager = "pipenv";
    prefix = "pipenv run ";
    install = "pipenv install --dev";
  } else {
    packageManager = "pip";
    prefix = "";
    install = has("requirements.txt") ? "pip install -r requirements.txt" : "pip install -e .";
  }

  // Only propose a check we have configuration evidence for — a dependency
  // being present is not proof the team runs it.
  const checks = [];
  if (/\[tool\.ruff/.test(pyproject) || has("ruff.toml") || has(".ruff.toml")) checks.push(`${prefix}ruff check .`);
  if (/\[tool\.black\]/.test(pyproject)) checks.push(`${prefix}black --check .`);
  if (/\[tool\.mypy\]/.test(pyproject) || has("mypy.ini") || has(".mypy.ini")) checks.push(`${prefix}mypy .`);
  if (
    /\[tool\.pytest/.test(pyproject) ||
    has("pytest.ini") ||
    has("tox.ini") ||
    has("conftest.py") ||
    existsSync(join(dir, "tests")) ||
    existsSync(join(dir, "test"))
  ) {
    checks.push(`${prefix}pytest`);
  }

  let pythonVersion = "3.x";
  if (has(".python-version")) {
    const pinned = readFileSync(join(dir, ".python-version"), "utf8").trim().split("\n")[0].trim();
    if (pinned) pythonVersion = pinned;
  }

  // Dependency install runs in the toolchain step, mirroring `npm ci`;
  // `provision` stays for DB/seeds/browsers, which cannot be inferred here.
  return { packageManager, checks, provision: "", install, pythonVersion };
}

export function detect(dir) {
  const pkg = readJson(join(dir, "package.json"));
  const scripts = pkg?.scripts ?? {};

  const nodePackageManager = existsSync(join(dir, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(join(dir, "yarn.lock"))
      ? "yarn"
      : existsSync(join(dir, "package-lock.json"))
        ? "npm"
        : pkg
          ? "npm"
          : null;

  // Node is detected first: a repo carrying package.json is a Node repo even if
  // it also ships a helper script in another language. Only when there is no
  // Node manifest do we probe the other ecosystems.
  let packageManager;
  let checks = [];
  let provision = "";
  let install;
  let pythonVersion;
  if (nodePackageManager) {
    packageManager = nodePackageManager;
    const runner = nodePackageManager === "npm" ? "npm run" : `${nodePackageManager} run`;
    for (const name of ["typecheck", "lint", "test", "build"]) {
      if (scripts[name]) checks.push(`${runner} ${name}`);
    }
    provision = scripts["setup"] ? `${runner} setup` : "";
  } else {
    const python = detectPython(dir);
    if (python) {
      ({ packageManager, checks, provision, install, pythonVersion } = python);
    } else {
      packageManager = "none";
    }
  }

  const isGitRepo = git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true";
  let defaultBranch = "main";
  const originHead = git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (originHead) defaultBranch = originHead.replace("refs/remotes/origin/", "");
  else {
    const current = git(dir, ["branch", "--show-current"]);
    if (current) defaultBranch = current;
  }

  let org = "";
  const remote = git(dir, ["remote", "get-url", "origin"]);
  const remoteMatch = remote.match(/[/:]([^/:]+)\/([^/]+?)(\.git)?$/);
  if (remoteMatch) org = remoteMatch[1];

  const migrationDirs = [
    "migrations",
    "supabase/migrations",
    "db/migrations",
    "prisma/migrations",
    "alembic/versions",
    "migrations/versions",
  ].filter((d) => existsSync(join(dir, d)));

  // Existing check workflows (by their `name:`), so the doctor knows what to
  // watch. Facility's own workflows are excluded — the watchtower covers them.
  const workflowNames = [];
  const deploymentProviders = new Set();
  try {
    for (const file of readdirSync(join(dir, ".github/workflows"))) {
      if (!/\.ya?ml$/.test(file) || file.startsWith("facility-")) continue;
      const workflow = readFileSync(join(dir, ".github/workflows", file), "utf8");
      const nameMatch = workflow.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
      if (nameMatch) workflowNames.push(nameMatch[1].trim());
      detectDeploymentProvider(workflow, deploymentProviders);
    }
  } catch {}
  if (existsSync(join(dir, "vercel.json"))) deploymentProviders.add("vercel");
  if (existsSync(join(dir, "netlify.toml"))) deploymentProviders.add("netlify");
  if (existsSync(join(dir, "fly.toml"))) deploymentProviders.add("fly.io");
  if (existsSync(join(dir, "render.yaml"))) deploymentProviders.add("render");
  if (existsSync(join(dir, "Dockerfile"))) deploymentProviders.add("container-image");
  const board = detectBoard(dir, org);
  const facility = readJson(join(dir, ".facility.json"));

  return {
    isGitRepo,
    defaultBranch,
    packageManager,
    checks,
    provision,
    install,
    pythonVersion,
    org,
    workflowNames,
    deploymentProviders: [...deploymentProviders].sort(),
    board,
    previewConfigured: facility?.preview?.enabled === true,
    suggestedModules: migrationDirs.length ? ["database"] : [],
    existing: {
      agentsMd: existsSync(join(dir, "AGENTS.md")),
      claudeMd: existsSync(join(dir, "CLAUDE.md")),
      claudeSettings: existsSync(join(dir, ".claude/settings.json")),
      standard: existsSync(join(dir, "STANDARD.md")),
    },
  };
}

function detectDeploymentProvider(content, providers) {
  const lower = content.toLowerCase();
  if (lower.includes("vercel")) providers.add("vercel");
  if (lower.includes("netlify")) providers.add("netlify");
  if (lower.includes("flyctl") || lower.includes("fly.io")) providers.add("fly.io");
  if (lower.includes("cloudflare") || lower.includes("wrangler")) providers.add("cloudflare");
  if (lower.includes("amazon-ecr") || lower.includes("amazon-ecs")) providers.add("aws");
  if (lower.includes("render.com")) providers.add("render");
}

function detectBoard(dir, fallbackOrg) {
  for (const path of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
    try {
      const match = readFileSync(join(dir, path), "utf8").match(
        /github\.com\/orgs\/([^/\s]+)\/projects\/(\d+)/i,
      );
      if (match?.[2]) return { org: match[1] || fallbackOrg, project: Number(match[2]) };
    } catch {}
  }
  return null;
}
