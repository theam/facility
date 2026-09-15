// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StoriesPage from "../app/(app)/projects/[projectId]/stories/page";
import type { ProjectBacklog } from "../lib/api";

const mocks = vi.hoisted(() => ({
  backlog: { ok: true, data: {} } as
    | { ok: true; data: ProjectBacklog }
    | { ok: false; status: number; offline: boolean; message: string },
  permissions: ["*"] as string[],
  agents: {
    ok: true,
    data: {
      agents: [
        {
          name: "builder",
          description: "Implements the request.",
          engine: "codex",
          model: "gpt-5.5",
          enabled: true,
          triggers: [{ type: "ui" }],
        },
        {
          name: "architect",
          description: "Plans first.",
          engine: "claude_code",
          model: "claude-sonnet-5",
          enabled: true,
          triggers: [{ type: "ui" }],
        },
      ],
      defaults: { ui: "builder", mcp: "builder", manual: "builder" },
      title_generation: true,
    },
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, push() {} }),
  redirect(url: string) {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("../lib/api", () => ({
  api: {
    projectBacklog: async () => mocks.backlog,
    storyAgents: async () => mocks.agents,
    me: async () => ({
      ok: true,
      data: {
        permissions: mocks.permissions,
        principal: { id: "user_1", userId: "user_1", githubLogin: "ana" },
      },
    }),
  },
}));

function item(
  overrides: Partial<ProjectBacklog["items"][number]>,
): ProjectBacklog["items"][number] {
  return {
    key: "story:s1",
    kind: "story",
    title: "Add retry to the sync job",
    titleSource: "generated",
    phase: "in_progress",
    reason: "running",
    activity: {
      state: "running",
      agentName: "builder",
      engine: "codex",
      turnId: "turn_1",
      since: "2026-09-10T11:50:00Z",
    },
    environment: { recordedState: "running", lastActivityAt: null },
    attention: [],
    story: {
      id: "s1",
      status: "working",
      provider: "github",
      externalId: "issue:42",
      branch: "feature/retry",
      activeAgentName: "builder",
      createdAt: "2026-09-10T11:00:00Z",
      updatedAt: "2026-09-10T11:50:00Z",
    },
    issue: {
      repository: "acme/app",
      repositoryId: "repo",
      number: 42,
      url: "https://github.com/acme/app/issues/42",
      state: "open",
      labels: ["bug"],
      author: "ana",
      createdAt: null,
      updatedAt: "2026-09-10T11:00:00Z",
      closedAt: null,
      syncedAt: "2026-09-10T11:55:00Z",
      stale: false,
    },
    pullRequest: null,
    labels: ["bug"],
    assignees: [
      { key: "github:ben", login: "ben", name: null, avatarUrl: null, sources: ["github"] },
    ],
    createdAt: "2026-09-10T11:00:00Z",
    lastActivityAt: "2026-09-10T11:50:00Z",
    ...overrides,
  };
}

function backlog(
  items: ProjectBacklog["items"],
  overrides: Partial<ProjectBacklog> = {},
): ProjectBacklog {
  const counts = { not_started: 0, in_progress: 0, attention: 0, review: 0, done: 0, archived: 0 };
  for (const entry of items) counts[entry.phase] += 1;
  return {
    generatedAt: "2026-09-10T12:00:00Z",
    total: items.length,
    limit: 50,
    offset: 0,
    counts,
    items,
    facets: {
      labels: [{ name: "bug", count: 1 }],
      assignees: [
        {
          key: "github:ben",
          login: "ben",
          name: null,
          avatarUrl: null,
          sources: ["github"],
          count: 1,
        },
      ],
      unassigned: 1,
      repositories: [{ id: "repo", name: "acme/app", count: 2 }],
    },
    ...overrides,
  };
}

async function render(search: Record<string, string | string[]> = {}) {
  const html = renderToStaticMarkup(
    await StoriesPage({
      params: Promise.resolve({ projectId: "proj" }),
      searchParams: Promise.resolve(search),
    }),
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  return { html, root, text: root.textContent ?? "" };
}

describe("stories backlog page", () => {
  beforeEach(() => {
    mocks.permissions = ["*"];
  });

  it("groups open work by phase with identifiers, people, activity and links", async () => {
    mocks.backlog = {
      ok: true,
      data: backlog([
        item({
          key: "story:s2",
          phase: "attention",
          reason: "checks_failing",
          activity: { state: "idle", agentName: null, engine: null, turnId: null, since: null },
          story: { ...(item({}).story as NonNullable<ReturnType<typeof item>["story"]>), id: "s2" },
          pullRequest: {
            number: 7,
            title: "PR",
            url: "https://github.com/acme/app/pull/7",
            repository: "acme/app",
            state: "open",
            draft: false,
            ciState: "failure",
            ciFailureNames: ["test"],
            reviewState: null,
            headRef: "feature/retry",
            author: "ana",
            updatedAt: "2026-09-10T11:00:00Z",
          },
        }),
        item({}),
        item({
          key: "issue:repo:43",
          kind: "issue",
          phase: "not_started",
          reason: "issue_open",
          titleSource: "github",
          title: "Nobody started this",
          activity: { state: "idle", agentName: null, engine: null, turnId: null, since: null },
          story: null,
          issue: {
            ...(item({}).issue as NonNullable<ReturnType<typeof item>["issue"]>),
            number: 43,
            url: "https://github.com/acme/app/issues/43",
          },
          assignees: [],
        }),
      ]),
    };
    const { root, text } = await render();
    const headings = [...root.querySelectorAll("h3")].map((node) => node.textContent);
    expect(headings.join(" ")).toMatch(/Needs attention.*In progress.*Not started/);
    expect(text).toContain("Checks failing: test");
    expect(text).toContain("builder is running");
    expect(text).toContain("acme/app#42");
    expect(root.querySelector('a[href="/projects/proj/stories/s1"]')).not.toBeNull();
    expect(root.querySelector('a[href="/projects/proj/stories/s1#run-turn_1"]')).not.toBeNull();
    expect(root.querySelector('a[href="https://github.com/acme/app/pull/7"]')).not.toBeNull();
    expect(root.querySelector('a[href="https://github.com/acme/app/issues/43"]')).not.toBeNull();
    expect(text).toContain("@ben");
    expect(text).toContain("Unassigned");
    const start = [...root.querySelectorAll("a")].find((node) => node.textContent === "Start");
    expect(start?.getAttribute("href")).toContain("start=issue%3Arepo%3A43");
    expect(text).toContain("1 need attention");
    expect(text).toContain("Showing 1–3 of 3");
    expect(
      root.querySelector('form[aria-label="Filter the backlog"] input[name="q"]'),
    ).not.toBeNull();
    expect(root.querySelector("form#new-story textarea")).not.toBeNull();
    expect(text).toContain("Facility names the story from your request");
  });

  it("hides the composer and start actions without execute permission", async () => {
    mocks.permissions = ["projects:read"];
    mocks.backlog = {
      ok: true,
      data: backlog([
        item({
          key: "issue:repo:43",
          kind: "issue",
          phase: "not_started",
          reason: "issue_open",
          story: null,
        }),
      ]),
    };
    const { root, text } = await render();
    expect(root.querySelector("form#new-story")).toBeNull();
    expect([...root.querySelectorAll("a")].some((node) => node.textContent === "Start")).toBe(
      false,
    );
    expect(text).not.toContain("Sync GitHub");
  });

  it("links the composer to the issue named in the URL", async () => {
    mocks.backlog = {
      ok: true,
      data: backlog([
        item({
          key: "issue:repo:43",
          kind: "issue",
          phase: "not_started",
          reason: "issue_open",
          story: null,
          title: "Nobody started this",
        }),
      ]),
    };
    const { text } = await render({ start: "issue:repo:43" });
    expect(text).toContain("Start work on #42");
    expect(text).toContain("The story keeps the issue's title");
  });

  it("paginates and keeps filters in the page links", async () => {
    mocks.backlog = { ok: true, data: backlog([item({})], { total: 120, offset: 50 }) };
    const { root, text } = await render({ page: "2", label: "bug", sort: "updated" });
    expect(text).toContain("Showing 51–51 of 120");
    const links = [...root.querySelectorAll("a")];
    expect(links.find((node) => node.textContent?.includes("Newer"))?.getAttribute("href")).toBe(
      "/projects/proj/stories?label=bug&sort=updated",
    );
    expect(links.find((node) => node.textContent?.includes("Older"))?.getAttribute("href")).toBe(
      "/projects/proj/stories?label=bug&sort=updated&page=3",
    );
    expect(text).toContain("Clear 2 filters");
  });

  it("shows honest empty, filtered-empty, and error states", async () => {
    mocks.backlog = { ok: true, data: backlog([]) };
    expect((await render()).text).toContain("No work here yet");
    mocks.backlog = {
      ok: true,
      data: backlog([], {
        counts: { not_started: 3, in_progress: 0, attention: 0, review: 0, done: 0, archived: 0 },
      }),
    };
    expect((await render({ q: "zzz" })).text).toContain("Nothing matches these filters");
    mocks.backlog = { ok: false, status: 500, offline: false, message: "boom" };
    expect((await render()).text).toContain("Couldn't load the backlog — boom");
    mocks.backlog = { ok: false, status: 0, offline: true, message: "down" };
    expect((await render()).text).toContain("control plane unreachable");
  });
});
