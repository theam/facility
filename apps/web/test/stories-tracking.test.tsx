// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../app/(app)/projects/[projectId]/stories/page";
import type { ApiResult, ProjectBacklog } from "../lib/api";

const mocks = vi.hoisted(() => ({
  pages: [] as ApiResult<ProjectBacklog>[],
  calls: [] as unknown[],
  permissions: [] as string[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("../lib/api", () => ({
  api: {
    projectBacklog: async (_id: string, query: unknown) => {
      mocks.calls.push(query);
      return mocks.pages.shift();
    },
    storyAgents: async () => ({
      ok: true,
      data: { agents: [], defaults: { ui: null }, title_generation: false },
    }),
    me: async () => ({
      ok: true,
      data: { permissions: mocks.permissions, principal: { id: "reader" } },
    }),
  },
}));

const at = "2026-11-05T12:00:00.000Z";
function fixture(): ProjectBacklog {
  return {
    generatedAt: at,
    total: 63,
    limit: 50,
    offset: 0,
    counts: { not_started: 0, in_progress: 63, attention: 0, review: 0, done: 0, archived: 0 },
    groupCounts: { review: 63, in_progress: 0, waiting: 0, backlog: 0, done: 0, archived: 0 },
    facets: { labels: [], assignees: [], unassigned: 63, repositories: [] },
    items: [
      {
        key: "story:story",
        kind: "story",
        title: "Review and execution together",
        titleSource: "user",
        phase: "in_progress",
        reason: "running",
        activity: {
          state: "running",
          agentName: "reviewer",
          engine: "codex",
          turnId: "turn",
          since: at,
        },
        environment: { recordedState: "running", lastActivityAt: at },
        attention: [
          {
            id: "notice",
            source: "facility",
            kind: "agent_waiting",
            title: "Confirm the scope",
            turnId: "turn",
            createdAt: at,
          },
        ],
        story: {
          id: "story",
          status: "working",
          provider: "manual",
          externalId: "story",
          branch: null,
          activeAgentName: "reviewer",
          createdAt: at,
          updatedAt: at,
        },
        issue: null,
        pullRequest: null,
        labels: [],
        assignees: [],
        createdAt: at,
        lastActivityAt: at,
        tracking: {
          group: "review",
          pendingMessages: 3,
          messageWait: "previous_turn",
          previewApplying: false,
          plan: { revision: 3, digest: "a".repeat(64) },
          delivery: null,
          wait: null,
        },
      },
    ],
  };
}
async function render(search: Record<string, string> = {}) {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    await Page({
      params: Promise.resolve({ projectId: "project" }),
      searchParams: Promise.resolve(search),
    }),
  );
  return root;
}
beforeEach(() => {
  mocks.pages = [{ ok: true, data: fixture() }];
  mocks.calls = [];
  mocks.permissions = [];
});
describe("Stories tracking", () => {
  it("shows full counts, simultaneous work and exact review links", async () => {
    const root = await render();
    expect(mocks.calls).toEqual([{ sort: "activity", limit: 50, offset: 0 }]);
    expect(root.textContent).toContain("reviewer is running");
    expect(root.textContent).toContain("3 pending messages · waiting for the current turn");
    expect(root.textContent).toContain("1 open notice");
    expect(root.textContent).toContain("Last checked");
    const groups = root.querySelector('nav[aria-label="Work groups"]');
    expect(groups?.textContent).toContain("For review 63");
    expect(root.querySelector('a[href*="planRevision=3"]')?.getAttribute("href")).toBe(
      `/projects/project/stories/story?planRevision=3&planDigest=${"a".repeat(64)}#story-plan`,
    );
    expect(root.querySelector('a[href*="page=2"]')).not.toBeNull();
  });
  it("retains group and search on pages and clears group when selecting a lifecycle phase", async () => {
    const root = await render({ group: "review", q: "scope", page: "2" });
    expect(mocks.calls[0]).toMatchObject({ group: "review", q: "scope", offset: 50 });
    expect(root.querySelector('input[name="group"]')?.getAttribute("value")).toBe("review");
    expect(root.querySelector('a[aria-current="page"][href*="group=review"]')).not.toBeNull();
    expect(root.querySelector('a[href*="phase=archived"]')?.getAttribute("href")).not.toContain(
      "group=",
    );
  });
  it.each([403, 503])("keeps a %s read failure distinct from empty counts", async (status) => {
    mocks.pages = [{ ok: false, status, offline: false, message: "Read unavailable" }];
    const root = await render();
    expect(root.textContent).toContain("Backlog unavailable");
    expect(root.querySelector('nav[aria-label="Work groups"]')).toBeNull();
    expect(root.textContent).not.toContain("0 matching records");
    expect(mocks.calls).toHaveLength(1);
  });
  it("reads the recorded backlog with an explicit limitation when a server rejects groups", async () => {
    const legacy = fixture();
    delete legacy.groupCounts;
    delete legacy.items[0]?.tracking;
    mocks.pages = [
      { ok: false, status: 400, offline: false, message: "Unsupported sort" },
      { ok: true, data: legacy },
    ];
    const root = await render({ group: "waiting", q: "scope" });
    expect(mocks.calls[1]).toMatchObject({ group: undefined, sort: "priority", q: "scope" });
    expect(root.textContent).toContain("This server could not apply work groups");
    expect(root.querySelector('nav[aria-label="Work groups"]')).toBeNull();
    expect(root.textContent).toContain("Review and execution together");
  });
});
