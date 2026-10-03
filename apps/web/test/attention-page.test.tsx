// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectAttentionPage from "../app/(app)/projects/[projectId]/attention/page";
import type { AttentionQuery, ProjectAttention, ProjectOverview } from "../lib/api";

type Failure = { ok: false; status: number; offline: boolean; message: string };
const mocks = vi.hoisted(() => ({
  attention: { ok: true, data: {} as ProjectAttention } as
    | { ok: true; data: ProjectAttention }
    | Failure,
  overview: { ok: true, data: {} as ProjectOverview } as
    | { ok: true; data: ProjectOverview }
    | Failure,
  permissions: ["*"] as string[],
  queries: [] as AttentionQuery[],
  overviewCalls: 0,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../lib/api", () => ({
  api: {
    projectAttention: async (_projectId: string, query: AttentionQuery) => {
      mocks.queries.push(query);
      return mocks.attention;
    },
    projectOverview: async () => {
      mocks.overviewCalls += 1;
      return mocks.overview;
    },
    me: async () => ({ ok: true, data: { permissions: mocks.permissions } }),
  },
}));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function openPage(): ProjectAttention {
  return {
    generatedAt: new Date().toISOString(),
    total: 2,
    limit: 25,
    offset: 0,
    counts: { open: 2, resolved: 7 },
    facets: {
      kinds: [
        { kind: "agent_waiting", count: 1 },
        { kind: "turn_error", count: 1 },
      ],
    },
    items: [
      {
        id: "attn-waiting",
        storyId: "story-waiting",
        storyTitle: "Waiting story",
        storyStatus: "attention",
        turnId: null,
        kind: "agent_waiting",
        title: "builder needs a reply",
        detail: "Push access was declined. Should I hand the commit over as-is?",
        status: "open",
        resolution: null,
        createdAt: minutesAgo(20),
        resolvedAt: null,
        action: "reply",
      },
      {
        id: "attn-failed",
        storyId: "story-failed",
        storyTitle: "Failed story",
        storyStatus: "attention",
        turnId: "turn-failed",
        kind: "turn_error",
        title: "builder failed",
        detail: "Error: request timed out",
        status: "open",
        resolution: null,
        createdAt: minutesAgo(90),
        resolvedAt: null,
        action: "retry",
      },
    ],
  };
}

function overviewWithSignals(): ProjectOverview {
  return {
    review: {
      total: 1,
      items: [
        {
          source: "mirror",
          storyId: "story-review",
          storyTitle: "Review story",
          storyStatus: "working",
          activeAgentName: null,
          pullRequest: {
            number: 42,
            title: "Implement review story",
            url: "https://github.com/acme/app/pull/42",
            repository: "acme/app",
            draft: false,
            ciState: "failure",
            ciFailureNames: ["verify"],
            updatedAt: minutesAgo(30),
          },
        },
      ],
    },
    spend: {
      agents: { available: false, reason: "permission" },
      budget: { available: false, reason: "permission" },
    },
  } as unknown as ProjectOverview;
}

async function render(searchParams: Record<string, string | string[]> = {}) {
  const html = renderToStaticMarkup(
    await ProjectAttentionPage({
      params: Promise.resolve({ projectId: "project" }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  return { root, text: root.textContent ?? "" };
}

function section(root: HTMLElement, label: string) {
  const element = root.querySelector(`[aria-label="${label}"]`);
  if (!element) throw new Error(`missing section ${label}`);
  return element;
}

beforeEach(() => {
  mocks.attention = { ok: true, data: openPage() };
  mocks.overview = { ok: true, data: overviewWithSignals() };
  mocks.permissions = ["*"];
  mocks.queries = [];
  mocks.overviewCalls = 0;
});

describe("attention page", () => {
  it("lists every open notice with its verb, after the live signals the overview also counts", async () => {
    const { root, text } = await render();
    expect(mocks.queries).toEqual([{ status: "open", limit: 25, offset: 0 }]);
    expect(text).toContain("Needs your attention");
    expect(text).toContain("2 open notices · 1 from pull requests and the budget · 7 resolved");
    expect(root.querySelector('a[href="/projects/project"]')?.textContent).toBe("← Overview");

    const tabs = section(root, "Notice status");
    expect(tabs.querySelector('[aria-current="page"]')?.textContent).toBe("Open2");
    expect(
      tabs.querySelector('a[href="/projects/project/attention?status=resolved"]')?.textContent,
    ).toBe("Resolved7");
    const kinds = section(root, "Notice kind");
    expect(kinds.textContent).toContain("Agent waiting for a reply1");
    expect(
      kinds.querySelector('a[href="/projects/project/attention?kind=turn_error"]'),
    ).not.toBeNull();

    const signals = section(root, "Also waiting on you");
    expect(signals.textContent).toContain("Checks failed on pull request #42");
    expect(signals.querySelector('a[href="https://github.com/acme/app/pull/42"]')).not.toBeNull();

    const notices = section(root, "Notices");
    expect(notices.querySelectorAll("article")).toHaveLength(2);
    expect(notices.textContent).toContain("Push access was declined.");
    expect(
      notices.querySelector('a[href="/projects/project/stories/story-waiting#story-composer"]')
        ?.textContent,
    ).toBe("Reply in the story →");
    expect(notices.textContent).toContain("Technical details");
    const buttons = [...notices.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(["dismiss", "retry", "dismiss"]);
    expect(text).toContain("Showing 1–2 of 2");
    expect(text).not.toContain("Older →");
  });

  it("carries search, kind and page into the query and every link, without live signals", async () => {
    mocks.attention = {
      ok: true,
      data: { ...openPage(), total: 30, offset: 25, items: openPage().items.slice(1) },
    };
    const { root, text } = await render({ kind: "turn_error", q: "timed out", page: "2" });
    expect(mocks.queries).toEqual([
      { status: "open", kind: ["turn_error"], q: "timed out", limit: 25, offset: 25 },
    ]);
    expect(mocks.overviewCalls).toBe(0);
    expect(root.querySelector('[aria-label="Also waiting on you"]')).toBeNull();
    expect(text).toContain("30 open notices match");
    const search = root.querySelector<HTMLInputElement>('input[name="q"]');
    expect(search?.defaultValue).toBe("timed out");
    expect(root.querySelector('input[type="hidden"][name="kind"]')?.getAttribute("value")).toBe(
      "turn_error",
    );
    expect(
      section(root, "Notice kind").querySelector('[aria-pressed="true"]')?.getAttribute("href"),
    ).toBe("/projects/project/attention?q=timed+out");
    expect(text).toContain("Showing 26–26 of 30");
    const newer = [...section(root, "Notice pages").querySelectorAll("a")].find(
      (link) => link.textContent === "← Newer",
    );
    expect(newer?.getAttribute("href")).toBe(
      "/projects/project/attention?kind=turn_error&q=timed+out",
    );
    expect(root.querySelector('a[href="/projects/project/attention"]')?.textContent).toBe(
      "Clear filters",
    );
  });

  it("reads resolved notices by how they closed, with no actions on them", async () => {
    mocks.attention = {
      ok: true,
      data: {
        ...openPage(),
        total: 1,
        items: [
          {
            ...openPage().items[1],
            status: "resolved",
            resolution: "dismissed",
            resolvedAt: minutesAgo(5),
            action: null,
          } as ProjectAttention["items"][number],
        ],
      },
    };
    const { root, text } = await render({ status: "resolved" });
    expect(mocks.queries[0]).toMatchObject({ status: "resolved" });
    expect(mocks.overviewCalls).toBe(0);
    expect(section(root, "Notice status").querySelector('[aria-current="page"]')?.textContent).toBe(
      "Resolved7",
    );
    expect(text).toContain("Dismissed 5 min ago");
    expect(section(root, "Notices").querySelector("button")).toBeNull();
    expect(root.querySelector('a[href="/projects/project/stories/story-failed"]')).not.toBeNull();
  });

  it("hides reply, retry and dismiss from members who cannot run agents", async () => {
    mocks.permissions = ["projects:read"];
    const { root, text } = await render();
    expect(section(root, "Notices").querySelector("button")).toBeNull();
    expect(section(root, "Also waiting on you").querySelector("button")).toBeNull();
    expect(text).toContain("Reply in the story");
  });

  it("says plainly when nothing is open, and when filters match nothing", async () => {
    mocks.attention = {
      ok: true,
      data: {
        ...openPage(),
        total: 0,
        counts: { open: 0, resolved: 3 },
        facets: { kinds: [] },
        items: [],
      },
    };
    mocks.overview = {
      ok: true,
      data: { ...overviewWithSignals(), review: { total: 0, items: [] } },
    };
    const quiet = await render();
    expect(quiet.text).toContain("No open notices · 3 resolved");
    expect(quiet.text).toContain("No open notices. When an agent asks a question");
    expect(quiet.root.querySelector('[aria-label="Also waiting on you"]')).toBeNull();

    const filtered = await render({ q: "nothing like this" });
    expect(filtered.text).toContain("Nothing matches these filters.");
    expect(filtered.root.querySelector('a[href="/projects/project/attention"]')?.textContent).toBe(
      "Clear filters",
    );
  });

  it("points back to the newest notices when handling them emptied the page", async () => {
    mocks.attention = {
      ok: true,
      data: { ...openPage(), total: 25, offset: 25, items: [] },
    };
    const { root, text } = await render({ page: "2" });
    expect(text).toContain("No notices left on this page.");
    expect(text).not.toContain("No open notices. When an agent asks a question");
    const back = [...section(root, "Notices").querySelectorAll("a")].find(
      (link) => link.textContent === "Back to the newest",
    );
    expect(back?.getAttribute("href")).toBe("/projects/project/attention");
  });

  it("reports a failed load without inventing notices", async () => {
    mocks.attention = { ok: false, status: 500, offline: false, message: "boom" };
    const { root, text } = await render();
    expect(text).toContain("Couldn't load the notices — boom");
    expect(section(root, "Notices").querySelector("article")).toBeNull();
    expect(root.querySelector('[aria-label="Notice status"]')).toBeNull();
  });
});
