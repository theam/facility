// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StoryPage from "../app/(app)/projects/[projectId]/stories/[number]/page";
import type { StoryEnvironment, WorkspaceStoryBundle } from "../lib/api";

const mocks = vi.hoisted(() => ({
  bundle: {} as WorkspaceStoryBundle,
  environment: {} as StoryEnvironment,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {} }),
  notFound() {
    throw new Error("not found");
  },
}));
vi.mock("../lib/api", () => ({
  api: {
    workspaceStory: async () => ({ ok: true, data: mocks.bundle }),
    workspaceStoryConversation: async () => ({
      ok: true,
      data: {
        messages: [1, 2].map((seq) => ({
          id: `msg${seq}`,
          seq,
          role: "user",
          body: `Message ${seq}`,
          actor: null,
          turnId: null,
          requestedAgentName: null,
          createdAt: "2026-09-10T00:00:00Z",
        })),
      },
    }),
    workspaceStoryEnvironment: async () => ({ ok: true, data: mocks.environment }),
    storyAgents: async () => ({ ok: true, data: { agents: [] } }),
    me: async () => ({ ok: true, data: { permissions: [] } }),
  },
}));

describe("story overview integration", () => {
  it("renders inspected state, latest messages and collapsed dismissed history together", async () => {
    mocks.bundle = {
      story: {
        id: "story",
        provider: "manual",
        externalId: "1",
        title: "Example story",
        status: "working",
        activeAgentName: null,
        branch: null,
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/acme/app/pull/42",
        updatedAt: "2026-09-10T00:00:00Z",
        archivedAt: null,
        deletedAt: null,
      },
      workspace: {
        id: "ws",
        provider: "vercel",
        state: "running",
        volumeRef: "snapshot",
        setupChecksum: null,
        environment: {},
        endpoints: [],
        error: null,
        lastActivityAt: "2026-09-10T00:00:00Z",
        destroyedAt: null,
      },
      conversation: null,
      turns: [],
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
      events: [],
      timeline: [],
      status: "working",
      needs_attention: false,
      next_operations: [],
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
    const html = renderToStaticMarkup(
      await StoryPage({ params: Promise.resolve({ projectId: "project", number: "story" }) }),
    );
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.textContent).toContain("No agent running");
    expect(root.textContent).toContain("Suspended");
    expect(root.querySelector('[aria-label="Needs your attention"]')).toBeNull();
    const history = [...root.querySelectorAll("details")].find((d) =>
      d.querySelector("summary")?.textContent?.includes("Resolved and dismissed"),
    );
    expect(history?.open).toBe(false);
    expect(history?.textContent).toContain("Old failure");
    expect(html.indexOf("Message 2")).toBeLessThan(html.indexOf("Message 1"));
    expect(
      root.querySelector('a[href="https://github.com/acme/app/pull/42"]')?.textContent,
    ).toContain("View pull request");
    expect(root.textContent).not.toContain("suspend compute");
    expect(root.textContent).not.toContain("send to agent");
  });
});
