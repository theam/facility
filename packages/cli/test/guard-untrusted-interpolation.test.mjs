import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import guard from "../templates/guards/workflow-untrusted-interpolation.mjs";

/** Run the guard against a workflow file in a throwaway repository. */
function runOn(workflow) {
  const root = mkdtempSync(join(tmpdir(), "facility-guard-"));
  mkdirSync(join(root, ".github/workflows"), { recursive: true });
  writeFileSync(join(root, ".github/workflows/test.yml"), workflow);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return guard.run();
  } finally {
    process.chdir(cwd);
  }
}

test("flags attacker-controlled text interpolated into a single-line run script", () => {
  const violations = runOn(`jobs:
  a:
    steps:
      - run: echo "\${{ github.event.issue.title }}"
`);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 4);
  assert.match(violations[0].message, /attacker-controlled/);
});

test("flags interpolation inside literal and folded block scalars", () => {
  const violations = runOn(`jobs:
  a:
    steps:
      - run: |
          curl -d "\${{ github.event.comment.body }}" https://example.test
      - run: >
          echo \${{ github.event.head_commit.message }}
`);
  assert.deepEqual(
    violations.map((violation) => violation.line),
    [5, 7],
  );
});

test("allows env bindings, action inputs and job conditions", () => {
  const violations = runOn(`jobs:
  a:
    if: contains(github.event.comment.body, '/builder')
    steps:
      - uses: actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5
        with:
          ref: \${{ github.event.pull_request.head.ref }}
      - env:
          TITLE: \${{ github.event.pull_request.title }}
        run: node scripts/check.mjs "$TITLE"
`);
  assert.deepEqual(violations, []);
});

test("allows trusted contexts inside a run script", () => {
  const violations = runOn(`jobs:
  a:
    steps:
      - run: echo "\${{ github.sha }} \${{ github.repository }} \${{ runner.os }}"
`);
  assert.deepEqual(violations, []);
});

test("stops treating lines as script once the block scalar is dedented", () => {
  const violations = runOn(`jobs:
  a:
    steps:
      - run: |
          echo hello
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: \${{ github.event.pull_request.title }}
`);
  assert.deepEqual(violations, []);
});
