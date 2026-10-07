import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");

const projectManifest = `version: 1
repositories:
  primary: github.com/acme/demo-app
  related: []
environment:
  start: "npm run dev"
  services:
    app:
      port: 3000
`;

function agent(name, triggers) {
  return `---
name: ${name}
description: ${name} agent.
engine: claude_code
model: claude-opus-5-5
triggers:
${triggers.map((type) => `  - type: ${type}`).join("\n")}
---

# ${name}

Do the ${name} step.
`;
}

function makeRepo(t, agents) {
  const dir = mkdtempSync(join(tmpdir(), "facility-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, ".facility.yml"), projectManifest);
  mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
  for (const [file, source] of Object.entries(agents)) {
    writeFileSync(join(dir, ".agents", file), source);
  }
  return dir;
}

function doctor(dir) {
  const result = spawnSync(process.execPath, [cli, "doctor", `--dir=${dir}`, "--json"], {
    cwd: dir,
    encoding: "utf8",
  });
  return { status: result.status, payload: JSON.parse(result.stdout) };
}

function check(payload, label) {
  return payload.checks.find((candidate) => candidate.label === label);
}

test("doctor validates a custom catalog without the starter crew", (t) => {
  const dir = makeRepo(t, {
    "sdd-specify.md": agent("sdd-specify", ["manual", "mcp", "ui"]),
    "sdd-plan.md": agent("sdd-plan", ["mcp"]),
    "nightly-triage.md": agent("nightly-triage", ["ui"]),
  });

  const { status, payload } = doctor(dir);

  assert.equal(status, 0, JSON.stringify(payload));
  assert.equal(payload.ok, true);
  assert.deepEqual(
    payload.checks.map((candidate) => candidate.label),
    ["start command", ".agents/nightly-triage.md", ".agents/sdd-plan.md", ".agents/sdd-specify.md"],
  );
});

test("doctor accepts every trigger type the server accepts", (t) => {
  const dir = makeRepo(t, {
    "manual-only.md": agent("manual-only", ["manual"]),
    "mcp-only.md": agent("mcp-only", ["mcp"]),
    "ui-only.md": agent("ui-only", ["ui"]),
  });

  const { status, payload } = doctor(dir);

  assert.equal(status, 0, JSON.stringify(payload));
});

test("doctor reports an empty catalog", (t) => {
  const dir = makeRepo(t, {});

  const { status, payload } = doctor(dir);

  assert.equal(status, 1);
  assert.match(check(payload, ".agents/").detail, /no agent manifests/);
});

test("doctor requires the manifest name to match its filename", (t) => {
  const dir = makeRepo(t, { "planner.md": agent("sdd-plan", ["manual"]) });

  const { status, payload } = doctor(dir);

  assert.equal(status, 1);
  assert.match(check(payload, ".agents/planner.md").detail, /name must be planner/);
});

test("doctor rejects filenames the server cannot load as agent names", (t) => {
  const dir = makeRepo(t, { "Planner.md": agent("Planner", ["manual"]) });

  const { status, payload } = doctor(dir);

  assert.equal(status, 1);
  assert.match(check(payload, ".agents/Planner.md").detail, /lowercase kebab-case/);
});

test("doctor still rejects unsupported triggers", (t) => {
  const dir = makeRepo(t, { "hook.md": agent("hook", ["webhook"]) });

  const { status, payload } = doctor(dir);

  assert.equal(status, 1);
  assert.match(check(payload, ".agents/hook.md").detail, /supported trigger/);
});
