import { describe, expect, it } from "vitest";
import type { BacklogItem, StoryAgent } from "../lib/api";
import {
  activityLine,
  agentChoices,
  parseStoriesSearch,
  relativeTime,
  startTarget,
  storiesHref,
  titleStatus,
  toBacklogQuery,
} from "../lib/backlog-presentation";

const now = new Date("2026-09-10T12:00:00Z");
const base = {
  key: "story:s1",
  kind: "story",
  title: "Add retry",
  titleSource: "generated",
  phase: "in_progress",
  reason: "started",
  activity: { state: "idle", agentName: null, engine: null, turnId: null, since: null },
  environment: { recordedState: "sleeping", lastActivityAt: null },
  attention: [],
  story: null,
  issue: null,
  pullRequest: null,
  labels: [],
  assignees: [],
  createdAt: "2026-09-10T11:00:00Z",
  lastActivityAt: "2026-09-10T11:30:00Z",
} as unknown as BacklogItem;

describe("backlog presentation", () => {
  it("describes real activity rather than the phase", () => {
    expect(activityLine(base, now)).toBe("No agent running · workspace suspended");
    expect(
      activityLine(
        {
          ...base,
          reason: "running",
          activity: {
            state: "running",
            agentName: "builder",
            engine: "codex",
            turnId: "turn_1",
            since: "2026-09-10T11:56:00Z",
          },
        },
        now,
      ),
    ).toBe("builder is running · 4m ago");
    expect(
      activityLine(
        { ...base, activity: { ...base.activity, state: "queued", agentName: "builder" } },
        now,
      ),
    ).toBe("builder is queued");
    expect(
      activityLine(
        {
          ...base,
          phase: "attention",
          reason: "attention",
          attention: [
            {
              id: "a",
              source: "facility",
              kind: "agent_waiting",
              title: "builder asked",
              turnId: null,
              createdAt: null,
            },
          ],
        },
        now,
      ),
    ).toBe("Waiting for your reply");
    expect(
      activityLine(
        {
          ...base,
          phase: "attention",
          reason: "checks_failing",
          pullRequest: {
            ciFailureNames: ["test", "lint"],
          } as unknown as BacklogItem["pullRequest"],
        },
        now,
      ),
    ).toBe("Checks failing: test, lint");
    expect(
      activityLine(
        {
          ...base,
          phase: "review",
          reason: "awaiting_review",
          pullRequest: {
            ciState: "success",
            ciFailureNames: [],
          } as unknown as BacklogItem["pullRequest"],
        },
        now,
      ),
    ).toBe("Awaiting review · checks passed");
    expect(
      activityLine({ ...base, phase: "in_progress", reason: "pull_request_closed" }, now),
    ).toBe("Pull request closed without merge");
    expect(activityLine({ ...base, phase: "done", reason: "issue_closed" }, now)).toBe(
      "Closed on GitHub",
    );
  });

  it("explains provisional titles without hiding the request", () => {
    expect(titleStatus({ titleSource: "pending", createdAt: "2026-09-10T11:59:00Z" }, now)).toBe(
      "Generating title…",
    );
    expect(titleStatus({ titleSource: "pending", createdAt: "2026-09-10T11:00:00Z" }, now)).toBe(
      "Title still generating; using your request",
    );
    expect(titleStatus({ titleSource: "fallback" }, now)).toBe("Title taken from your request");
    expect(titleStatus({ titleSource: "generated" }, now)).toBeNull();
    expect(titleStatus({ titleSource: "github" }, now)).toBeNull();
  });

  it("round-trips filters through the URL", () => {
    const search = parseStoriesSearch({
      q: " #42 ",
      phase: "attention,review",
      label: ["bug", "ui"],
      assignee: "me",
      sort: "updated",
      page: "3",
      start: "issue:repo:1",
    });
    expect(search).toEqual({
      q: "#42",
      phase: ["attention", "review"],
      label: ["bug", "ui"],
      assignee: ["me"],
      repository: [],
      sort: "updated",
      page: 3,
      start: "issue:repo:1",
    });
    expect(toBacklogQuery(search)).toEqual({
      q: "#42",
      phase: ["attention", "review"],
      label: ["bug", "ui"],
      assignee: ["me"],
      sort: "updated",
      limit: 50,
      offset: 100,
    });
    expect(storiesHref("proj", search, { page: 1 })).toBe(
      "/projects/proj/stories?q=%2342&phase=attention&phase=review&label=bug&label=ui&assignee=me&sort=updated",
    );
    expect(parseStoriesSearch({ sort: "bogus", page: "-1" })).toMatchObject({
      sort: "priority",
      page: 1,
    });
    expect(storiesHref("proj", parseStoriesSearch({}))).toBe("/projects/proj/stories");
  });

  it("offers only enabled agents with a ui trigger, default first, with engine and provider", () => {
    const agent = (name: string, engine: "claude_code" | "codex", enabled = true, trigger = "ui") =>
      ({
        name,
        description: `${name} agent`,
        engine,
        model: "m",
        enabled,
        triggers: [{ type: trigger }],
      }) as unknown as StoryAgent;
    const choices = agentChoices(
      [
        agent("zeta", "codex"),
        agent("builder", "claude_code"),
        agent("off", "codex", false),
        agent("mcp-only", "codex", true, "mcp"),
      ],
      "builder",
    );
    expect(choices.map((choice) => choice.name)).toEqual(["builder", "zeta"]);
    expect(choices[0]).toMatchObject({
      isDefault: true,
      engine: { brand: "claude", label: "Claude Code" },
      provider: { brand: "claude", label: "Anthropic" },
    });
    expect(choices[1]).toMatchObject({
      engine: { brand: "openai", label: "Codex" },
      provider: { brand: "openai", label: "OpenAI" },
    });
  });

  it("links the composer only to a not-started issue named in the URL", () => {
    const issue = {
      ...base,
      key: "issue:repo:7",
      kind: "issue",
      phase: "not_started",
      issue: {
        number: 7,
        repository: "acme/app",
        repositoryId: "repo",
        url: "https://github.com/acme/app/issues/7",
      },
    } as unknown as BacklogItem;
    expect(startTarget("issue:repo:7", [issue])?.key).toBe("issue:repo:7");
    expect(startTarget("issue:repo:8", [issue])).toBeNull();
    expect(startTarget("story:s1", [base])).toBeNull();
    expect(startTarget(undefined, [issue])).toBeNull();
  });

  it("formats relative time compactly", () => {
    expect(relativeTime("2026-09-10T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-09-10T11:30:00Z", now)).toBe("30m ago");
    expect(relativeTime("2026-09-09T12:00:00Z", now)).toBe("24h ago");
    expect(relativeTime("2026-09-01T12:00:00Z", now)).toBe("9d ago");
  });
});
