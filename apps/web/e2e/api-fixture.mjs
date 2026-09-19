import { createServer } from "node:http";

// Stateful HTTP boundary for the real Next pages and /api proxy. This fixture
// tests UI wiring, not authorization or durable storage implementation; those
// remain covered by the PostgreSQL/FakeWorkspaceRuntime integration suites.
const project = { id: "proj_ui", name: "Lifecycle fixture", slug: "lifecycle" };
const base = `/v1/projects/${project.id}/workspace-stories`;
const timestamp = "2026-09-01T00:00:00.000Z";
let permissions;
let bundle;
let messages;
let requests;
let failure;
const agent = {
  name: "builder",
  enabled: true,
  engine: "codex",
  model: "fixture-model",
  triggers: [{ type: "ui" }],
};

function reset(options = {}) {
  permissions = options.permissions ?? [
    "projects:read",
    "workspaces:read",
    "workspaces:execute",
    "projects:write",
  ];
  bundle = {
    story: {
      id: "story_ui",
      projectId: project.id,
      provider: "manual",
      externalId: "ui-fixture",
      title: "Persistent UI story",
      titleSource: "request",
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "ready",
      deletedAt: null,
      activeAgentName: null,
      branch: "fixture/story",
      pullRequestUrl: null,
    },
    workspace: {
      id: "ws_ui",
      provider: "fake",
      state: "running",
      volumeRef: "fixture-volume",
      lastActivityAt: timestamp,
      environment: { image: "fixture", ports: [] },
    },
    attention: [],
    assignees: [],
    timeline: [],
    turns: [],
    artifacts: [],
    needs_attention: false,
  };
  messages = [];
  requests = [];
  failure = null;
}
reset();

createServer(async (req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  let raw = "";
  for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : undefined;
  const reply = (data, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (path === "/health") return reply({ ok: true });
  if (path === "/__reset" && req.method === "POST") {
    reset(body);
    return reply({ ok: true });
  }
  if (path === "/__fail" && req.method === "POST") {
    failure = body;
    return reply({ ok: true });
  }
  if (path === "/__state") return reply({ bundle, messages, requests });
  if (path === "/v1/me")
    return reply({
      principal: { id: "fixture", userId: "fixture", email: "fixture@example.test" },
      org: { name: "Fixture" },
      permissions,
    });
  if (path === "/v1/projects") return reply([project]);
  if (path === `/v1/projects/${project.id}`) return reply(project);
  if (path === `/v1/projects/${project.id}/story-agents`)
    return reply({
      agents: [agent],
      defaults: { ui: "builder", manual: "builder", mcp: "builder" },
      title_generation: false,
    });
  if (path === `/v1/projects/${project.id}/backlog`)
    return reply({
      items: [
        {
          key: "story:story_ui",
          kind: "story",
          title: bundle.story.title,
          titleSource: "request",
          phase: bundle.story.status === "archived" ? "archived" : "not_started",
          reason: "ready",
          activity: { state: "idle", agentName: null, engine: null, turnId: null, since: null },
          environment: { recordedState: bundle.workspace.state, lastActivityAt: timestamp },
          attention: [],
          story: bundle.story,
          issue: null,
          pullRequest: null,
          labels: [],
          assignees: [],
          createdAt: timestamp,
          lastActivityAt: timestamp,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
      generatedAt: timestamp,
      counts: {
        not_started: bundle.story.status === "archived" ? 0 : 1,
        in_progress: 0,
        attention: 0,
        review: 0,
        done: 0,
        archived: bundle.story.status === "archived" ? 1 : 0,
      },
      facets: { labels: [], assignees: [], repositories: [], unassigned: 0 },
    });
  if (req.method === "GET") {
    if (path === base) return reply({ stories: [bundle.story] });
    if (path === `${base}/story_ui`) return reply(bundle);
    if (path === `${base}/story_ui/conversation`)
      return reply({ messages, related: [], has_more: false, next_cursor: null });
    if (path === `${base}/story_ui/environment`)
      return reply({
        workspace: bundle.workspace,
        events: [],
        inspection: { state: bundle.workspace.state },
        services: [],
        metrics: {
          create_time_ms: null,
          wake_time_ms: null,
          active_compute: bundle.workspace.state === "running",
          retained_storage: bundle.workspace.state !== "destroyed",
          cost: { active_compute_cents: null, retained_storage_cents: null },
        },
      });
  }
  requests.push({
    method: req.method,
    path,
    body,
    surface: req.headers["x-facility-surface"],
    key: req.headers["idempotency-key"],
  });
  if (failure?.path === path) {
    const status = failure.status ?? 500;
    failure = null;
    return reply({ error: { message: "Fixture operation failed; retry is safe." } }, status);
  }
  if (req.method === "POST" && (path === base || path === `${base}/story_ui/messages`)) {
    if (path === base) bundle.story.title = body.title ?? body.message.split("\n")[0];
    messages.push({
      id: `message_${messages.length}`,
      seq: messages.length + 1,
      author: { kind: "user", name: "Fixture user", handle: null, avatarUrl: null },
      turn: null,
      turnId: null,
      requestedAgentName: "builder",
      content: { kind: "text", progressMessages: null, reportedModel: null },
      role: "user",
      body: body.message,
      createdAt: timestamp,
      actor: { id: "fixture" },
    });
    bundle.workspace.state = "running";
    return reply(bundle, 202);
  }
  if (req.method === "POST" && path === `${base}/story_ui/suspend`) {
    bundle.workspace.state = "sleeping";
    return reply(bundle);
  }
  if (req.method === "POST" && path === `${base}/story_ui/archive`) {
    bundle.story.status = "archived";
    bundle.workspace.state = "sleeping";
    return reply(bundle);
  }
  if (req.method === "POST" && path === `${base}/story_ui/restore`) {
    bundle.story.status = "ready";
    return reply(bundle);
  }
  if (req.method === "DELETE" && path === `${base}/story_ui/workspace` && body?.confirm === true) {
    bundle.story.status = "archived";
    bundle.story.deletedAt = timestamp;
    bundle.workspace.state = "destroyed";
    return reply(bundle);
  }
  return reply({ error: { message: `Unexpected fixture request: ${req.method} ${path}` } }, 404);
}).listen(4491, "127.0.0.1");
