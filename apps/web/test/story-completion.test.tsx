// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryCompletionPanel } from "../components/story/story-completion";
import type { StoryCompletion } from "../lib/api";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const at = "2026-10-22T12:00:00.000Z";
function snapshot(
  nextAction: StoryCompletion["nextAction"] = "request_completion",
): StoryCompletion {
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story/a",
    generatedAt: at,
    candidate: {
      revision: "a".repeat(64),
      state: "recorded",
      requiredCount: 2,
      mergedCount: 2,
      allRequiredMerged: true,
    },
    integration: {
      policy: { mode: "none", repository: null },
      candidateRevision: null,
      state: "not_required",
      attempt: 0,
      eventId: null,
      repository: null,
      summary: null,
      evidenceUrl: null,
      errorCode: null,
      recordedBy: null,
      recordedAt: null,
    },
    source: { kind: "github_issue", state: "open", url: "https://example.test/issues/1" },
    completion: {
      candidateRevision: null,
      state: "not_requested",
      attempt: 0,
      errorCode: null,
      requestedBy: null,
      requestedAt: null,
      completedAt: null,
    },
    notices: { in_app: true },
    retention: {
      workspaceState: "running",
      computeSuspended: false,
      storageRetained: true,
      archived: false,
      deleted: false,
    },
    nextAction,
  };
}

let container: HTMLDivElement;
let root: Root;
let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetch = vi.fn(async () => Response.json(snapshot()));
  vi.stubGlobal("fetch", fetch);
  refresh.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(
  initial: StoryCompletion,
  permissions = true,
  overrides: { canConfigure?: boolean; canConfigureNotices?: boolean } = {},
) {
  await act(async () =>
    root.render(
      <StoryCompletionPanel
        projectId="project-a"
        storyId="story/a"
        initial={initial}
        canConfigure={permissions}
        canConfigureNotices={permissions}
        canRecord={permissions}
        canComplete={permissions}
        {...overrides}
      />,
    ),
  );
}

describe("story completion UI", () => {
  it("shows a manual integration result only while that exact gate is pending", async () => {
    const initial = snapshot("record_integration");
    initial.integration = {
      ...initial.integration,
      policy: { mode: "manual", repository: null },
      candidateRevision: initial.candidate.revision,
      state: "pending",
    };
    await render(initial);
    expect(container.textContent).toContain("Record the post-merge integration result");
    expect(container.querySelector("textarea")).not.toBeNull();

    const failed = snapshot("inspect_integration_failure");
    failed.integration = {
      ...failed.integration,
      policy: { mode: "repository_dispatch", repository: "acme/app" },
      candidateRevision: failed.candidate.revision,
      state: "failed",
      errorCode: "github_http_503",
    };
    await render(failed);
    expect(container.textContent).toContain("Inspect the integration failure");
    expect(container.textContent).toContain("github_http_503");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("requests exact source completion with an idempotency key", async () => {
    const initial = snapshot();
    await render(initial);
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Complete source issue",
    );
    if (!button) throw new Error("Missing completion button");
    await act(async () => button.click());
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/projects/project-a/workspace-stories/story%2Fa/complete");
    expect(request.method).toBe("POST");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      candidate_revision: initial.candidate.revision,
      confirm: true,
    });
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.headers["idempotency-key"]).toBe(body.idempotency_key);
  });

  it("saves only the in-app notice preference and explains the external-channel boundary", async () => {
    await render(snapshot());
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!checkbox) throw new Error("Missing notice preference");
    await act(async () => checkbox.click());
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Save preference",
    );
    if (!button) throw new Error("Missing preference button");
    await act(async () => button.click());
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/projects/project-a/delivery-notices",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ in_app: false }) }),
    );
    expect(container.textContent).toContain("No external channel is configured");
  });

  it("keeps source completion, compute suspension and retained storage visible", async () => {
    const completed = snapshot("completed");
    completed.source.state = "closed";
    completed.completion = {
      ...completed.completion,
      candidateRevision: completed.candidate.revision,
      state: "completed",
      completedAt: at,
    };
    completed.retention = {
      ...completed.retention,
      workspaceState: "sleeping",
      computeSuspended: true,
    };
    await render(completed, false);
    expect(container.textContent).toContain("Delivery completed");
    expect(container.textContent).toContain("closed");
    expect(container.textContent).toContain("sleeping · storage retained");
    expect(container.textContent).not.toContain("Complete source issue");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps integration policy and notice configuration permissions separate", async () => {
    await render(snapshot(), false, { canConfigureNotices: true });
    expect(container.textContent).toContain("Delivery notice preference");
    expect(container.textContent).not.toContain("Post-merge integration policy");
    await render(snapshot(), false, { canConfigure: true });
    expect(container.textContent).toContain("Post-merge integration policy");
    expect(container.textContent).not.toContain("Delivery notice preference");
  });
});
