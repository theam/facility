import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const docsRoot = resolve(repoRoot, "apps/docs/docs");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

test("the published navigation covers user, operator, reference, and contributor paths", () => {
  const sidebar = read("apps/docs/sidebars.ts");
  const requiredPages = [
    "concepts/method",
    "concepts/the-loop",
    "concepts/stories-and-workspaces",
    "concepts/agents-as-code",
    "guides/kickstart",
    "guides/existing-repo",
    "guides/operate-story",
    "guides/validate-workspace-loop",
    "guides/troubleshooting",
    "reference/architecture",
    "reference/project-manifest",
    "reference/agent-manifest",
    "reference/lifecycle",
    "reference/api",
    "reference/mcp",
    "reference/security",
    "reference/hardening",
    "contributors/architecture",
    "contributors/testing",
    "contributors/documentation",
  ];

  for (const page of requiredPages) {
    assert.match(sidebar, new RegExp(`"${page.replaceAll("/", "\\/")}"`));
    assert.equal(existsSync(resolve(docsRoot, `${page}.md`)), true, `${page}.md must exist`);
  }
});

test("the product identity describes a reviewable AI SDLC", () => {
  const readme = read("README.md");
  assert.match(
    readme,
    /Facility is open-source, self-hosted tooling for running AI coding agents as[\s\S]*part of a reviewable software delivery process[\s\S]*humans, the gates[\s\S]*evidence in one place/,
  );
  assert.match(readme, /Status: early software, published early on purpose/);
  assert.match(readme, /Who Facility is for/);
  assert.match(readme, /What you can do with it/);
  assert.match(readme, /Take work from an issue to a pull request/);
  assert.match(readme, /Review what an agent changed/);

  const index = read("apps/docs/docs/index.md");
  assert.match(index, /Facility is an AI SDLC system/);
  assert.match(index, /Persistent story workspaces give Claude Code and Codex one durable place/);
  assert.match(index, /Humans, gates, and evidence/);

  const method = read("apps/docs/docs/concepts/method.md");
  assert.match(method, /reviewable software delivery process/);
  assert.match(method, /Humans, gates, and evidence/);

  const roadmap = read("apps/docs/docs/roadmap.md");
  assert.match(roadmap, /Current focus/);
  assert.match(roadmap, /Planned direction/);
});

test("the project manifest reference covers every strict field", () => {
  const guide = read("apps/docs/docs/reference/project-manifest.md");
  for (const field of [
    "version",
    "repositories",
    "primary",
    "related",
    "environment",
    "image",
    "setup",
    "start",
    "ready",
    "stop",
    "seed",
    "browser_test",
    "secrets",
    "variables",
    "services",
    "port",
    "protocol",
    "websocket",
  ]) {
    assert.match(guide, new RegExp(`\\b${field}\\b`), `${field} must be documented`);
  }
  assert.match(guide, /FACILITY_PROJECT_<PROJECT_ID>_<NAME>/);
  assert.match(guide, /FACILITY_ARTIFACT_DIR/);
  assert.match(guide, /unknown keys[\s\S]*fail/i);
});

test("the agent reference covers engines, options, and every trigger", () => {
  const guide = read("apps/docs/docs/reference/agent-manifest.md");
  for (const field of [
    "name",
    "description",
    "engine",
    "model",
    "options",
    "reasoning_effort",
    "enabled",
    "triggers",
  ]) {
    assert.match(guide, new RegExp(`\\b${field}\\b`), `${field} must be documented`);
  }
  for (const value of [
    "claude_code",
    "codex",
    "manual",
    "mcp",
    "ui",
    "schedule",
    "github",
    "issues",
    "issue_comment",
    "pull_request",
    "pull_request_review",
    "check_suite",
    "workflow_run",
  ]) {
    assert.match(guide, new RegExp(`\\b${value}\\b`), `${value} must be documented`);
  }
  assert.match(guide, /permissions[\s\S]*not part of the manifest/i);
  assert.match(guide, /full workspace[\s\S]*GitHub/i);
});

test("project capabilities and delivery evidence are inspectable", () => {
  const agents = read("apps/docs/docs/concepts/agents-as-code.md");
  assert.match(agents, /\.agents\/skills/);
  assert.match(agents, /\.claude\/skills/);
  assert.match(agents, /facility_list_skills/);

  const mcp = read("apps/docs/docs/reference/mcp.md");
  assert.match(mcp, /facility_list_skills/);
  assert.match(mcp, /timeline[\s\S]*branches[\s\S]*pull requests[\s\S]*reviews[\s\S]*checks/i);

  const lifecycle = read("apps/docs/docs/reference/lifecycle.md");
  for (const subject of [
    "initial Git SHA",
    "final branch and SHA",
    "commits",
    "changed files",
    "periodic reconciliation",
    "story.collision_detected",
    "single timeline",
  ]) {
    assert.match(
      lifecycle,
      new RegExp(subject.replaceAll(" ", "\\s+"), "i"),
      `${subject} must be documented`,
    );
  }
});

test("lifecycle documentation preserves state and deletion semantics", () => {
  const guide = read("apps/docs/docs/reference/lifecycle.md");
  for (const state of [
    "ready",
    "working",
    "attention",
    "review",
    "done",
    "archived",
    "queued",
    "running",
    "succeeded",
    "failed",
    "canceled",
    "creating",
    "sleeping",
    "error",
    "destroyed",
  ]) {
    assert.match(guide, new RegExp(`\\b${state}\\b`), `${state} must be documented`);
  }
  assert.match(guide, /Suspend[\s\S]*retains/i);
  assert.match(guide, /Archive and restore[\s\S]*Neither operation destroys/i);
  assert.match(guide, /Delete workspace[\s\S]*Permanently destroys/i);
  assert.match(guide, /confirm: true/);
  assert.match(guide, /Idempotency-Key/);
});

test("operator and contributor runbooks retain essential operating subjects", () => {
  const production = read("apps/docs/docs/self-host/production.md");
  for (const subject of [
    "TLS",
    "migrations",
    "Backups and recovery",
    "Monitoring",
    "Scaling and maintenance",
    "SECRET_MASTER_KEY",
    "project budget",
    "GitHub mirror",
  ]) {
    assert.match(production, new RegExp(subject, "i"), `${subject} must be in production docs`);
  }

  const contributing = read("CONTRIBUTING.md");
  for (const subject of [
    "Find the owning code",
    "Database changes",
    "Agent and workspace contract changes",
    "Documentation changes",
    "pnpm verify",
    "Docker-backed",
  ]) {
    assert.match(contributing, new RegExp(subject), `${subject} must be in contributing docs`);
  }
});

test("the API reference maps every resource family", () => {
  const guide = read("apps/docs/docs/reference/api.md");
  for (const path of [
    "/health",
    "/readyz",
    "/webhooks/github",
    "/mcp",
    "/v1/me",
    "/v1/org",
    "/v1/members",
    "/v1/roles",
    "/v1/keys",
    "/v1/github/installations",
    "/v1/projects",
    "/story-agents",
    "/workspace-stories",
    "/conversation",
    "/environment",
    "/preview/:service/open",
    "/costs",
    "/budget",
    "/observability",
    "/pipeline",
    "/github/sync",
    "/audit",
  ]) {
    assert.ok(guide.includes(path), `${path} must be documented`);
  }
  assert.match(guide, /idempotency-status: replayed/);
  assert.match(guide, /x-request-id/);
});
