// Stack detection: read the target repo and propose sensible defaults so
// `init` asks six short questions instead of twenty.
//
// Detection is multi-root and multi-ecosystem. A repository may hold several
// independent project roots — nine Poetry packages beside a Next.js app, a PHP
// service beside a Go worker — and a change may touch any subset of them. So
// `init` discovers every root rather than picking the first one it finds, and
// the checks it proposes are the union over those roots.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";

// How far below the repository root a project root may sit. Three levels
// covers the layouts we have seen (`services/api/`, `packages/x/y/`) without
// walking build output that slipped past SKIP_DIRS.
const MAX_ROOT_DEPTH = 3;

const SKIP_DIRS = new Set([
  "node_modules",
  "vendor",
  "venv",
  "dist",
  "build",
  "target",
  "coverage",
  "__pycache__",
  "bin",
  "obj",
  "tmp",
  // Fixtures and samples hold manifests on purpose; proposing their checks as
  // repository defaults would be noise. The adapters still read `tests/` on a
  // root they already claimed — this only stops the walk treating such
  // directories as project roots of their own.
  "test",
  "tests",
  "fixtures",
  "__fixtures__",
  "examples",
  "samples",
  "e2e",
  "testdata",
]);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
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

// --- ecosystem adapters ---------------------------------------------------
// Each adapter answers one question about one directory: is there a project
// root of my kind here, and if so what provisions it, what checks it, and
// where its migrations live. A table, in the same spirit as
// detectDeploymentProvider — adding an ecosystem is one entry, not a branch.

const ADAPTERS = [
  {
    id: "node",
    detect(dir) {
      const pkg = readJson(join(dir, "package.json"));
      if (!pkg) return null;
      const scripts = pkg.scripts ?? {};
      const manager = existsSync(join(dir, "pnpm-lock.yaml"))
        ? "pnpm"
        : existsSync(join(dir, "yarn.lock"))
          ? "yarn"
          : "npm";
      const runner = manager === "npm" ? "npm run" : `${manager} run`;
      const checks = [];
      // `test:run` is the watch-free vitest convention; honored when `test`
      // itself is absent so those repos do not lose their test gate.
      for (const candidates of [["typecheck"], ["lint"], ["test", "test:run"], ["build"]]) {
        const name = candidates.find((candidate) => scripts[candidate]);
        if (name) checks.push(`${runner} ${name}`);
      }
      // The toolchain step already installs Node dependencies, so provisioning
      // here means only the project's own extra setup.
      const install = existsSync(join(dir, "pnpm-lock.yaml"))
        ? "pnpm install --frozen-lockfile"
        : existsSync(join(dir, "yarn.lock"))
          ? "yarn install --immutable"
          : existsSync(join(dir, "package-lock.json"))
            ? "npm ci"
            : "npm install";
      const pnpmWorkspace = readText(join(dir, "pnpm-workspace.yaml"));
      const declared = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
      const workspaceGlobs = pnpmWorkspace ? pnpmWorkspaceGlobs(pnpmWorkspace) : declared;

      return {
        manager,
        install,
        provision: scripts.setup ? `${runner} setup` : "",
        checks,
        workspaceGlobs,
        migrationDirs: ["migrations", "supabase/migrations", "db/migrations", "prisma/migrations"],
      };
    },
  },
  {
    id: "python",
    detect(dir) {
      const pyproject = readText(join(dir, "pyproject.toml"));
      const requirements = existsSync(join(dir, "requirements.txt"));
      if (!pyproject && !requirements) return null;

      let manager = "pip";
      let provision = requirements ? "pip install -r requirements.txt" : "pip install -e .";
      let prefix = "";
      if (pyproject?.includes("[tool.poetry")) {
        manager = "poetry";
        provision = "poetry install";
        prefix = "poetry run ";
      } else if (pyproject?.includes("[tool.uv") || existsSync(join(dir, "uv.lock"))) {
        manager = "uv";
        provision = "uv sync";
        prefix = "uv run ";
      } else if (pyproject?.includes("[tool.pdm")) {
        manager = "pdm";
        provision = "pdm install";
        prefix = "pdm run ";
      } else if (pyproject?.includes("[tool.hatch")) {
        manager = "hatch";
        provision = "hatch env create";
        prefix = "hatch run ";
      }

      // Only propose a tool the project actually configures — the same rule the
      // Node adapter follows by reading `scripts`.
      const checks = [];
      if (pyproject?.includes("[tool.ruff")) checks.push(`${prefix}ruff check .`);
      if (pyproject?.includes("[tool.mypy") || existsSync(join(dir, "mypy.ini"))) {
        checks.push(`${prefix}mypy .`);
      }
      const hasTests =
        pyproject?.includes("[tool.pytest") ||
        existsSync(join(dir, "pytest.ini")) ||
        existsSync(join(dir, "tests")) ||
        existsSync(join(dir, "test"));
      if (hasTests) checks.push(`${prefix}pytest`);

      return { manager, provision, checks, migrationDirs: ["alembic/versions", "migrations"] };
    },
  },
  {
    id: "php",
    detect(dir) {
      const composer = readJson(join(dir, "composer.json"));
      if (!composer) return null;
      const scripts = composer.scripts ?? {};
      const checks = [];
      if (scripts.lint) checks.push("composer run lint");
      if (scripts.test) checks.push("composer run test");
      else if (existsSync(join(dir, "tests/Pest.php"))) checks.push("vendor/bin/pest");
      else if (
        existsSync(join(dir, "phpunit.xml")) ||
        existsSync(join(dir, "phpunit.xml.dist")) ||
        existsSync(join(dir, "tests"))
      ) {
        checks.push("vendor/bin/phpunit");
      }
      return {
        manager: "composer",
        provision: "composer install --no-interaction --prefer-dist",
        checks,
        migrationDirs: ["database/migrations", "migrations"],
      };
    },
  },
  {
    id: "go",
    detect(dir) {
      if (!existsSync(join(dir, "go.mod"))) return null;
      return {
        manager: "go",
        provision: "go mod download",
        checks: ["go build ./...", "go vet ./...", "go test ./..."],
        migrationDirs: ["migrations", "db/migrations"],
      };
    },
  },
  {
    id: "ruby",
    detect(dir) {
      if (!existsSync(join(dir, "Gemfile"))) return null;
      const checks = [];
      if (existsSync(join(dir, ".rubocop.yml"))) checks.push("bundle exec rubocop");
      if (existsSync(join(dir, "spec"))) checks.push("bundle exec rspec");
      else if (existsSync(join(dir, "test"))) checks.push("bundle exec rake test");
      return {
        manager: "bundler",
        provision: "bundle install",
        checks,
        migrationDirs: ["db/migrate"],
      };
    },
  },
  {
    id: "rust",
    detect(dir) {
      const cargo = readText(join(dir, "Cargo.toml"));
      if (cargo === null) return null;
      return {
        manager: "cargo",
        provision: "cargo fetch",
        checks: ["cargo build --locked", "cargo test --locked"],
        workspaceGlobs: cargoWorkspaceGlobs(cargo),
        migrationDirs: ["migrations"],
      };
    },
  },
  {
    id: "java",
    detect(dir) {
      const maven = existsSync(join(dir, "pom.xml"));
      const gradle = existsSync(join(dir, "build.gradle")) || existsSync(join(dir, "build.gradle.kts"));
      if (!maven && !gradle) return null;
      if (maven) {
        return { manager: "maven", provision: "mvn -B -DskipTests install", checks: ["mvn -B verify"], migrationDirs: ["src/main/resources/db/migration"] };
      }
      const wrapper = existsSync(join(dir, "gradlew"));
      const cmd = wrapper ? "./gradlew" : "gradle";
      return {
        manager: "gradle",
        provision: `${cmd} --no-daemon dependencies`,
        checks: [`${cmd} --no-daemon build`],
        migrationDirs: ["src/main/resources/db/migration"],
      };
    },
  },
];

// --- workspace absorption -------------------------------------------------
// A workspace member is not an independent root: the workspace root's own
// scripts already fan out to it. Listing members separately would provision and
// check the same package twice. Only roots that no parent workspace claims —
// the nine Poetry packages in a polyglot repo, a Go worker beside a PHP app —
// stand on their own.

function pnpmWorkspaceGlobs(text) {
  const globs = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s+-\s*['"]?([^'"#\s]+)['"]?\s*$/);
    if (item) {
      globs.push(item[1]);
      continue;
    }
    break; // next top-level key ends the list
  }
  return globs;
}

function cargoWorkspaceGlobs(text) {
  const section = text.match(/\[workspace\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) return [];
  const members = section[1].match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!members) return [];
  return [...members[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
}

// Workspace globs are the small subset npm/pnpm/cargo actually use: a literal
// path, `dir/*`, or `dir/**`.
function globToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]+")
    .replace(/ /g, ".+");
  return new RegExp(`^${escaped}$`);
}

function absorbWorkspaceMembers(roots) {
  const workspaces = roots.filter((r) => r.workspaceGlobs?.length);
  if (!workspaces.length) return roots;
  return roots.filter((root) => {
    for (const parent of workspaces) {
      if (parent === root || parent.ecosystem !== root.ecosystem) continue;
      const prefix = parent.path === "." ? "" : `${parent.path}/`;
      if (!root.path.startsWith(prefix) || root.path === parent.path) continue;
      const inner = root.path.slice(prefix.length);
      // A root nested below a member (`runner/agent-clis` under the `runner`
      // member) belongs to that member, so every ancestor path is tested.
      const segments = inner.split("/");
      for (let i = 1; i <= segments.length; i++) {
        const ancestor = segments.slice(0, i).join("/");
        if (parent.workspaceGlobs.some((glob) => globToRegExp(glob).test(ancestor))) return false;
      }
    }
    return true;
  });
}

// Walk the tree and collect every project root. A single directory can hold
// roots of more than one ecosystem (a PHP service that also builds assets), and
// both are kept — dropping one is how `init` ends up provisioning half a repo.
function detectRoots(dir) {
  const found = [];
  walk(dir, 0);
  const roots = absorbWorkspaceMembers(found);
  // Shallow roots first, then alphabetical: a stable order so generated
  // manifests do not churn between runs.
  roots.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  return roots;

  function walk(current, depth) {
    const rel = relative(dir, current).split(sep).join("/") || ".";
    for (const adapter of ADAPTERS) {
      const hit = adapter.detect(current);
      if (hit) found.push({ path: rel, ecosystem: adapter.id, ...hit });
    }
    if (depth >= MAX_ROOT_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      walk(join(current, entry.name), depth + 1);
    }
  }
}

// A command for a root below the repository root has to run there. Roots at
// "." are emitted verbatim, so single-root repositories are unchanged.
// Discovered directory names come from repository contents and may legally
// contain shell metacharacters, so the path is always single-quoted (with
// embedded quotes escaped) before it reaches a shell command.
function shellQuote(value) {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function scopeCommand(rootPath, command) {
  return rootPath === "." ? command : `(cd ${shellQuote(rootPath)} && ${command})`;
}

export function detect(dir) {
  const roots = detectRoots(dir);

  // `packageManager` still describes the repository-root Node toolchain, which
  // is what the CI setup step needs. `ecosystems` and `roots` carry the rest.
  const rootNode = roots.find((r) => r.path === "." && r.ecosystem === "node");
  const packageManager = rootNode ? rootNode.manager : "none";
  const ecosystems = [...new Set(roots.map((r) => r.ecosystem))].sort();

  const checks = [];
  const provisions = [];
  for (const root of roots) {
    for (const check of root.checks) {
      const scoped = scopeCommand(root.path, check);
      if (!checks.includes(scoped)) checks.push(scoped);
    }
    const provisionParts = [];
    if (root.ecosystem === "node" && root.path !== "." && root.install) {
      // A nested Node root is outside the CI toolchain steps' install, so its
      // checks would otherwise run against an empty node_modules.
      provisionParts.push(root.install);
    }
    if (root.provision) provisionParts.push(root.provision);
    for (const part of provisionParts) {
      const scoped = scopeCommand(root.path, part);
      if (!provisions.includes(scoped)) provisions.push(scoped);
    }
  }
  const provision = provisions.join(" && ");

  const migrationDirs = [];
  for (const root of roots) {
    for (const candidate of root.migrationDirs ?? []) {
      const rel = root.path === "." ? candidate : `${root.path}/${candidate}`;
      if (existsSync(join(dir, rel)) && !migrationDirs.includes(rel)) migrationDirs.push(rel);
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
    ecosystems,
    roots: roots.map((r) => ({ path: r.path, ecosystem: r.ecosystem, manager: r.manager })),
    checks,
    provision,
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
