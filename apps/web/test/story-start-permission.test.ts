import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ProjectStoriesPage from "../app/(app)/projects/[projectId]/stories/page";

const fixture = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock("@/lib/api", () => ({
  api: {
    projectBacklog: async () => ({
      ok: true,
      data: {
        items: [],
        total: 0,
        counts: { not_started: 0, in_progress: 0, attention: 0, review: 0, done: 0, archived: 0 },
        facets: { labels: [], assignees: [], repositories: [], unassigned: 0 },
      },
    }),
    storyAgents: async () => ({
      ok: true,
      data: {
        agents: [{ name: "builder", enabled: true, engine: "codex", triggers: [{ type: "ui" }] }],
        defaults: { ui: "builder" },
        title_generation: false,
      },
    }),
    me: async () => ({
      ok: true,
      data: { permissions: fixture.permissions, principal: { id: "viewer" } },
    }),
  },
}));
vi.mock("@/components/story/new-story", () => ({
  NewStory: () => "START_STORY",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/components/shell/live-refresh", () => ({ LiveRefresh: () => null }));

describe("story creation permission", () => {
  beforeEach(() => {
    fixture.permissions = [];
  });
  it.each([
    "workspaces:execute",
    "workspaces:*",
    "*",
  ])("shows creation for %s", async (permission) => {
    fixture.permissions = [permission];
    expect(await render()).toContain("START_STORY");
  });
  it.each([
    "projects:read",
    "projects:write",
    "runs:execute",
  ])("does not use %s to offer execution", async (permission) => {
    fixture.permissions = [permission];
    expect(await render()).not.toContain("START_STORY");
  });
});

async function render() {
  return renderToStaticMarkup(
    await ProjectStoriesPage({
      params: Promise.resolve({ projectId: "project" }),
      searchParams: Promise.resolve({}),
    }),
  );
}
