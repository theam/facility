// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StoryPage from "../app/(app)/projects/[projectId]/stories/[number]/page";
import type {
  StoryConversationPage,
  StoryEnvironment,
  StoryMessage,
  WorkspaceStoryBundle,
} from "../lib/api";

const mocks = vi.hoisted(() => ({
  bundle: {} as WorkspaceStoryBundle,
  environment: {} as StoryEnvironment,
  conversation: {
    messages: [],
    related: [],
    has_more: false,
    next_cursor: null,
  } as StoryConversationPage,
  permissions: [] as string[],
  calls: [] as string[],
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {} }),
  notFound() {
    throw new Error("not found");
  },
}));
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  const unexpected = { ok: false, status: 500, offline: false, message: "unexpected" } as const;
  const record = <T,>(name: string, value: T) => {
    mocks.calls.push(name);
    return value;
  };
  return {
    ...actual,
    api: {
      workspaceStory: async () => record("story", { ok: true, data: mocks.bundle }),
      workspaceStoryConversation: async () =>
        record("conversation", { ok: true, data: mocks.conversation }),
      workspaceStoryEnvironment: async () =>
        record("environment", { ok: true, data: mocks.environment }),
      workspaceStoryActivity: async () => record("activity", unexpected),
      workspaceStoryTimeline: async () => record("timeline", unexpected),
      workspaceStoryTurnEvent: async () => record("event", unexpected),
      storyAgents: async () => ({
        ok: true,
        data: { agents: [{ name: "builder", enabled: true, model: "gpt-5.5", engine: "codex" }] },
      }),
      me: async () => ({ ok: true, data: { permissions: mocks.permissions } }),
    },
  };
});

const at = "2026-09-10T00:00:00Z";
function message(seq: number, overrides: Partial<StoryMessage>): StoryMessage {
  return {
    id: `msg${seq}`,
    seq,
    role: "user",
    body: `Message ${seq}`,
    actor: null,
    turnId: null,
    requestedAgentName: "builder",
    createdAt: at,
    author: { kind: "user", id: "user_a", name: "Ada Lovelace", handle: null, avatarUrl: null },
    turn: null,
    content: { kind: "text", progressMessages: null, reportedModel: null },
    ...overrides,
  };
}

function setUp(permissions: string[] = []) {
  mocks.calls.length = 0;
  mocks.permissions = permissions;
  mocks.bundle = {
    story: {
      id: "story",
      provider: "manual",
      externalId: "1",
      title: "Example story",
      status: "review",
      activeAgentName: null,
      branch: "facility/example",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme/app/pull/42",
      updatedAt: at,
      archivedAt: null,
      deletedAt: null,
    },
    workspace: {
      id: "ws",
      provider: "vercel",
      state: "running",
      volumeRef: "snapshot",
      setupChecksum: null,
      environment: { ports: [{ service: "app", port: 3000 }] },
      endpoints: [],
      error: null,
      lastActivityAt: at,
      destroyedAt: null,
    },
    conversation: null,
    turns: [
      {
        id: "turn_done",
        agentName: "builder",
        engine: "codex",
        model: "gpt-5.5",
        state: "succeeded",
        error: null,
        createdAt: at,
      },
      {
        id: "turn_old",
        agentName: "architect",
        engine: "claude_code",
        model: "claude-opus-4-8",
        state: "succeeded",
        error: null,
        createdAt: at,
      },
    ],
    artifacts: [],
    attention: [
      {
        id: "notice",
        turnId: null,
        kind: "turn_error",
        title: "Old failure",
        detail: "Raw old error",
        status: "resolved",
        resolution: "dismissed",
        resolvedBy: null,
        resolvedAt: null,
        createdAt: "2026-09-09T00:00:00Z",
      },
    ],
    status: "review",
    needs_attention: false,
    next_operations: [],
  };
  const done = {
    id: "turn_done",
    agentName: "builder",
    engine: "codex",
    model: "gpt-5.5",
    state: "succeeded",
    error: null,
    triggerType: "ui",
    createdAt: at,
    startedAt: at,
    endedAt: "2026-09-10T00:04:00Z",
  };
  const old = {
    ...done,
    id: "turn_old",
    agentName: "architect",
    engine: "claude_code",
    model: "claude-opus-4-8",
  };
  mocks.conversation = {
    messages: [
      message(4, {
        role: "agent",
        body: "**Done.** The feature ships in the pull request.",
        turnId: "turn_done",
        turn: done,
        author: { kind: "agent", id: "codex:s", name: "builder", handle: null, avatarUrl: null },
        content: { kind: "final_response", progressMessages: 2, reportedModel: null },
      }),
      message(3, { body: "Please add the feature", turnId: "turn_done", turn: done }),
      message(2, {
        role: "agent",
        body: "Looking at the design.\n\nThe design is sound.",
        turnId: "turn_old",
        turn: old,
        author: {
          kind: "agent",
          id: "claude_code:s",
          name: "architect",
          handle: null,
          avatarUrl: null,
        },
        content: { kind: "combined_transcript", progressMessages: null, reportedModel: null },
      }),
    ],
    related: [
      message(1, {
        body: "Review the design",
        turnId: "turn_old",
        turn: old,
        requestedAgentName: "architect",
        author: {
          kind: "github",
          id: "github:octocat",
          name: "octocat",
          handle: "@octocat",
          avatarUrl: null,
        },
      }),
    ],
    has_more: false,
    next_cursor: null,
  };
  if (!mocks.bundle.workspace) throw new Error("Missing test workspace");
  mocks.environment = {
    workspace: mocks.bundle.workspace,
    inspection: { state: "sleeping", volumeRef: "snapshot", endpoints: [] },
    metrics: {
      create_time_ms: null,
      wake_time_ms: null,
      active_compute: false,
      retained_storage: true,
      provider_errors: 0,
      usage: {},
      cost: {
        currency: "USD",
        active_compute_cents: null,
        retained_storage_cents: null,
        status: "unavailable",
      },
    },
    events: [],
    next_cursor: 0,
    has_more: false,
  };
}

async function render() {
  const html = renderToStaticMarkup(
    await StoryPage({ params: Promise.resolve({ projectId: "project", number: "story" }) }),
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  return { html, root };
}

describe("story overview integration", () => {
  it("renders state, the final response first, participants, and folded evidence for a reader", async () => {
    setUp();
    const { html, root } = await render();
    expect(root.textContent).toContain("No agent running");
    expect(root.textContent).toContain("Suspended");
    expect(root.textContent).toContain("In review");
    expect(root.querySelector('[aria-label="Needs your attention"]')).toBeNull();
    // Only the story, its first conversation page and the environment inspection were requested.
    expect(mocks.calls.sort()).toEqual(["conversation", "environment", "story"]);

    const history = [...root.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")?.textContent?.includes("Resolved and dismissed"),
    );
    expect(history?.open).toBe(false);
    expect(history?.textContent).toContain("Old failure");
    const timeline = [...root.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")?.textContent?.includes("Activity timeline"),
    );
    expect(timeline?.open).toBe(false);
    expect(timeline?.querySelector("ol")).toBeNull();

    // The newest exchange comes first and pairs the request with its response.
    const exchanges = [...root.querySelectorAll("article")];
    expect(exchanges[0]?.textContent).toContain("Ada Lovelace");
    expect(exchanges[0]?.textContent).toContain("Please add the feature");
    expect(exchanges[0]?.textContent).toContain("The feature ships in the pull request.");
    expect(exchanges[0]?.textContent).toContain("Codex · GPT-5.5");
    expect(exchanges[0]?.textContent).toContain("Completed");
    expect(exchanges[0]?.textContent).toContain("2 progress messages");
    expect(html.indexOf("Please add the feature")).toBeLessThan(
      html.indexOf("The feature ships in the pull request."),
    );
    // A request on a later page still shows with the response it produced.
    expect(exchanges[1]?.textContent).toContain("octocat");
    expect(exchanges[1]?.textContent).toContain("Review the design");
    expect(exchanges[1]?.textContent).toContain("Claude Code · Opus 4.8");
    expect(exchanges[1]?.textContent).toContain("Recorded as one transcript");
    expect(exchanges[1]?.querySelector("details[open]")).toBeNull();

    expect(
      root.querySelector('a[href="https://github.com/acme/app/pull/42"]')?.textContent,
    ).toContain("pull request #42");
    expect(root.querySelector('a[href^="#"]')).toBeNull();
    expect(root.textContent).not.toContain("suspend compute");
    expect(root.textContent).not.toContain("send a task");
    expect(root.textContent).not.toContain("open app");
  });

  it("offers the everyday actions from the top for an executor", async () => {
    setUp(["workspaces:execute", "projects:write"]);
    const { root } = await render();
    const actions = root.querySelector('[aria-label="Story actions"]');
    expect(actions?.textContent).toContain("send a task");
    expect(actions?.textContent).toContain("open app ↗");
    expect(actions?.textContent).toContain("maintenance");
    expect(actions?.textContent).not.toContain("cancel run");
    expect(root.querySelector("#story-composer")).toBeNull();
    expect(root.querySelector('button[aria-expanded="false"]')?.textContent).toBe("send a task");
  });
});
