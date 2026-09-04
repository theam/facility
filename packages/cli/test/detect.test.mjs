import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { detect } = await import(pathToFileURL(join(pkgRoot, "src", "detect.mjs")));

function makeRepo() {
  return mkdtempSync(join(tmpdir(), "facility-detect-"));
}

function write(dir, path, content) {
  mkdirSync(join(dir, dirname(path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function pkgJson(scripts = {}) {
  return JSON.stringify({ name: "x", private: true, scripts }, null, 2) + "\n";
}

test("single-root npm repo detects exactly as before", () => {
  const dir = makeRepo();
  try {
    write(dir, "package.json", pkgJson({ lint: "eslint .", test: "vitest run", setup: "docker compose up -d" }));
    write(dir, "package-lock.json", "{}\n");
    const d = detect(dir);
    assert.equal(d.packageManager, "npm");
    assert.deepEqual(d.checks, ["npm run lint", "npm run test"]);
    assert.equal(d.provision, "npm run setup");
    assert.deepEqual(d.ecosystems, ["node"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pnpm workspace members are absorbed by the root, nested packages included", () => {
  const dir = makeRepo();
  try {
    write(dir, "package.json", pkgJson({ test: "pnpm -r test", build: "pnpm -r build" }));
    write(dir, "pnpm-lock.yaml", "lockfileVersion: 9\n");
    write(dir, "pnpm-workspace.yaml", "packages:\n  - packages/*\n  - runner\n");
    write(dir, "packages/api/package.json", pkgJson({ test: "vitest run" }));
    write(dir, "packages/web/package.json", pkgJson({ build: "next build" }));
    write(dir, "runner/package.json", pkgJson({ test: "vitest run" }));
    // Nested below a member: belongs to that member, never a root of its own.
    write(dir, "runner/agent-clis/package.json", pkgJson({ build: "tsc" }));
    const d = detect(dir);
    assert.equal(d.packageManager, "pnpm");
    assert.deepEqual(
      d.roots.map((r) => r.path),
      ["."],
      "workspace members and their nested packages must not surface as roots",
    );
    assert.deepEqual(d.checks, ["pnpm run test", "pnpm run build"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("polyglot monorepo without a root package.json finds every ecosystem", () => {
  // The layout reported on issue #199: independent Poetry packages beside a
  // Next.js frontend, nothing at the repository root.
  const dir = makeRepo();
  try {
    const poetry = [
      "[tool.poetry]",
      'name = "svc"',
      "[tool.ruff]",
      'line-length = 100',
      "",
    ].join("\n");
    for (const svc of ["scraper", "scheduler", "backend", "mails"]) {
      write(dir, `${svc}/pyproject.toml`, poetry);
      write(dir, `${svc}/tests/test_smoke.py`, "def test_ok():\n    assert True\n");
    }
    write(dir, "frontend/package.json", pkgJson({ lint: "next lint", "test:run": "vitest run" }));
    write(dir, "frontend/package-lock.json", "{}\n");

    const d = detect(dir);
    assert.equal(d.packageManager, "none", "no repository-root Node toolchain");
    assert.deepEqual(d.ecosystems, ["node", "python"]);
    assert.deepEqual(
      d.roots.map((r) => `${r.path}:${r.ecosystem}`).sort(),
      ["backend:python", "frontend:node", "mails:python", "scheduler:python", "scraper:python"],
    );
    // Checks are scoped per root and unioned — a change anywhere has a gate.
    assert.ok(d.checks.includes("(cd 'scraper' && poetry run pytest)"));
    assert.ok(d.checks.includes("(cd 'scraper' && poetry run ruff check .)"));
    assert.ok(d.checks.includes("(cd 'frontend' && npm run lint)"));
    assert.ok(d.checks.includes("(cd 'frontend' && npm run test:run)"), "test:run honored when test is absent");
    // Provisioning is per root, not one repo-wide install.
    assert.ok(d.provision.includes("(cd 'scraper' && poetry install)"));
    assert.ok(d.provision.includes("(cd 'backend' && poetry install)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("php and go roots detect their toolchains", () => {
  const dir = makeRepo();
  try {
    write(dir, "composer.json", JSON.stringify({ name: "acme/app", scripts: { test: "phpunit" } }) + "\n");
    mkdirSync(join(dir, "database/migrations"), { recursive: true });
    write(dir, "worker/go.mod", "module acme/worker\n\ngo 1.22\n");
    const d = detect(dir);
    assert.deepEqual(d.ecosystems, ["go", "php"]);
    assert.ok(d.checks.includes("composer run test"));
    assert.ok(d.checks.includes("(cd 'worker' && go test ./...)"));
    assert.ok(d.provision.includes("composer install --no-interaction --prefer-dist"));
    assert.ok(d.provision.includes("(cd 'worker' && go mod download)"));
    assert.deepEqual(d.suggestedModules, ["database"], "php migrations dir still suggests the database module");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discovered directory names are shell-quoted in scoped commands", () => {
  // Directory names come from repository contents; a hostile name must never
  // reach the shell unquoted (reviewer-reproduced command substitution).
  const dir = makeRepo();
  try {
    const evil = "evil$(echo pwned)";
    write(dir, `${evil}/package.json`, pkgJson({ test: "vitest run" }));
    write(dir, `${evil}/package-lock.json`, "{}\n");
    write(dir, "don't/composer.json", JSON.stringify({ name: "a/b", scripts: { test: "phpunit" } }) + "\n");
    const d = detect(dir);
    assert.ok(
      d.checks.includes("(cd 'evil$(echo pwned)' && npm run test)"),
      `metacharacters stay inert inside single quotes: ${JSON.stringify(d.checks)}`,
    );
    assert.ok(
      d.checks.includes("(cd 'don'\\''t' && composer run test)"),
      `embedded quotes are escaped: ${JSON.stringify(d.checks)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a repository whose only Node root is nested still installs its dependencies", () => {
  // frontend/package.json with nothing at the root: packageManager is "none",
  // but the frontend checks must not run against an empty node_modules.
  const dir = makeRepo();
  try {
    write(dir, "frontend/package.json", pkgJson({ test: "vitest run" }));
    write(dir, "frontend/package-lock.json", "{}\n");
    const d = detect(dir);
    assert.equal(d.packageManager, "none");
    assert.ok(
      d.provision.includes("(cd 'frontend' && npm ci)"),
      `nested Node root installs before its checks: ${JSON.stringify(d.provision)}`,
    );
    assert.ok(d.checks.includes("(cd 'frontend' && npm run test)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fixture and sample directories never become project roots", () => {
  const dir = makeRepo();
  try {
    write(dir, "package.json", pkgJson({ test: "vitest run" }));
    write(dir, "package-lock.json", "{}\n");
    write(dir, "samples/php/composer.json", JSON.stringify({ name: "sample/php" }) + "\n");
    write(dir, "test/fixtures/app/package.json", pkgJson({ test: "echo fixture" }));
    const d = detect(dir);
    assert.deepEqual(d.ecosystems, ["node"]);
    assert.deepEqual(d.roots.map((r) => r.path), ["."]);
    assert.deepEqual(d.checks, ["npm run test"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
