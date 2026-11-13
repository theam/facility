// @vitest-environment jsdom
import type { StoryWorkflowStatus } from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LivePlanExecutionOutcome,
  PlanExecutionOutcome,
} from "../components/story/plan-execution-outcome";
import { approvalFixture, workflowFixture } from "./fixtures/workflow";

let container: HTMLDivElement, root: Root;
const fetcher = vi.fn<typeof fetch>();
const storyPath = "/projects/project-a/stories/story-a";
function queued(): StoryWorkflowStatus {
  const value = workflowFixture();
  if (!value.execution || !value.executionScope) throw Error("Missing fixture execution");
  value.execution.turns = [];
  value.queuedAgents = ["planner"];
  value.executionScope.queuedWork = [
    {
      turnId: "retained",
      agentName: "planner",
      engine: "codex",
      model: "fixture-model",
      manifestHash: "a".repeat(64),
      createdAt: "2026-11-05T09:00:00Z",
      configuration: "current",
      planAgent: "current",
    },
  ];
  return value;
}
function finished() {
  const value = workflowFixture();
  const turn = value.execution?.turns[0];
  if (!turn) throw Error("Missing fixture turn");
  turn.state = "succeeded";
  turn.endedAt = "2026-11-05T10:01:00Z";
  return value;
}
async function render(workflow?: StoryWorkflowStatus) {
  await act(async () =>
    root.render(
      <PlanExecutionOutcome
        decision={approvalFixture}
        workflow={workflow}
        storyPath={storyPath}
        retainedTurnIds={["retained"]}
      />,
    ),
  );
}
async function live() {
  await act(async () =>
    root.render(
      <LivePlanExecutionOutcome
        decision={approvalFixture}
        storyPath={storyPath}
        projectId="project-a"
        storyId="story-a"
        retainedTurnIds={["retained"]}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetcher.mockReset();
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("execution after plan approval", () => {
  it("distinguishes awaiting admission, a remaining workflow hold and the exact resumed turn", async () => {
    const waiting = queued();
    await render(waiting);
    expect(container.textContent).toContain("Approved · waiting to start");
    waiting.blockedReason = "The approving member no longer has execution permission";
    await render(waiting);
    expect(container.textContent).toContain("Approved · work is still held");
    expect(container.textContent).toContain("no longer has execution permission");
    await render(workflowFixture());
    expect(container.textContent).toContain("planner · Preparing or running");
    expect(container.textContent).toContain("same turn inspected before approval");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(`${storyPath}#conversation`);
    expect(container.textContent).toContain("retained");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps changed decisions historical and never substitutes unverified execution for a successful turn", async () => {
    const value = workflowFixture();
    value.plan = { revision: 2, decisionRevision: 1, status: "proposed" };
    await render(value);
    expect(container.textContent).toContain("approval is historical");
    expect(container.textContent).not.toContain("Preparing or running");
    value.plan = { revision: 1, decisionRevision: 1, status: "approved" };
    if (!value.execution) throw Error("Missing execution");
    value.execution.turns = [];
    value.execution.unavailable = true;
    await render(value);
    expect(container.textContent).toContain("not proof that no work ran");
    expect(container.textContent).not.toContain("No execution linked");
    await render(finished());
    expect(container.textContent).toContain("Delivery acceptance is a separate decision");
    await render();
    expect(container.textContent).toContain("linked execution status is unavailable");
  });
  it("observes waiting, running and completion without re-submitting the decision, then stops polling", async () => {
    vi.useFakeTimers();
    fetcher
      .mockResolvedValueOnce(Response.json(queued()))
      .mockResolvedValueOnce(Response.json(workflowFixture()))
      .mockResolvedValueOnce(Response.json(finished()));
    await live();
    expect(container.textContent).toContain("waiting to start");
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(container.textContent).toContain("Preparing or running");
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(container.textContent).toContain("Turn succeeded");
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.every(
        ([url, options]) => String(url).endsWith("/workflow") && options?.method === "GET",
      ),
    ).toBe(true);
  });
  it("pauses background reads and preserves the recorded decision when status becomes unavailable", async () => {
    vi.useFakeTimers();
    fetcher
      .mockResolvedValueOnce(Response.json(queued()))
      .mockResolvedValueOnce(
        Response.json({ error: { message: "Temporary read failure" } }, { status: 503 }),
      );
    await live();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    expect(container.textContent).toContain("Approval remains recorded");
    expect(container.textContent).toContain("Temporary read failure");
    expect(container.textContent).not.toContain("waiting to start");
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockResolvedValueOnce(Response.json(finished()));
    await act(async () => container.querySelector("button")?.click());
    expect(container.textContent).toContain("Turn succeeded");
  });
});
