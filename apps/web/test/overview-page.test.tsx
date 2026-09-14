// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProjectOverviewPage from "../app/(app)/projects/[projectId]/page";
import type { ProjectOverview } from "../lib/api";

const mocks = vi.hoisted(() => ({
  overview: { ok: true, data: {} as ProjectOverview } as
    | { ok: true; data: ProjectOverview }
    | { ok: false; status: number; offline: boolean; message: string },
  permissions: ["*"] as string[],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../lib/api", () => ({
  api: {
    project: async () => ({
      ok: true,
      data: { id: "project", name: "Example project", description: null, slug: "example" },
    }),
    projectOverview: async () => mocks.overview,
    projectRepos: async () => ({
      ok: true,
      data: [{ id: "repo", owner: "acme", name: "app" }],
    }),
    me: async () => ({ ok: true, data: { permissions: mocks.permissions } }),
  },
}));

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function populated(): ProjectOverview {
  return {
    generatedAt: new Date().toISOString(),
    activity: {
      running: [
        {
          turnId: "turn-running",
          storyId: "story-running",
          storyTitle: "Running story",
          storyStatus: "working",
          agentName: "builder",
          engine: "codex",
          model: "gpt-5.5",
          triggerType: "github",
          state: "running",
          createdAt: minutesAgo(12),
          startedAt: minutesAgo(10),
          scheduledFor: null,
        },
      ],
      queued: [
        {
          turnId: "turn-queued",
          storyId: "story-queued",
          storyTitle: "Queued story",
          storyStatus: "working",
          agentName: "architect",
          engine: "claude_code",
          model: "claude-sonnet-5",
          triggerType: "schedule",
          state: "queued",
          createdAt: minutesAgo(3),
          startedAt: null,
          scheduledFor: null,
        },
      ],
    },
    attention: {
      openCount: 1,
      items: [
        {
          id: "attn-waiting",
          storyId: "story-waiting",
          storyTitle: "Waiting story",
          storyStatus: "attention",
          turnId: null,
          kind: "agent_waiting",
          title: "builder needs a reply",
          detail: "Which database should the migration target?",
          createdAt: minutesAgo(20),
          action: "reply",
        },
      ],
    },
    review: {
      total: 2,
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
            updatedAt: minutesAgo(80),
          },
        },
        {
          source: "mirror",
          storyId: null,
          storyTitle: null,
          storyStatus: null,
          activeAgentName: null,
          pullRequest: {
            number: 43,
            title: "Human-authored change",
            url: "https://github.com/acme/app/pull/43",
            repository: "acme/app",
            draft: false,
            ciState: "success",
            ciFailureNames: [],
            updatedAt: minutesAgo(10),
          },
        },
      ],
    },
    recent: {
      items: [
        {
          turnId: "turn-failed",
          storyId: "story-failed",
          storyTitle: "Failed story",
          storyStatus: "attention",
          agentName: "builder",
          state: "failed",
          triggerType: "ui",
          endedAt: minutesAgo(40),
          durationMs: 15 * 60_000,
          error: "Error: 401 unauthorized",
          pullRequest: null,
        },
        {
          turnId: "turn-succeeded",
          storyId: "story-review",
          storyTitle: "Review story",
          storyStatus: "working",
          agentName: "builder",
          state: "succeeded",
          triggerType: "mcp",
          endedAt: minutesAgo(90),
          durationMs: 35 * 60_000,
          error: null,
          pullRequest: { number: 42, url: "https://github.com/acme/app/pull/42" },
        },
      ],
    },
    backlog: {
      ready: [
        {
          storyId: "story-ready",
          title: "Ready story",
          status: "ready",
          provider: "manual",
          externalId: "manual:ready",
          branch: null,
          activeAgentName: null,
          pullRequestNumber: null,
          pullRequestUrl: null,
          updatedAt: minutesAgo(400),
        },
      ],
      counts: { ready: 1, working: 3, attention: 2, review: 0, done: 1, archived: 0 },
      openIssues: 2,
      openIssuesWithoutStory: 1,
    },
    environments: {
      retained: 2,
      recorded: { creating: 0, running: 1, sleeping: 1, error: 0, deleting: 0 },
      lastActivityAt: minutesAgo(1),
    },
    spend: {
      agents: {
        available: true,
        month: {
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-10-01T00:00:00.000Z",
          turns: 3,
          pricedTurns: 2,
          unpricedTurns: 1,
          unmeasuredTurns: 0,
          costCents: 300,
        },
        lastSevenDays: {
          from: minutesAgo(7 * 24 * 60),
          to: new Date().toISOString(),
          turns: 2,
          pricedTurns: 1,
          unpricedTurns: 1,
          unmeasuredTurns: 0,
          costCents: 250,
        },
        byAgent: [
          { agentName: "builder", turns: 2, unpricedTurns: 0, costCents: 300 },
          { agentName: "reviewer", turns: 1, unpricedTurns: 1, costCents: 0 },
        ],
      },
      budget: {
        available: true,
        state: "warning",
        enabled: true,
        monthlyLimitCents: 1_000,
        warningPercent: 25,
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-10-01T00:00:00.000Z",
        spentCents: 300,
        remainingCents: 700,
        percentUsed: 30,
      },
    },
  };
}

async function render() {
  const html = renderToStaticMarkup(
    await ProjectOverviewPage({ params: Promise.resolve({ projectId: "project" }) }),
  );
  const root = document.createElement("div");
  root.innerHTML = html;
  return { html, root, text: root.textContent ?? "" };
}

function section(root: HTMLElement, label: string) {
  const element = root.querySelector(`[aria-label="${label}"]`);
  if (!element) throw new Error(`missing section ${label}`);
  return element;
}

describe("project overview page", () => {
  it("shows executing agents, attention with actions, review, results, backlog and spend", async () => {
    mocks.overview = { ok: true, data: populated() };
    mocks.permissions = ["*"];
    const { root, text } = await render();
    expect(text).toContain("1 agent running · 1 queued");
    expect(text).toContain(
      "3 items need your attention · 2 pull requests waiting for review · 1 story ready to start",
    );

    const attention = section(root, "Needs your attention");
    expect(attention.textContent).toContain("Needs your attention · 3");
    expect(attention.textContent).toContain("Agent waiting for a reply");
    expect(attention.textContent).toContain("Which database should the migration target?");
    expect(
      attention.querySelector('a[href="/projects/project/stories/story-waiting#story-composer"]'),
    ).not.toBeNull();
    expect(attention.textContent).toContain("Checks failed on pull request #42");
    expect(attention.querySelector('a[href="https://github.com/acme/app/pull/42"]')).not.toBeNull();
    expect(attention.textContent).toContain("Monthly budget warning");
    expect(attention.querySelector("button")?.textContent).toContain("dismiss");
    expect(attention.textContent).not.toContain("Reply below");

    const running = section(root, "Running now");
    expect(running.textContent).toContain("builder");
    expect(running.textContent).toContain("running for 10 min");
    expect(running.textContent).toContain("from GitHub");
    expect(running.textContent).toContain("architect");
    expect(running.textContent).toContain("queued 3 min ago");
    expect(
      running.querySelector('a[href="/projects/project/stories/story-running"]'),
    ).not.toBeNull();
    expect(running.textContent).toContain("cancel turn");

    const review = section(root, "Waiting for review");
    expect(review.textContent).toContain("Checks failed");
    expect(review.textContent).toContain("Ready for review");
    expect(review.textContent).toContain("no Facility story");
    expect(review.querySelector('a[href="/projects/project/stories/story-review"]')).not.toBeNull();

    const recent = section(root, "Recent results");
    expect(recent.textContent).toContain("builder failed");
    expect(recent.textContent).toContain("rejected authentication");
    expect(recent.textContent).toContain("builder finished");
    expect(recent.textContent).toContain("Pull request #42");
    expect(
      recent.querySelector('a[href="/projects/project/stories/story-failed#run-turn-failed"]'),
    ).not.toBeNull();

    const backlog = section(root, "Backlog");
    expect(backlog.textContent).toContain("1 of 2 open GitHub issues have no story yet");
    expect(backlog.querySelector('a[href="/projects/project/stories/story-ready"]')).not.toBeNull();
    expect(backlog.textContent).toContain("Manual story");
    expect(backlog.textContent).not.toContain("manual:manual");

    const spend = section(root, "Spend and environments");
    expect(spend.textContent).toContain("at least $3.00");
    expect(spend.textContent).toContain("2 priced · 1 without a price");
    expect(spend.textContent).toContain("September 2026");
    expect(spend.textContent).toContain("$3.00 of $10.00 · 30%");
    expect(spend.textContent).toContain("2 retained · 1 recorded as running · 1 suspended");
    expect(spend.textContent).toContain("not inspected now");
    expect(spend.querySelector('a[href="/projects/project/insights"]')).not.toBeNull();

    expect(text).not.toContain("runtime model");
    expect(text).not.toContain("agent model");
  });

  it("hides write actions for read-only members and spend for roles without cost access", async () => {
    const data = populated();
    data.spend = {
      agents: { available: false, reason: "permission" },
      budget: { available: false, reason: "permission" },
    };
    mocks.overview = { ok: true, data };
    mocks.permissions = ["projects:read"];
    const { root, text } = await render();
    expect(root.querySelector("button")).toBeNull();
    expect(text).not.toContain("cancel turn");
    expect(text).toContain("Not visible for your role");
    expect(text).not.toContain("Monthly budget warning");
  });

  it("renders honest empty states for a quiet project", async () => {
    const data = populated();
    data.activity = { running: [], queued: [] };
    data.attention = { openCount: 0, items: [] };
    data.review = { total: 0, items: [] };
    data.recent = { items: [] };
    data.backlog = {
      ready: [],
      counts: { ready: 0, working: 0, attention: 0, review: 0, done: 0, archived: 0 },
      openIssues: 0,
      openIssuesWithoutStory: 0,
    };
    data.environments = {
      retained: 0,
      recorded: { creating: 0, running: 0, sleeping: 0, error: 0, deleting: 0 },
      lastActivityAt: null,
    };
    const empty = {
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-10-01T00:00:00.000Z",
      turns: 0,
      pricedTurns: 0,
      unpricedTurns: 0,
      unmeasuredTurns: 0,
      costCents: 0,
    };
    data.spend = {
      agents: { available: true, month: empty, lastSevenDays: empty, byAgent: [] },
      budget: {
        available: true,
        state: "not_configured",
        enabled: false,
        monthlyLimitCents: null,
        warningPercent: null,
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-10-01T00:00:00.000Z",
        spentCents: 0,
        remainingCents: null,
        percentUsed: null,
      },
    };
    mocks.overview = { ok: true, data };
    mocks.permissions = ["*"];
    const { text } = await render();
    expect(text).toContain("No agent running");
    expect(text).toContain("Nothing is waiting on you right now.");
    expect(text).toContain("No agent is running.");
    expect(text).not.toContain("waiting for a person");
    expect(text).toContain("No open pull requests are linked to this project.");
    expect(text).toContain("No agent run has finished yet.");
    expect(text).toContain("No story is waiting to start.");
    expect(text).toContain("$0.00");
    expect(text).toContain("no agent turns");
    expect(text).toContain("No monthly budget");
    expect(text).toContain("No retained workspaces.");
  });

  it("keeps the project header and reports an overview error without faking data", async () => {
    mocks.overview = { ok: false, status: 500, offline: false, message: "boom" };
    const { text, root } = await render();
    expect(text).toContain("Example project");
    expect(text).toContain("Couldn't load the overview — boom");
    expect(root.querySelector('[aria-label="Running now"]')).toBeNull();
  });
});
