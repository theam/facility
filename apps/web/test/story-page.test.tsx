// @vitest-environment jsdom
import type { StoryPlan, StoryWorkflowStatus } from "@facility/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StoryPage from "../app/(app)/projects/[projectId]/stories/[number]/page";
import type {
  StoryConversationPage,
  StoryEnvironment,
  StoryMessage,
  WorkspaceStoryBundle,
} from "../lib/api";
import { reviewCycleFixture } from "./fixtures/review-cycle";
import { snapshot as completionSnapshot } from "./fixtures/story-completion";
import { snapshot as deliverySnapshot } from "./fixtures/story-delivery";

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
  linkedPlan: null as StoryPlan | null,
  requestedMessage: undefined as string | undefined,
  workflowError: false,
  reviewCycle: undefined as StoryWorkflowStatus["reviewCycle"],
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
      workspaceStoryConversation: async (
        _project: string,
        _story: string,
        _before?: number,
        messageId?: string,
      ) => {
        mocks.requestedMessage = messageId;
        return record("conversation", { ok: true, data: mocks.conversation });
      },
      storyPlanRevision: async (_project: string, _story: string, revision: number) =>
        record(
          `plan:${revision}`,
          mocks.linkedPlan
            ? { ok: true, data: mocks.linkedPlan }
            : { ok: false, status: 404, message: "Plan not found" },
        ),
      workspaceStoryEnvironment: async () =>
        record("environment", { ok: true, data: mocks.environment }),
      workspaceStoryConsultations: async () =>
        record("consultations", { ok: true, data: { items: [], total: 0, limit: 10, offset: 0 } }),
      storyWorkflow: async () =>
        mocks.workflowError
          ? record("workflow", {
              ok: false,
              status: 503,
              offline: false,
              message: "Workflow read failed",
            })
          : record("workflow", {
              ok: true,
              data: {
                schemaVersion: 1,
                orgId: "org",
                projectId: "project",
                storyId: "story",
                policy: {
                  revision: 0,
                  policy: {
                    planApprovalAgents: [],
                    holdAfterFailure: false,
                    requireDeliveryAcceptance: false,
                    requirePreviewForAcceptance: false,
                  },
                },
                plan: { revision: 0, decisionRevision: 0, status: "none" },
                queuedAgents: [],
                blockedReason: null,
                reviewCycle: mocks.reviewCycle,
                acceptance: {
                  schemaVersion: 1,
                  orgId: "org",
                  projectId: "project",
                  storyId: "story",
                  required: false,
                  status: "missing",
                  receipt: null,
                },
              } satisfies StoryWorkflowStatus,
            }),
      workspaceStoryActivity: async () => record("activity", unexpected),
      workspaceStoryTimeline: async () => record("timeline", unexpected),
      workspaceStoryTurnEvent: async () => record("event", unexpected),
      storyAgents: async () => ({
        ok: true,
        data: {
          agents: [{ name: "builder", enabled: true, model: "gpt-5.5", engine: "codex" }],
          defaults: { ui: "builder", mcp: "builder", manual: "builder" },
        },
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
  mocks.workflowError = false;
  mocks.reviewCycle = undefined;
  mocks.permissions = permissions;
  mocks.bundle = {
    story: {
      id: "story",
      provider: "manual",
      externalId: "1",
      title: "Example story",
      titleSource: "user",
      createdAt: at,
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
    assignees: [],
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

async function render(search: Record<string, string | string[]> = {}) {
  const html = renderToStaticMarkup(
    await StoryPage({
      params: Promise.resolve({ projectId: "project", number: "story" }),
      searchParams: Promise.resolve(search),
    }),
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  return { html, root };
}

describe("story overview integration", () => {
  it.each([
    "correction",
    "human_review",
    "decision_required",
  ] as const)("leads with the recorded review in %s while keeping conversation adjacent", async (phase) => {
    setUp(["*"]);
    mocks.reviewCycle = reviewCycleFixture();
    mocks.reviewCycle.phase = phase;
    const { root } = await render();
    const workflow = root.querySelector('[data-story-section="workflow"]');
    expect(workflow?.hasAttribute("hidden")).toBe(false);
    expect(workflow?.getAttribute("aria-label")).toBe(
      phase === "correction" ? null : "Your decision",
    );
    expect(root.querySelector('[aria-label="Recorded delivery review"]')).not.toBeNull();
    const conversation = root.querySelector("#conversation");
    expect(conversation).not.toBeNull();
    expect(
      (workflow?.compareDocumentPosition(conversation as Node) ?? 0) &
        (phase === "correction"
          ? Node.DOCUMENT_POSITION_PRECEDING
          : Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBeTruthy();
  });
  it("loads only the requested plan revision and rejects mismatched or missing source reads", async () => {
    setUp(["projects:write"]);
    mocks.linkedPlan = {
      revision: 2,
      digest: "b".repeat(64),
      markdown: "Exact older scope",
      repositories: [],
      agents: [],
      proposedBy: { type: "user", id: "user", name: "Person" },
      proposedAt: at,
      source: null,
    };
    const selected = await render({ planRevision: "2", planDigest: "b".repeat(64) });
    expect(mocks.calls).toContain("plan:2");
    expect(selected.root.textContent).toContain("Exact older scope");
    const mismatched = await render({ planRevision: "2", planDigest: "a".repeat(64) });
    expect(mismatched.root.textContent).toContain("does not match this link");
    expect(mismatched.root.textContent).not.toContain("Exact older scope");
    const absent = await render({ messageId: "msg-not-in-response" });
    expect(mocks.requestedMessage).toBe("msg-not-in-response");
    expect(absent.root.textContent).toContain("requested source message was not returned");
    expect(absent.root.querySelector('ol[aria-label="Conversation, newest first"]')).toBeNull();
    mocks.linkedPlan = null;
    expect((await render({ planRevision: "3" })).root.textContent).toContain("Plan not found");
  });
  it("shows actionable delivery notices without recasting them as agent errors", async () => {
    setUp(["*"]);
    mocks.bundle.attention = [
      {
        id: "delivery-notice",
        turnId: null,
        kind: "delivery_completion",
        title: "Complete the source issue",
        detail: "Review the exact source issue and explicitly request completion.",
        status: "open",
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: at,
      },
    ];
    const { root } = await render();
    const attention = root.querySelector('[aria-label="Needs your attention"]');
    expect(attention?.textContent).toContain("Complete the source issue");
    expect(attention?.textContent).toContain(
      "Review the exact source issue and explicitly request completion.",
    );
    expect(attention?.textContent).not.toContain("The run reported an error");
    expect(attention?.textContent).not.toContain("Technical details");
  });

  it.each([
    ["review_cycle_ready", "The pinned candidate is ready for human review."],
    ["review_cycle_decision", "The permissions change exceeds the approved plan."],
    ["review_cycle_decision", "The review limit is exhausted; a human decision is required."],
  ])("presents %s as a human review with its recorded reason", async (kind, detail) => {
    setUp(["*"]);
    mocks.bundle.attention = [
      {
        id: "review-notice",
        turnId: "turn_done",
        kind,
        title: "Review needs a human decision",
        detail,
        status: "open",
        resolution: null,
        resolvedBy: null,
        resolvedAt: null,
        createdAt: at,
      },
    ];
    const { root } = await render();
    const attention = root.querySelector('[aria-label="Needs your attention"]');
    if (!attention) throw new Error("Missing human review notice");
    expect(attention?.textContent).toContain(detail);
    expect(attention?.textContent).not.toContain("The run reported an error");
    expect(attention?.textContent).not.toContain("Technical details");
    expect([...attention.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Dismiss",
    ]);
    expect(attention?.querySelector('a[href="#story-section-workflow"]')?.textContent).toBe(
      "Review the candidate and findings",
    );
    expect(attention?.textContent).toContain("does not approve changes or restart work");
    mocks.permissions = ["projects:read"];
    const reader = (await render()).root.querySelector('[aria-label="Needs your attention"]');
    expect(reader?.textContent).toContain(detail);
    expect(reader?.querySelector("button")).toBeNull();
    expect(reader?.querySelector('a[href="#story-section-workflow"]')).not.toBeNull();
  });

  it("renders state, the final response first, participants, and folded evidence for a reader", async () => {
    setUp();
    const { html, root } = await render();
    expect(root.textContent).toContain("No agent running");
    expect(root.textContent).toContain("Suspended");
    expect(root.textContent).toContain("In review");
    expect(root.querySelector('[aria-label="Needs your attention"]')).toBeNull();
    // Saved workflow and consultation reads start no inference or workspace wake.
    expect(mocks.calls.sort()).toEqual([
      "consultations",
      "conversation",
      "environment",
      "story",
      "workflow",
    ]);
    expect(root.querySelector('[aria-label="Workflow status"]')?.textContent).toContain(
      "optional for this project",
    );
    expect(root.querySelector("#consultation")?.textContent).toContain("No consultations saved");

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
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
      expect(root.querySelector(link.getAttribute("href") ?? "")).not.toBeNull();
    }
    expect(root.textContent).not.toContain("Suspend compute");
    expect(root.textContent).not.toContain("Send a task");
    expect(root.textContent).not.toContain("Ask without changes");
    expect(root.textContent).not.toContain("Open app");
  });

  it("offers the everyday actions from the top for an executor", async () => {
    setUp(["workspaces:execute", "projects:write"]);
    const { root } = await render();
    const actions = root.querySelector('[aria-label="Story actions"]');
    expect(actions?.textContent).toContain("Send a task");
    expect(actions?.textContent).toContain("Ask without changes");
    expect(actions?.textContent).not.toContain("Open app");
    // "Ask without changes" is the only link there: it reveals the consultation section
    // on every click, even when the address already points to it.
    expect(
      [...(actions?.querySelectorAll("a") ?? [])].map((link) => link.getAttribute("href")),
    ).toEqual(["#story-section-consultation"]);
    expect(root.querySelector("#story-section-consultation")).not.toBeNull();
    const conversation = root.querySelector("#conversation");
    const list = conversation?.querySelector('ol[aria-label="Conversation, newest first"]');
    expect(
      ((actions as Node).compareDocumentPosition(list as Node) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const environment = root.querySelector('[aria-label="Environment actions"]');
    expect(environment?.closest("header")).not.toBeNull();
    expect(environment?.textContent).toContain("Open app ↗");
    expect(environment?.textContent).toContain("More");
    expect(actions?.textContent).not.toContain("Cancel turn");
    expect(root.querySelector("#story-composer")).toBeNull();
    expect(root.querySelector('button[aria-expanded="false"]')?.textContent).toBe("Send a task");
  });

  it("keeps the plan and conversation together before delivery and environment controls", async () => {
    setUp(["workspaces:execute", "projects:write"]);
    const { root } = await render();
    const plan = root.querySelector("#story-plan");
    const conversation = root.querySelector("#conversation");
    if (!conversation || !plan) throw new Error("Missing conversation or plan");
    expect(plan.closest("[data-story-section]")?.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Plan");
    expect(
      conversation.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(conversation?.querySelector('[aria-label="Story actions"]')).not.toBeNull();
    expect(
      conversation.compareDocumentPosition(
        root.querySelector('[aria-label="Workflow status"]') as Node,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      conversation.compareDocumentPosition(root.querySelector("#workspace") as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("puts the delivery before conversation and folds future controls without changing permissions", async () => {
    setUp(["projects:read"]);
    mocks.bundle.delivery = deliverySnapshot();
    const { root } = await render();
    const lead = root.querySelector('[aria-label="Your decision"]');
    expect(lead?.getAttribute("data-story-section")).toBe("delivery");
    expect(lead?.nextElementSibling?.querySelector("#conversation")).not.toBeNull();
    for (const key of ["plan", "environment"])
      expect(root.querySelector(`[data-story-section="${key}"]`)?.hasAttribute("hidden")).toBe(
        true,
      );
    expect(root.textContent).not.toContain("Edit PR set");
    expect(root.textContent).not.toContain("Request delivery acceptance");
  });

  it("brings post-merge source and retention into focus without offering completion for an unlinked story", async () => {
    setUp(["projects:write", "github:write"]);
    mocks.bundle.delivery = deliverySnapshot();
    mocks.bundle.completion = completionSnapshot();
    mocks.bundle.completion.source = { kind: "other", state: "unavailable", url: null };
    const { root } = await render();
    const lead = root.querySelector('[aria-label="Your decision"]');
    expect(lead?.getAttribute("data-story-section")).toBe("completion");
    expect(lead?.nextElementSibling?.querySelector("#conversation")).not.toBeNull();
    expect(lead?.textContent).toContain("No source issue linked");
    expect(root.textContent).not.toContain("Complete source issue");
    expect(root.textContent).toContain("storage retained");
  });

  it("keeps completion unavailable and workflow failures explicit on an archived legacy snapshot", async () => {
    setUp(["projects:read"]);
    mocks.bundle.story.status = "archived";
    mocks.bundle.story.archivedAt = at;
    mocks.workflowError = true;
    const { root } = await render();
    expect(root.querySelector('[aria-label="Your decision"]')).toBeNull();
    const lead = root.querySelector('[data-story-section="completion"]');
    expect(lead?.hasAttribute("hidden")).toBe(false);
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Delivery");
    expect(lead?.textContent).toContain("Completion and retention details are unavailable");
    expect(root.textContent).toContain("Workflow read failed");
    expect(root.textContent).not.toContain("Delivery completed");
  });
});
