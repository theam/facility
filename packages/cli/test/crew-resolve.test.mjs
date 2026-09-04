import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(pkgRoot, "bin", "facility.mjs");

// Both agent triggers decide authorization and command shape as ordered
// statements in one shell script, and a text assertion cannot see their order.
// These tests render the real workflows through the installer, lift those steps
// out, and execute them the way Actions does — bash, the event payload on disk,
// GITHUB_OUTPUT on disk — so a sender without write access reaching a hard
// failure is caught here.

const TRIGGERS = [
  { name: "crew", file: "facility-crew.yml", step: "requested-agent", architect: "/architect", builder: "/builder" },
  { name: "codex", file: "facility-codex.yml", step: "resolve", architect: "/codex-architect", builder: "/codex-builder" },
];

// The shipped resolve script uses `mapfile`, a bash 4 builtin. Runners provide
// bash 5; macOS still ships 3.2 as /bin/bash, where the script cannot run at
// all. Skip rather than report a false failure about the workflow.
const bashMajor = Number(
  spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout?.trim(),
);
const needsBash4 = { skip: bashMajor >= 4 ? false : `requires bash >= 4 (found ${bashMajor || "none"})` };

let rendered;
function renderWorkflows() {
  if (rendered) return rendered;
  const dir = mkdtempSync(join(tmpdir(), "facility-trigger-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      { name: "demo-app", private: true, scripts: { test: "vitest run", setup: "npm ci" } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(dir, "package-lock.json"), "{}\n");
  const result = spawnSync(
    process.execPath,
    [cli, "init", "--yes", `--dir=${dir}`, "--provision=npm run setup", "--checks=npm test"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  rendered = dir;
  return dir;
}

// Read the step's `run:` block out of the rendered YAML instead of
// re-implementing it, so the test tracks whatever the installer actually ships.
function resolveScript({ file, step }) {
  const yaml = readFileSync(join(renderWorkflows(), ".github/workflows", file), "utf8");
  const lines = yaml.split("\n");
  const stepIndex = lines.findIndex((line) => line.trim() === `id: ${step}`);
  assert.ok(stepIndex > 0, `${file} must define the ${step} step`);
  const runIndex = lines.findIndex((line, i) => i > stepIndex && line.trim() === "run: |");
  assert.ok(runIndex > 0, `${file} ${step} must carry an inline run block`);
  const indent = lines[runIndex + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(runIndex + 1)) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  const script = body.join("\n");
  assert.match(script, /GITHUB_EVENT_PATH/, `${file} ${step} must read the event payload`);
  return script;
}

function runResolve(script, { body, sender, permission }) {
  const dir = mkdtempSync(join(tmpdir(), "facility-resolve-"));
  const binDir = join(dir, "bin");
  const eventPath = join(dir, "event.json");
  const outputPath = join(dir, "output.txt");
  mkdirSync(binDir);
  // The gate shells out to `gh api …/collaborators/<sender>/permission`.
  // Stub it so the test fixes the sender's access without a network call.
  writeFileSync(join(binDir, "gh"), `#!/bin/sh\necho ${permission}\n`);
  chmodSync(join(binDir, "gh"), 0o755);
  writeFileSync(join(dir, "resolve.sh"), script);
  writeFileSync(
    eventPath,
    JSON.stringify({
      action: "created",
      sender: { login: sender, type: "User" },
      issue: { number: 7, title: "Something", body: "" },
      comment: { body },
    }),
  );
  writeFileSync(outputPath, "");

  const result = spawnSync("bash", [join(dir, "resolve.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_EVENT_NAME: "issue_comment",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_REPOSITORY: "acme/demo-app",
      GITHUB_SHA: "0".repeat(40),
      GH_TOKEN: "test-token",
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(outputPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs };
}

for (const trigger of TRIGGERS) {
  test(`${trigger.name}: a write-access sender dispatches a line-anchored command`, needsBash4, () => {
    const run = runResolve(resolveScript(trigger), {
      body: trigger.architect,
      sender: "maintainer",
      permission: "write",
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    assert.equal(run.outputs.run, "true");
    assert.equal(run.outputs.mode, "architect");
  });

  test(`${trigger.name}: prose naming a command is skipped, not failed`, needsBash4, () => {
    // The job prefilter matches the command anywhere in the body, so a comment
    // that merely discusses it still reaches this step. Documenting the agents
    // in an issue must not turn the repository's checks red.
    const run = runResolve(resolveScript(trigger), {
      body: `ask ${trigger.architect} about it before you start`,
      sender: "maintainer",
      permission: "write",
    });
    assert.equal(run.status, 0, `prose must not fail the run: ${run.stdout}${run.stderr}`);
    assert.equal(run.outputs.run, "false");
    assert.equal(run.outputs.mode, undefined);
  });

  test(`${trigger.name}: a sender without write access never fails the run`, needsBash4, () => {
    // Anyone can comment on a public repository. No comment body from a sender
    // without write access may dispatch an agent or produce a red run.
    const bodies = [
      trigger.architect,
      `ask ${trigger.architect} about it`,
      `${trigger.builder}\n${trigger.architect}`,
    ];
    for (const body of bodies) {
      const run = runResolve(resolveScript(trigger), { body, sender: "outsider", permission: "none" });
      assert.equal(run.status, 0, `unauthorized ${JSON.stringify(body)} must not fail the run`);
      assert.equal(run.outputs.run, "false", `unauthorized ${JSON.stringify(body)} dispatched`);
    }
  });

  test(`${trigger.name}: an authorized sender asking for both agents is a hard error`, needsBash4, () => {
    const run = runResolve(resolveScript(trigger), {
      body: `${trigger.builder}\n${trigger.architect}`,
      sender: "maintainer",
      permission: "write",
    });
    assert.equal(run.status, 1, "an ambiguous request from a collaborator must fail loudly");
    assert.equal(run.outputs.run, undefined);
  });
}
