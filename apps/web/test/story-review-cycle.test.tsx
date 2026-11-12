// @vitest-environment jsdom

import type { StoryWorkflowStatus } from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryWorkflowPanel } from "../components/story/story-workflow";
import { reviewCycleFixture } from "./fixtures/review-cycle";
import { snapshot as deliveryFixture } from "./fixtures/story-delivery";
import { workflowFixture } from "./fixtures/workflow";

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

let container: HTMLDivElement;
let root: Root;
let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  navigation.refresh.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function render(
  initial: StoryWorkflowStatus = { ...workflowFixture(), reviewCycle: reviewCycleFixture() },
  canWrite = true,
) {
  await act(async () =>
    root.render(<StoryWorkflowPanel initial={initial} canWrite={canWrite} candidateReady />),
  );
}
function acceptanceButton() {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Request delivery acceptance",
  );
}
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing test fixture");
  return value;
}

describe("delivery acceptance on the story", () => {
  it("confirms delivery acceptance in place with the review's proof and closes once recorded", async () => {
    const request = {
      id: "acceptance-request",
      status: "pending" as const,
      requestedBy: { type: "user" as const, id: "person", name: "Ada" },
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      confirmationUrl:
        "https://facility.test/projects/project/stories/story/delivery-acceptance/acceptance-request",
      snapshot: {
        candidateRevision: "a".repeat(64),
        scopeRevision: 1,
        planRevision: 1,
        planDigest: "d".repeat(64),
        decisionRevision: 1,
        policyRevision: 1,
        acceptanceRevision: 0,
        previewGeneration: null,
        pullRequests: [
          {
            repository: "example/app",
            number: 7,
            headSha: "b".repeat(40),
            url: "https://github.com/example/app/pull/7",
          },
        ],
      },
    };
    const review = {
      schemaVersion: 1,
      orgId: "org-a",
      projectId: "project",
      storyId: "story",
      proof: "p".repeat(43),
      receipt: null,
      request,
    };
    fetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      const target = String(url);
      if (target.endsWith("/delivery")) return Response.json(deliveryFixture());
      if (target.endsWith("/workflow")) return Response.json(workflowFixture());
      if (init?.method === "POST" && target.endsWith("/delivery-acceptance"))
        return Response.json(request);
      if (target.endsWith("/delivery-acceptance/acceptance-request")) return Response.json(review);
      if (init?.method === "POST" && target.endsWith("/acceptance-request/confirm"))
        return Response.json({ status: "current", receipt: null });
      throw new Error(`unexpected ${target}`);
    });
    await render(workflowFixture());
    await act(async () => required(acceptanceButton()).click());
    const inline = container.querySelector('[aria-label="Confirm delivery acceptance"]');
    expect(inline?.textContent).toContain("example/app #7");
    expect(inline?.textContent).toContain("Accept this exact delivery");
    expect(container.textContent).not.toContain("Review and confirm this delivery");
    const cancel = [...(inline?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent === "Cancel",
    );
    await act(async () => cancel?.click());
    expect(container.querySelector('[aria-label="Confirm delivery acceptance"]')).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith("/confirm"))).toBe(false);
    await act(async () => required(acceptanceButton()).click());
    const reopened = container.querySelector('[aria-label="Confirm delivery acceptance"]');
    const accept = [...(reopened?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent === "Accept this exact delivery",
    );
    await act(async () => accept?.click());
    const call = fetch.mock.calls.find(([url]) => String(url).endsWith("/confirm"));
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ proof: review.proof });
    expect(container.querySelector('[aria-label="Confirm delivery acceptance"]')).toBeNull();
    expect(container.textContent).toContain("Acceptance recorded.");
    expect(navigation.refresh).toHaveBeenCalled();
  });
});

describe("recorded review cycle", () => {
  it("shows reason, configured roles and exact evidence and leaves acceptance to the person at a decision stop", async () => {
    await render();
    expect(container.textContent).toContain("Human decision required");
    expect(container.textContent).toContain("The permissions change exceeds the approved plan.");
    expect(container.textContent).toContain("implementador");
    expect(container.textContent).toContain("qa-custom");
    expect(container.textContent).toContain("Cost unconfirmed");
    expect(container.textContent).toContain("Restore the role check");
    expect(
      container.querySelector(
        `a[href="https://github.com/example/api/blob/${"b".repeat(40)}/src/permissions.ts#L12"]`,
      ),
    ).not.toBeNull();
    expect(acceptanceButton()?.disabled).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a previous report tied to its own head after a new candidate is recorded", async () => {
    const cycle = reviewCycleFixture();
    const oldHead = required(required(cycle.reviews[0]).candidate.pullRequests[1]).headSha;
    cycle.candidate = structuredClone(cycle.candidate);
    required(cycle.candidate).id = "f".repeat(64);
    required(required(cycle.candidate).pullRequests[1]).headSha = "f".repeat(40);
    await render({ ...workflowFixture(), reviewCycle: cycle }, false);
    expect(container.textContent).toContain("Previous candidate");
    expect(container.querySelector(`a[href*="/blob/${oldHead}/"]`)).not.toBeNull();
    expect(container.querySelector(`a[href*="/blob/${"f".repeat(40)}/"]`)).toBeNull();
    expect(acceptanceButton()).toBeUndefined();
  });

  it("refreshes active work without replacing disclosure state and stops polling on a human decision", async () => {
    vi.useFakeTimers();
    const initial = { ...workflowFixture(), reviewCycle: reviewCycleFixture() };
    initial.reviewCycle.phase = "correction";
    const stopped = structuredClone(initial);
    stopped.reviewCycle.phase = "decision_required";
    fetch.mockResolvedValue(Response.json(stopped));
    await render(initial);
    const disclosure = required(container.querySelector("details"));
    disclosure.open = true;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.textContent).toContain("Human decision required");
    expect(container.querySelector("details")).toBe(disclosure);
    expect(disclosure.open).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
    expect(required(fetch.mock.calls[0])[1].method).toBe("GET");
  });

  it("rechecks the cycle before posting acceptance if it changed since the page was read", async () => {
    const initial = { ...workflowFixture(), reviewCycle: reviewCycleFixture() };
    initial.reviewCycle.phase = "human_review";
    const restarted = { ...workflowFixture(), reviewCycle: reviewCycleFixture() };
    restarted.reviewCycle.phase = "review";
    fetch.mockImplementation(async (url: string) =>
      Response.json(url.endsWith("/delivery") ? deliveryFixture() : restarted),
    );
    await render(initial);
    await act(async () => required(acceptanceButton()).click());
    expect(fetch.mock.calls.map(([, request]) => request.method)).toEqual(["GET", "GET"]);
    expect(container.textContent).toContain("The permissions change exceeds the approved plan.");
    expect(acceptanceButton()?.disabled).toBe(true);
  });

  it("preserves old-server behavior and makes no background request without a cycle", async () => {
    vi.useFakeTimers();
    await render(workflowFixture());
    expect(container.querySelector('[aria-label="Recorded delivery review"]')).toBeNull();
    expect(acceptanceButton()?.disabled).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the previous observation after a failed refresh and rejects a foreign scope", async () => {
    vi.useFakeTimers();
    const initial = { ...workflowFixture(), reviewCycle: reviewCycleFixture() };
    initial.reviewCycle.phase = "review";
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 }),
    );
    fetch.mockResolvedValueOnce(Response.json({ ...initial, storyId: "other-story" }));
    await render(initial);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.textContent).toContain("Temporarily unavailable");
    expect(container.textContent).toContain("Reviewer is checking the candidate");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(container.textContent).toContain("does not match this story");
    expect(container.textContent).toContain("Reviewer is checking the candidate");
    expect(acceptanceButton()?.disabled).toBe(true);
  });

  it("replaces a polled observation when a newer page observation arrives", async () => {
    vi.useFakeTimers();
    const initial = { ...workflowFixture(), reviewCycle: reviewCycleFixture() };
    initial.reviewCycle.phase = "correction";
    const next = structuredClone(initial);
    next.reviewCycle.phase = "human_review";
    next.reviewCycle.reason = "The current candidate is ready.";
    fetch.mockResolvedValue(Response.json(next));
    await render(initial);
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(acceptanceButton()?.disabled).toBe(false);
    const newer = { ...workflowFixture(), reviewCycle: reviewCycleFixture() };
    newer.reviewCycle.phase = "review";
    await render(newer);
    expect(container.textContent).toContain("Reviewer is checking the candidate");
    expect(acceptanceButton()?.disabled).toBe(true);
  });

  it("retains the acceptance key for an identical candidate and rotates it for a new head", async () => {
    const initial = { ...workflowFixture(), reviewCycle: reviewCycleFixture() };
    initial.reviewCycle.phase = "human_review";
    const delivery = deliveryFixture();
    fetch.mockImplementation(async (url: string, request: { method: string }) => {
      if (request.method === "POST")
        return Response.json({ error: { message: "Try again" } }, { status: 409 });
      return Response.json(url.endsWith("/delivery") ? delivery : initial);
    });
    await render(initial);
    await act(async () => required(acceptanceButton()).click());
    await act(async () => required(acceptanceButton()).click());
    delivery.candidate.revision = "e".repeat(64);
    await act(async () => required(acceptanceButton()).click());
    const bodies = fetch.mock.calls
      .filter(([, request]) => request.method === "POST")
      .map(([, request]) => JSON.parse(request.body));
    expect(bodies).toHaveLength(3);
    expect(bodies[1].idempotency_key).toBe(bodies[0].idempotency_key);
    expect(bodies[2].idempotency_key).not.toBe(bodies[0].idempotency_key);
  });
});
