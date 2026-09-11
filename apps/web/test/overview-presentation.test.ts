import { describe, expect, it } from "vitest";
import type { OverviewReviewItem, ProjectOverview } from "../lib/api";
import {
  activitySummary,
  attentionQueue,
  budgetReading,
  environmentsLine,
  relativeTime,
  reviewState,
  spendReading,
  storySource,
  turnResult,
} from "../lib/overview-presentation";

const now = new Date("2026-09-10T12:00:00Z");
const turn = (state: "queued" | "running", agentName = "builder") =>
  ({ turnId: `turn-${state}`, agentName, state }) as ProjectOverview["activity"]["running"][number];
const review = (
  overrides: Partial<OverviewReviewItem["pullRequest"]>,
  storyId: string | null = "s1",
) =>
  ({
    source: "mirror",
    storyId,
    storyTitle: storyId ? "Story" : null,
    storyStatus: storyId ? "working" : null,
    activeAgentName: null,
    pullRequest: {
      number: 42,
      title: "Change",
      url: "https://github.com/acme/app/pull/42",
      repository: "acme/app",
      draft: false,
      ciState: null,
      ciFailureNames: [],
      updatedAt: "2026-09-10T11:00:00Z",
      ...overrides,
    },
  }) as OverviewReviewItem;
const noSpend: ProjectOverview["spend"] = {
  agents: { available: false, reason: "permission" },
  budget: { available: false, reason: "permission" },
};

describe("overview activity", () => {
  it("only counts a running turn as an executing agent", () => {
    expect(activitySummary({ running: [], queued: [] })).toEqual({
      label: "No agent running",
      active: false,
    });
    expect(activitySummary({ running: [], queued: [turn("queued")] })).toEqual({
      label: "1 queued",
      active: false,
    });
    expect(
      activitySummary({
        running: [turn("running"), turn("running", "architect")],
        queued: [turn("queued")],
      }),
    ).toEqual({ label: "2 agents running · 1 queued", active: true });
  });
  it("formats relative and future times", () => {
    expect(relativeTime("2026-09-10T11:48:00Z", now)).toBe("12 min ago");
    expect(relativeTime("2026-09-10T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-09-05T09:00:00Z", now)).toBe("5 d ago");
    expect(relativeTime("2026-09-10T12:30:00Z", now)).toBe("in 30 min");
    expect(relativeTime("not a date", now)).toBe("unknown time");
  });
});

describe("attention queue", () => {
  it("orders facility notices before failing checks and budget alerts, with the right action", () => {
    const queue = attentionQueue(
      {
        attention: {
          openCount: 2,
          items: [
            {
              id: "a1",
              storyId: "s1",
              storyTitle: "Story one",
              storyStatus: "attention",
              turnId: null,
              kind: "agent_waiting",
              title: "builder needs a reply",
              detail: "Which database?",
              createdAt: "2026-09-10T11:00:00Z",
              action: "reply",
            },
            {
              id: "a2",
              storyId: "s2",
              storyTitle: "Story two",
              storyStatus: "attention",
              turnId: "t2",
              kind: "turn_error",
              title: "builder failed",
              detail: "Error: fetch failed",
              createdAt: "2026-09-10T10:00:00Z",
              action: "retry",
            },
          ],
        },
        review: {
          total: 2,
          items: [
            review({ ciState: "failure", ciFailureNames: ["verify"] }),
            review({ ciState: "success", number: 43 }, null),
          ],
        },
        spend: {
          agents: { available: false, reason: "permission" },
          budget: {
            available: true,
            state: "exceeded",
            enabled: true,
            monthlyLimitCents: 1000,
            warningPercent: 80,
            windowStart: "2026-09-01T00:00:00Z",
            windowEnd: "2026-10-01T00:00:00Z",
            spentCents: 1200,
            remainingCents: 0,
            percentUsed: 120,
          },
        },
      },
      "p1",
    );
    expect(queue.map((entry) => entry.key)).toEqual([
      "attention:a1",
      "attention:a2",
      "checks:acme/app:42",
      "budget",
    ]);
    expect(queue[0]).toMatchObject({
      tone: "human",
      title: "Agent waiting for a reply",
      summary: "Which database?",
      action: { label: "Reply in the story", href: "/projects/p1/stories/s1#story-composer" },
      detail: null,
    });
    expect(queue[1]).toMatchObject({
      tone: "bad",
      title: "Agent run failed",
      action: { label: "Open the story", href: "/projects/p1/stories/s2" },
      detail: "Error: fetch failed",
    });
    expect(queue[1]?.summary).toMatch(/could not connect/);
    expect(queue[2]).toMatchObject({
      tone: "bad",
      title: "Checks failed on pull request #42",
      action: {
        label: "Open the pull request",
        href: "https://github.com/acme/app/pull/42",
        external: true,
      },
    });
    expect(queue[2]?.summary).toContain("verify");
    expect(queue[3]).toMatchObject({
      tone: "bad",
      title: "Monthly budget exhausted: new agent turns are blocked",
      action: { href: "/projects/p1/insights" },
    });
    expect(queue[3]?.summary).toContain("$12.00 of $10.00");
  });
  it("is empty when nothing is open, whatever the resolved history holds", () => {
    expect(
      attentionQueue(
        {
          attention: { openCount: 0, items: [] },
          review: { total: 1, items: [review({ ciState: "success" })] },
          spend: noSpend,
        },
        "p1",
      ),
    ).toEqual([]);
  });
});

describe("review and result labels", () => {
  it("describes where a story came from in words", () => {
    expect(storySource({ provider: "github", externalId: "issue:17" })).toBe("GitHub issue #17");
    expect(storySource({ provider: "github", externalId: "pull-request:42" })).toBe(
      "GitHub pull request #42",
    );
    expect(storySource({ provider: "manual", externalId: "manual:abc" })).toBe("Manual story");
    expect(storySource({ provider: "schedule", externalId: "nightly" })).toBe("Scheduled story");
  });
  it("names the pull request state a reviewer cares about", () => {
    expect(reviewState(review({ draft: true, ciState: "failure" }))).toEqual({
      label: "Draft",
      tone: "machine",
    });
    expect(reviewState(review({ ciState: "failure" })).label).toBe("Checks failed");
    expect(reviewState(review({ ciState: "success" })).label).toBe("Ready for review");
    expect(reviewState(review({ ciState: "pending" })).label).toBe("Checks running");
    expect(reviewState(review({ ciState: null })).label).toBe("Checks unknown");
  });
  it("describes a finished turn by its outcome", () => {
    const base = { agentName: "builder" } as ProjectOverview["recent"]["items"][number];
    expect(turnResult({ ...base, state: "succeeded" })).toEqual({
      label: "builder finished",
      tone: "ok",
    });
    expect(turnResult({ ...base, state: "failed" })).toEqual({
      label: "builder failed",
      tone: "bad",
    });
    expect(turnResult({ ...base, state: "canceled" })).toEqual({
      label: "builder was canceled",
      tone: "machine",
    });
  });
});

describe("spend readings", () => {
  it("distinguishes a real zero, an unknown cost, a partial cost and a known cost", () => {
    expect(
      spendReading({
        turns: 0,
        pricedTurns: 0,
        unpricedTurns: 0,
        unmeasuredTurns: 0,
        costCents: 0,
      }),
    ).toEqual({
      kind: "none",
      amount: "$0.00",
      note: "no agent turns",
    });
    expect(
      spendReading({
        turns: 2,
        pricedTurns: 0,
        unpricedTurns: 2,
        unmeasuredTurns: 0,
        costCents: 0,
      }),
    ).toEqual({
      kind: "unknown",
      amount: "unknown",
      note: "2 turns without a price",
    });
    expect(
      spendReading({
        turns: 0,
        pricedTurns: 0,
        unpricedTurns: 0,
        unmeasuredTurns: 1,
        costCents: 0,
      }),
    ).toMatchObject({ kind: "unknown", note: "1 turn without a price" });
    expect(
      spendReading({
        turns: 3,
        pricedTurns: 2,
        unpricedTurns: 1,
        unmeasuredTurns: 1,
        costCents: 300,
      }),
    ).toEqual({
      kind: "partial",
      amount: "at least $3.00",
      note: "2 priced · 2 without a price",
    });
    expect(
      spendReading({
        turns: 1,
        pricedTurns: 1,
        unpricedTurns: 0,
        unmeasuredTurns: 0,
        costCents: 250,
      }),
    ).toEqual({
      kind: "known",
      amount: "$2.50",
      note: "1 priced turn",
    });
  });
  it("labels budget states and permission gaps honestly", () => {
    expect(budgetReading({ available: false, reason: "permission" }).label).toBe(
      "Not visible for your role",
    );
    const budget = (state: "not_configured" | "disabled" | "ok" | "warning" | "exceeded") =>
      ({ available: true, state }) as ProjectOverview["spend"]["budget"];
    expect(budgetReading(budget("not_configured")).label).toBe("No monthly budget");
    expect(budgetReading(budget("ok"))).toEqual({ label: "Within budget", tone: "ok" });
    expect(budgetReading(budget("warning")).tone).toBe("human");
    expect(budgetReading(budget("exceeded")).tone).toBe("bad");
  });
  it("reports recorded workspace states without claiming live inspection", () => {
    expect(
      environmentsLine({
        retained: 3,
        recorded: { creating: 0, running: 1, sleeping: 2, error: 0, deleting: 0 },
        lastActivityAt: null,
      }),
    ).toBe("3 retained · 1 recorded as running · 2 suspended");
    expect(
      environmentsLine({
        retained: 0,
        recorded: { creating: 0, running: 0, sleeping: 0, error: 0, deleting: 0 },
        lastActivityAt: null,
      }),
    ).toBe("No retained workspaces.");
  });
});
