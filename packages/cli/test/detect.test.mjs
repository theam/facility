import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detect } from "../src/detect.mjs";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");

function makeRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), "facility-detect-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

test("detect: a Poetry project installs with Poetry and runs checks inside it", () => {
  const dir = makeRepo({
    "pyproject.toml": '[tool.poetry]\nname = "demo"\n\n[tool.ruff]\n\n[tool.mypy]\n\n[tool.pytest.ini_options]\n',
    "poetry.lock": "",
    "tests/test_x.py": "def test_x():\n    assert True\n",
  });
  const d = detect(dir);
  assert.equal(d.packageManager, "poetry");
  assert.equal(d.install, "poetry install");
  assert.equal(d.provision, "");
  assert.deepEqual(d.checks, ["poetry run ruff check .", "poetry run mypy .", "poetry run pytest"]);
});

test("detect: a pip + requirements project proposes pip install -r and bare checks", () => {
  const dir = makeRepo({
    // ruff is only a listed dependency, not configured — it must not become a check.
    "requirements.txt": "pytest\nruff\n",
    "tests/test_y.py": "def test_y():\n    assert True\n",
  });
  const d = detect(dir);
  assert.equal(d.packageManager, "pip");
  assert.equal(d.install, "pip install -r requirements.txt");
  assert.deepEqual(d.checks, ["pytest"]);
});

test("detect: a pip project without requirements installs the package itself", () => {
  const dir = makeRepo({ "pyproject.toml": '[project]\nname = "demo"\n[tool.ruff]\n' });
  const d = detect(dir);
  assert.equal(d.packageManager, "pip");
  assert.equal(d.install, "pip install -e .");
  assert.deepEqual(d.checks, ["ruff check ."]);
});

test("detect: Node detection is unchanged by Python support", () => {
  const dir = makeRepo({
    "package.json": JSON.stringify({ name: "n", scripts: { lint: "eslint .", test: "vitest run", setup: "docker compose up -d" } }),
    "package-lock.json": "{}",
    // A stray Python file must not flip a Node repo to pip.
    "requirements.txt": "pytest\n",
  });
  const d = detect(dir);
  assert.equal(d.packageManager, "npm");
  assert.deepEqual(d.checks, ["npm run lint", "npm run test"]);
  assert.equal(d.provision, "npm run setup");
  assert.equal(d.install, undefined);
});

test("init renders a pinned Python toolchain for a Python repo", () => {
  const dir = makeRepo({
    "requirements.txt": "pytest\n",
    ".python-version": "3.12\n",
    "tests/test_z.py": "def test_z():\n    assert True\n",
  });
  const res = spawnSync(process.execPath, [cli, "init", "--yes", `--dir=${dir}`], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const crew = readFileSync(join(dir, ".github/workflows/facility-crew.yml"), "utf8");
  assert.ok(
    crew.includes("uses: actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065 # v5"),
    "setup-python must be pinned to a full commit SHA",
  );
  // Quoted so YAML does not misread 3.12 as a float.
  assert.ok(crew.includes('python-version: "3.12"'), "python version must be quoted and taken from .python-version");
  assert.ok(crew.includes("pip install -r requirements.txt"), "the dependency install must be rendered");
  assert.ok(crew.includes("pytest"), "the detected check must be rendered");
  assert.ok(!/no toolchain detected/.test(crew), "the empty-job-site stub must not appear for a detected stack");
});
