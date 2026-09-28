import { describe, expect, it } from "vitest";
import type { OverviewReviewItem, ProjectOverview } from "../lib/api";
import {
  activitySummary,
  attentionNotice,
  budgetReading,
  environmentsLine,
  insightsSpendReading,
  latestAttention,
  relativeTime,
  resolutionLabel,
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

const notice = (
  id: string,
  createdAt: string,
  overrides: Partial<ProjectOverview["attention"]["items"][number]> = {},
): ProjectOverview["attention"]["items"][number] => ({
  id,
  storyId: `story-${id}`,
  storyTitle: `Story ${id}`,
  storyStatus: "attention",
  turnId: `turn-${id}`,
  kind: "turn_error",
  title: "builder failed",
  detail: "Error: fetch failed",
  createdAt,
  action: "retry",
  ...overrides,
});
const exceeded: ProjectOverview["spend"] = {
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
};

describe("latest attention", () => {
  it("leads with a blocking budget, then the newest notices and failing checks, each with its verb", () => {
    const { entries, total } = latestAttention(
      {
        attention: {
          openCount: 2,
          items: [
            notice("a1", "2026-09-10T11:00:00Z", {
              turnId: null,
              kind: "agent_waiting",
              title: "builder needs a reply",
              detail: "Which database?",
              action: "reply",
            }),
            notice("a2", "2026-09-10T10:00:00Z"),
          ],
        },
        review: {
          total: 2,
          items: [
            review({
              ciState: "failure",
              ciFailureNames: ["verify"],
              updatedAt: "2026-09-10T10:30:00Z",
            }),
            review({ ciState: "success", number: 43 }, null),
          ],
        },
        spend: exceeded,
      },
      "p1",
    );
    expect(total).toBe(4);
    expect(entries.map((entry) => entry.key)).toEqual([
      "budget",
      "attention:a1",
      "checks:acme/app:42",
      "attention:a2",
    ]);
    expect(entries[0]).toMatchObject({
      tone: "bad",
      title: "Monthly budget exhausted: new agent turns are blocked",
      action: { href: "/projects/p1/insights" },
    });
    expect(entries[0]?.summary).toContain("$12.00 of $10.00");
    expect(entries[1]).toMatchObject({
      tone: "human",
      title: "Agent waiting for a reply",
      summary: "Which database?",
      action: { label: "Reply in the story", href: "/projects/p1/stories/story-a1#story-composer" },
      detail: null,
      resolved: null,
    });
    expect(entries[1]?.item?.id).toBe("a1");
    expect(entries[2]).toMatchObject({
      tone: "bad",
      title: "Checks failed on pull request #42",
      action: {
        label: "Open the pull request",
        href: "https://github.com/acme/app/pull/42",
        external: true,
      },
      item: null,
    });
    expect(entries[2]?.summary).toContain("verify");
    expect(entries[3]).toMatchObject({
      tone: "bad",
      title: "Agent run failed",
      action: { label: "Open the story", href: "/projects/p1/stories/story-a2" },
      detail: "Error: fetch failed",
    });
    expect(entries[3]?.summary).toMatch(/could not connect/);
  });

  it("shows only the newest few but counts every open notice, not just the loaded ones", () => {
    const items = Array.from({ length: 8 }, (_, index) =>
      notice(`n${index}`, new Date(Date.UTC(2026, 8, 10, 11, 0) - index * 60_000).toISOString()),
    );
    const { entries, total } = latestAttention(
      {
        attention: { openCount: 31, items },
        review: { total: 0, items: [] },
        spend: noSpend,
      },
      "p1",
    );
    expect(entries.map((entry) => entry.key)).toEqual([
      "attention:n0",
      "attention:n1",
      "attention:n2",
      "attention:n3",
      "attention:n4",
    ]);
    expect(total).toBe(31);
    expect(
      latestAttention(
        { attention: { openCount: 31, items }, review: { total: 0, items: [] }, spend: noSpend },
        "p1",
        2,
      ).entries,
    ).toHaveLength(2);
  });

  it("is empty when nothing is open, whatever the resolved history holds", () => {
    expect(
      latestAttention(
        {
          attention: { openCount: 0, items: [] },
          review: { total: 1, items: [review({ ciState: "success" })] },
          spend: noSpend,
        },
        "p1",
      ),
    ).toEqual({ entries: [], total: 0 });
  });

  it("describes a resolved notice by how it closed and offers no reply, retry or dismiss", () => {
    const entry = attentionNotice(
      {
        ...notice("r1", "2026-09-10T09:00:00Z", { kind: "agent_waiting", turnId: null }),
        action: null,
        status: "resolved",
        resolution: "replied",
        resolvedAt: "2026-09-10T11:55:00Z",
      },
      "p1",
    );
    expect(entry).toMatchObject({
      tone: "machine",
      item: null,
      action: { label: "Open the story", href: "/projects/p1/stories/story-r1" },
      resolved: { label: "Answered", at: "2026-09-10T11:55:00Z" },
    });
    expect(resolutionLabel("dismissed")).toBe("Dismissed");
    expect(resolutionLabel("successful_retry")).toBe("Retried successfully");
    expect(resolutionLabel(null)).toBe("Resolved");
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

describe("insights cost coverage", () => {
  const reading = (
    succeeded: number,
    failed: number,
    canceled: number,
    measured: number,
    unpriced: number,
  ) =>
    insightsSpendReading({
      turns: {
        total: succeeded + failed + canceled + 2,
        queued: 1,
        running: 1,
        succeeded,
        failed,
        canceled,
        successRate: null,
      },
      usage: {
        turns: measured,
        unpricedTurns: unpriced,
        costCents: 125,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
      },
    });
  it("labels partial totals when completed turns did not report usage", () => {
    expect(reading(1, 2, 1, 1, 0)).toMatchObject({
      kind: "partial",
      amount: "at least $1.25",
      note: "1 priced · 3 without a price",
    });
  });
  it("does not count queued or running turns as missing completed usage", () => {
    expect(reading(1, 0, 0, 1, 0)).toMatchObject({ kind: "known", amount: "$1.25" });
  });
  it("combines unpriced measurements with missing usage without double counting", () => {
    expect(reading(2, 1, 0, 2, 1)).toMatchObject({ note: "1 priced · 2 without a price" });
  });
  it("does not present wholly unmeasured work as zero cost", () => {
    expect(reading(0, 1, 0, 0, 0)).toMatchObject({ kind: "unknown", amount: "unknown" });
  });
  it("keeps coverage nonnegative when measurements span a period boundary", () => {
    expect(reading(0, 0, 0, 1, 0)).toMatchObject({ kind: "known" });
  });
});
