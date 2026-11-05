// @vitest-environment jsdom
import type { ProjectAttentionStories } from "@facility/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { currentCheckLabel, DeliveryReview } from "../components/attention/delivery-review";
import { ProjectConditions } from "../components/attention/project-conditions";

const delivery: NonNullable<ProjectAttentionStories["items"][number]["delivery"]> = {
  candidate: {
    revision: "a".repeat(64),
    state: "recorded",
    requiredCount: 2,
    mergedCount: 0,
    allRequiredMerged: false,
  },
  scopeRevision: 2,
  storyStatus: "review",
  waitingSince: "2026-11-05T12:00:00Z",
  pullRequests: [1, 2].map((number) => ({
    repository: `example/service-${number}`,
    number,
    url: `https://github.com/example/service-${number}/pull/${number}`,
    title: `Change in service ${number}`,
    required: true,
    primary: number === 1,
    state: "open",
    draft: false,
    headSha: (number === 1 ? "b" : "c").repeat(40),
    stale: false,
    checks: {
      state: number === 1 ? "success" : "failure",
      headSha: "b".repeat(40),
      current: number === 1,
      observedAt: "2026-11-05T12:00:00Z",
    },
  })),
  acceptance: {
    required: true,
    status: "stale",
    receipt: {
      id: "acceptance-1",
      revision: 1,
      candidateRevision: "d".repeat(64),
      confirmedAt: "2026-11-05T11:00:00Z",
      confirmedBy: { type: "user", id: "reviewer", name: "Reviewer" },
    },
  },
  preview: {
    state: "ready",
    desiredGeneration: "a".repeat(64),
    deployedGeneration: "d".repeat(64),
    observedAt: "2026-11-05T12:00:00Z",
  },
  acceptanceReady: false,
  blocked: {
    code: "workflow_preview_not_ready",
    message: "Wait for the preview of the complete current candidate before accepting it",
  },
};
const budget: ProjectAttentionStories["budget"] = {
  available: true,
  state: "exceeded",
  enabled: true,
  monthlyLimitCents: 5000,
  spentCents: 5000,
  remainingCents: 0,
  windowStart: "2026-11-01T00:00:00Z",
  windowEnd: "2026-12-01T00:00:00Z",
};
const policy = { available: true, error: null };

function root(markup: string) {
  const node = document.createElement("div");
  node.innerHTML = markup;
  return node;
}
describe("delivery observations in Attention", () => {
  it("keeps the full PR set, stale acceptance and served versus desired candidate distinguishable", () => {
    const node = root(
      renderToStaticMarkup(<DeliveryReview delivery={delivery} storyUrl="/projects/p/stories/s" />),
    );
    expect(node.querySelectorAll('ul[aria-label="Candidate pull requests"] > li')).toHaveLength(2);
    expect(node.textContent).toContain("Previous acceptance is no longer current");
    expect(node.textContent).toContain("Checks belong to another or unknown head");
    expect(node.textContent).toContain("serving the current candidate is not confirmed");
    expect(node.textContent).toContain("a".repeat(64));
    expect(node.textContent).toContain("d".repeat(64));
    expect(node.querySelector('a[href="/projects/p/stories/s#story-delivery"]')).not.toBeNull();
    expect(node.querySelectorAll("button")).toHaveLength(0);
  });
  it("does not turn missing or old checks into success, or candidate identity into approval", () => {
    const pull = delivery.pullRequests[0];
    if (!pull) throw new Error("Missing fixture pull");
    expect(currentCheckLabel({ ...pull, checks: { ...pull.checks, state: "unobserved" } })).toBe(
      "Checks not observed",
    );
    expect(currentCheckLabel({ ...pull, checks: { ...pull.checks, current: false } })).toContain(
      "another or unknown head",
    );
    const observed = structuredClone(delivery);
    observed.acceptance.status = "current";
    if (!delivery.preview) throw new Error("Missing preview fixture");
    observed.preview = { ...delivery.preview, state: "suspended" };
    const node = root(
      renderToStaticMarkup(<DeliveryReview delivery={observed} storyUrl="/story" />),
    );
    expect(node.textContent).toContain("Accepted for the current candidate");
    expect(node.textContent).toContain("suspended");
    expect(node.textContent).toContain("merge and story completion remain separate");
  });
  it("does not render executable source URLs", () => {
    const observed = structuredClone(delivery);
    for (const pull of observed.pullRequests) pull.url = "javascript:alert(1)";
    const node = root(
      renderToStaticMarkup(<DeliveryReview delivery={observed} storyUrl="/story" />),
    );
    expect(node.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(node.textContent).toContain("link not observed");
  });
});
describe("project limits in Attention", () => {
  it("presents one project blocker and distinguishes a warning from blocked admission", () => {
    const blocked = root(
      renderToStaticMarkup(
        <ProjectConditions data={{ budget, workflowPolicy: policy }} base="/projects/p" />,
      ),
    );
    expect(blocked.textContent).toContain("Now · project limits");
    expect(blocked.querySelectorAll('a[href="/projects/p/insights"]')).toHaveLength(1);
    const warning = root(
      renderToStaticMarkup(
        <ProjectConditions
          data={{ budget: { ...budget, state: "warning" }, workflowPolicy: policy }}
          base="/projects/p"
        />,
      ),
    );
    expect(warning.textContent).toContain("does not by itself stop new work");
    expect(warning.textContent).not.toContain("Now ·");
  });
  it("does not invent a zero when budget is hidden or spending is unconfirmed", () => {
    const hidden = root(
      renderToStaticMarkup(
        <ProjectConditions
          data={{ budget: { available: false, reason: "permission" }, workflowPolicy: policy }}
          base="/project"
        />,
      ),
    );
    expect(hidden.textContent).toContain("not visible");
    expect(hidden.textContent).not.toContain("0");
    const unknown = root(
      renderToStaticMarkup(
        <ProjectConditions
          data={{
            budget: { ...budget, state: "unconfirmed", spentCents: 0 },
            workflowPolicy: policy,
          }}
          base="/project"
        />,
      ),
    );
    expect(unknown.textContent).toContain("Total spending is unconfirmed");
  });
});
