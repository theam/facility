// @vitest-environment jsdom
import type { StoryWorkflowStatus } from "@facility/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlanExecutionScope } from "../components/story/plan-execution-scope";

function scope(): NonNullable<StoryWorkflowStatus["executionScope"]> {
  return {
    observedAt: "2026-11-05T10:00:00Z",
    planRevision: 2,
    repositories: { matches: false, connectedCount: 2, missing: ["example/api"], removed: [] },
    queuedWork: [
      {
        turnId: "retained-turn",
        agentName: "architect",
        engine: "codex",
        model: "fixture-model",
        manifestHash: "a".repeat(64),
        createdAt: "2026-11-05T09:00:00Z",
        configuration: "current",
        planAgent: "missing",
      },
    ],
    hasMore: false,
  };
}
function render(value: StoryWorkflowStatus["executionScope"], revision = 2) {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <PlanExecutionScope scope={value} planRevision={revision} />,
  );
  return container;
}

describe("execution scope presentation", () => {
  it("shows missing scope and identifies the existing turn without suggesting that approval starts a new request", () => {
    const container = render(scope());
    expect(container.textContent).toContain("Not covered: example/api");
    expect(container.textContent).toContain("architect · Codex · fixture-model");
    expect(container.textContent).toContain("retained agent is missing from the plan");
    expect(container.textContent).toContain("not execution authorization");
    const evidence = container.querySelector("details");
    expect(evidence?.open).toBe(false);
    expect(evidence?.textContent).toContain("retained-turn");
    expect(evidence?.textContent).toContain("a".repeat(64));
    expect(container.querySelector("button")).toBeNull();
  });
  it("keeps multiple turns compact but discloses mismatches and a truncated queue before expansion", () => {
    const value = scope();
    const first = value.queuedWork[0];
    if (!first) throw Error("Missing fixture turn");
    value.queuedWork = [
      { ...first, planAgent: "current", configuration: "changed" },
      { ...first, turnId: "second-turn", configuration: "unavailable" },
    ];
    value.hasMore = true;
    const container = render(value);
    expect(container.querySelector("summary")?.textContent).toContain(
      "2 retained turns · 2 need scope review",
    );
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.textContent).toContain("configured agent has changed");
    expect(container.textContent).toContain("version cannot be verified");
    expect(container.textContent).toContain("Showing the first 2 queued turns");
    expect(container.textContent).toContain("Other queued work can also be released");
  });
  it("does not carry a scope claim across plan revisions or invent data for an older server", () => {
    const container = render(scope(), 3);
    expect(container.textContent).toContain("checked for plan r2");
    expect(container.textContent).toContain("scope for r3");
    expect(container.textContent).not.toContain("example/api");
    expect(render(undefined).innerHTML).toBe("");
  });
  it("distinguishes a matching scope with no queued work from a promise to execute", () => {
    const value = scope();
    value.repositories = { matches: true, connectedCount: 2, missing: [], removed: [] };
    value.queuedWork = [];
    const container = render(value);
    expect(container.textContent).toContain("covers all 2 current repository connections");
    expect(container.textContent).toContain("No queued turns were present in this scope check");
    expect(container.textContent).toContain("Approval does not create a new request");
  });
});
