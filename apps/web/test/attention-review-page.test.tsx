// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AttentionReviewPage from "../app/(app)/projects/[projectId]/attention/review/page";
import type { AttentionStoriesQuery, ProjectAttentionStories } from "../lib/api";

const mocks = vi.hoisted(() => ({
  result: {} as
    | { ok: true; data: ProjectAttentionStories }
    | { ok: false; offline: boolean; message: string },
  queries: [] as AttentionStoriesQuery[],
}));
vi.mock("../lib/api", () => ({
  api: {
    projectAttentionStories: async (_id: string, query: AttentionStoriesQuery) => {
      mocks.queries.push(query);
      return mocks.result;
    },
  },
}));
const page: ProjectAttentionStories = {
  generatedAt: "2026-11-05T12:00:00Z",
  total: 12,
  limit: 10,
  offset: 0,
  counts: { stories: 12, plans: 5, notices: 25, deliveries: 0 },
  budget: { available: false, reason: "permission" },
  workflowPolicy: { available: true, error: null },
  items: [
    {
      storyId: "plan-story",
      storyTitle: "Review repository scope",
      storyStatus: "attention",
      waitingSince: "2026-11-05T10:00:00Z",
      noticeCount: 2,
      noticeKinds: [{ kind: "runtime_error", count: 2 }],
      delivery: null,
      plan: {
        revision: 3,
        digest: "a".repeat(64),
        proposedAt: "2026-11-05T10:00:00Z",
        decisionBrief: { status: "absent" },
      },
    },
    {
      storyId: "question-story",
      storyTitle: "Choose export format",
      storyStatus: "working",
      waitingSince: "2026-11-05T11:00:00Z",
      noticeCount: 1,
      noticeKinds: [{ kind: "agent_waiting", count: 1 }],
      delivery: null,
      plan: null,
    },
  ],
};
async function render(search: Record<string, string> = {}) {
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(
    await AttentionReviewPage({
      params: Promise.resolve({ projectId: "project" }),
      searchParams: Promise.resolve(search),
    }),
  );
  return root;
}
beforeEach(() => {
  mocks.result = { ok: true, data: structuredClone(page) };
  mocks.queries = [];
});
describe("whole-story review queue", () => {
  it("uses shared totals and preserves independent plan and notice navigation", async () => {
    const root = await render();
    expect(root.textContent).toContain("12 stories · 5 pending plans · 25 open notices");
    expect(root.querySelectorAll('ol[aria-label="Pending stories"] > li')).toHaveLength(2);
    expect(
      root.querySelector('a[href="/projects/project/stories/plan-story#story-plan"]')?.textContent,
    ).toBe("Open current plan");
    expect(
      root.querySelector('a[href="/projects/project/stories/plan-story#story-attention"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('a[href="/projects/project/stories/question-story#story-attention"]'),
    ).not.toBeNull();
    expect(root.textContent).toContain("No structured brief was supplied");
    expect(root.textContent).toContain("Observed revision r3");
    expect(root.textContent).not.toMatch(/Approve|Urgent|For me|All clear/);
  });
  it("paginates and filters stories on the server, retaining filters in links", async () => {
    const root = await render({ q: "scope & risk", category: "plans", page: "2" });
    expect(mocks.queries).toEqual([
      { category: "plans", q: "scope & risk", limit: 10, offset: 10 },
    ]);
    const previous = [...root.querySelectorAll("a")].find(
      (link) => link.textContent === "Previous",
    );
    expect(previous?.getAttribute("href")).toBe(
      "/projects/project/attention/review?q=scope+%26+risk&category=plans",
    );
    expect(root.textContent).toContain("in matching stories");
  });
  it("does not claim an empty queue when a read fails or a page is out of bounds", async () => {
    mocks.result = { ok: false, offline: false, message: "Permission denied" };
    const denied = await render();
    expect(denied.textContent).toContain("Couldn't load pending stories");
    expect(denied.textContent).not.toContain("No pending plans");
    mocks.result = { ok: true, data: { ...page, items: [] } };
    expect((await render({ page: "5" })).textContent).toContain("No stories on this page");
    mocks.result = {
      ok: true,
      data: {
        ...page,
        items: [],
        total: 0,
        counts: { stories: 0, plans: 0, notices: 0, deliveries: 0 },
      },
    };
    const empty = await render();
    expect(empty.textContent).toContain("No pending plans, notices or deliveries");
    expect(empty.textContent).toContain(
      "Check the project overview for pull requests without a linked delivery",
    );
  });
});
