// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SavedReviewPage from "../app/(app)/projects/[projectId]/attention/review/page";
import AttentionReviewPage from "../app/(app)/projects/[projectId]/page";
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
  otherPullRequests: {
    total: 11,
    limit: 10,
    offset: 0,
    items: [
      {
        repository: "example/app",
        number: 7,
        title: "Review a historical association",
        url: "https://github.com/example/app/pull/7",
        draft: true,
        headSha: "b".repeat(40),
        stale: false,
        checks: {
          state: "success",
          headSha: "a".repeat(40),
          current: false,
          observedAt: "2026-11-05T10:00:00Z",
        },
        observedAt: "2026-11-05T12:00:00Z",
        updatedAt: "2026-11-05T10:00:00Z",
        stories: [
          { id: "archived", title: "Previous delivery", status: "archived", relation: "delivery" },
        ],
      },
    ],
  },
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
describe("project Attention entry", () => {
  it("starts with a review list while keeping filters and secondary navigation folded", async () => {
    const root = await render();
    expect(root.querySelector("form")?.closest("details")?.open).toBe(false);
    expect(
      root.querySelector('nav[aria-label="Related project views"]')?.closest("details")?.open,
    ).toBe(false);
    expect(root.querySelector('ol[aria-label="Pending stories"]')?.closest("details")).toBeNull();
    expect(root.textContent).not.toContain("Plans, notices and delivery sets, grouped");
    expect(root.textContent).not.toContain("Next review");
    const filtered = await render({ category: "plans", q: "scope" });
    expect(filtered.querySelector("form")?.closest("details")?.open).toBe(true);
    expect(filtered.querySelector<HTMLInputElement>('input[name="q"]')?.value).toBe("scope");
    expect(filtered.querySelector('a[href="/projects/project"]')?.textContent).toBe(
      "Clear filters",
    );
  });
  it("retains saved review URLs while every filter and related route leads to the project entry", async () => {
    const root = await render();
    expect(root.querySelector("form")?.getAttribute("action")).toBe("/projects/project");
    expect(root.querySelector('a[href="/projects/project/activity"]')?.textContent).toBe(
      "Activity",
    );
    expect(root.querySelector('a[href="/projects/project/attention"]')?.textContent).toBe(
      "All notices",
    );
    expect(
      root.querySelector('a[href="/projects/project/attention?status=resolved"]')?.textContent,
    ).toBe("Resolved notices");
    expect(root.querySelector('a[href="/projects/project/stories"]')?.textContent).toBe(
      "All stories",
    );
    const saved = renderToStaticMarkup(
      await SavedReviewPage({
        params: Promise.resolve({ projectId: "project" }),
        searchParams: Promise.resolve({ category: "plans", page: "2" }),
      }),
    );
    expect(saved).toContain("/projects/project?category=plans");
    expect(saved).not.toContain("Attention · preview");
  });
  it("shows a pending plan even when no notice exists", async () => {
    const data = structuredClone(page);
    const first = data.items[0];
    if (!first) throw Error("Missing story fixture");
    data.items = [{ ...first, noticeCount: 0, noticeKinds: [] }];
    data.total = 1;
    data.counts = { stories: 1, plans: 1, notices: 0, deliveries: 0 };
    mocks.result = { ok: true, data };
    const root = await render();
    expect(root.textContent).toContain("1 story · 1 pending plan · 0 open notices");
    expect(root.textContent).toContain("Review plan r3");
    expect(root.textContent).not.toMatch(/Nothing is waiting|No pending plans/);
  });
  it("uses shared totals and preserves independent plan and notice navigation", async () => {
    const root = await render();
    expect(root.textContent).toContain("12 stories · 5 pending plans · 25 open notices");
    expect(root.querySelectorAll('ol[aria-label="Pending stories"] > li')).toHaveLength(2);
    expect(
      Array.from(root.querySelectorAll("a"))
        .find((link) => link.textContent?.startsWith("Review plan r3"))
        ?.getAttribute("href"),
    ).toBe(
      `/projects/project/stories/plan-story?planRevision=3&planDigest=${"a".repeat(64)}#story-plan`,
    );
    expect(
      root.querySelector('a[href="/projects/project/stories/plan-story#story-attention"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('a[href="/projects/project/stories/question-story#story-attention"]'),
    ).not.toBeNull();
    expect(root.textContent).toContain("Plan · r3");
    expect(root.textContent).not.toContain("Opens this exact revision");
    expect(root.textContent).not.toMatch(/Approve|Urgent|For me|All clear/);
  });
  it("paginates and filters stories on the server, retaining filters in links", async () => {
    const root = await render({ q: "scope & risk", category: "plans", page: "2" });
    expect(mocks.queries).toEqual([
      { category: "plans", q: "scope & risk", limit: 10, offset: 10, pullOffset: 0 },
    ]);
    const previous = [...root.querySelectorAll("a")].find(
      (link) => link.textContent === "Previous",
    );
    expect(previous?.getAttribute("href")).toBe(
      "/projects/project?q=scope+%26+risk&category=plans",
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
    expect(empty.querySelector('ol[aria-label="Other open pull requests"]')).not.toBeNull();
  });
  it("keeps other PR pages independent while exposing stale-head checks and historical associations", async () => {
    const root = await render({ page: "2", pullPage: "2", q: "scope & risk" });
    expect(mocks.queries[0]).toMatchObject({ offset: 10, pullOffset: 10, q: "scope & risk" });
    expect(root.textContent).toContain("11 matching open PRs");
    expect(root.textContent).toContain("Checks belong to another or unknown head");
    expect(root.textContent).toContain("archived · delivery link");
    expect(root.querySelector('a[href="/projects/project/stories/archived"]')).not.toBeNull();
    const previous = [...root.querySelectorAll("a")].find(
      (link) => link.textContent === "Previous PRs",
    );
    expect(previous?.getAttribute("href")).toBe(
      "/projects/project?q=scope+%26+risk&page=2#other-pull-requests",
    );
    expect(
      root.querySelector('a[href="https://github.com/example/app/pull/7"]')?.getAttribute("rel"),
    ).toBe("noreferrer");
    expect((await render({ category: "plans" })).querySelector("#other-pull-requests")).toBeNull();
  });
  it("distinguishes missing PR inventory from empty and out-of-range pages", async () => {
    mocks.result = {
      ok: true,
      data: { ...page, otherPullRequests: { total: 11, limit: 10, offset: 100, items: [] } },
    };
    const beyond = await render({ pullPage: "11" });
    expect(beyond.textContent).toContain("No pull requests on this page");
    expect(beyond.textContent).toContain("First PR page");
    mocks.result = { ok: true, data: { ...page, otherPullRequests: undefined as never } };
    expect((await render()).textContent).toContain("inventory is unavailable");
  });
});
