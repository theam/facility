// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryPreviewConvergencePanel } from "../components/story/story-preview-convergence";
import type { StoryPreviewConvergence } from "../lib/api";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
type Preview = NonNullable<StoryPreviewConvergence>;
const at = "2026-10-22T10:00:00.000Z";

function snapshot(state: Preview["state"] = "ready"): Preview {
  const generation = "a".repeat(64);
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story/a",
    revision: 3,
    state,
    desired: {
      generation,
      deliveryRevision: generation,
      observedAt: at,
      repositories: [
        {
          repositoryId: "repo-app",
          repository: "example/app",
          pullNumber: 42,
          headRef: "feature/preview",
          headSha: "b".repeat(40),
          primary: true,
        },
      ],
    },
    deployedGeneration: state === "ready" ? generation : null,
    lastGoodGeneration: state === "ready" ? generation : null,
    attempt: {
      id: "attempt-1",
      number: 1,
      generation,
      state: state === "ready" ? "succeeded" : "blocked",
      workspaceId: "ws-1",
      cause: state === "ready" ? {} : { code: "preview_dirty_overlap" },
      startedAt: at,
      endedAt: at,
    },
    error:
      state === "ready"
        ? null
        : {
            code: "preview_dirty_overlap",
            message: "A local edit overlaps a required preview commit.",
            retryAt: null,
          },
    updatedAt: at,
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
  fetch = vi.fn(async () => Response.json(snapshot("pending")));
  vi.stubGlobal("fetch", fetch);
  refresh.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(initial: Preview | null, canExecute = true) {
  await act(async () =>
    root.render(
      <StoryPreviewConvergencePanel
        projectId="project-a"
        storyId="story/a"
        initial={initial}
        canExecute={canExecute}
      />,
    ),
  );
}

describe("story preview convergence UI", () => {
  it("shows the exact ready generation without making a request", async () => {
    await render(snapshot(), false);
    expect(container.textContent).toContain("Current delivery is ready");
    expect(container.textContent).toContain("example/app #42");
    expect(container.textContent).toContain("bbbbbbbbbbbb");
    expect(container.textContent).toContain("1 required PR revision is running");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries a blocked latest generation with an idempotency key", async () => {
    await render(snapshot("blocked"));
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "Retry latest generation",
    );
    if (!button) throw new Error("Missing preview retry button");
    await act(async () => button.click());
    expect(fetch).toHaveBeenCalledOnce();
    const [url, request] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(
      "/api/v1/projects/project-a/workspace-stories/story%2Fa/preview-convergence/retry",
    );
    expect(request.method).toBe("POST");
    const body = JSON.parse(request.body);
    expect(body.idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.headers["idempotency-key"]).toBe(body.idempotency_key);
    expect(container.textContent).toContain("Queued for update");
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("renders nothing before a complete exact delivery generation exists", async () => {
    await render(null);
    expect(container.textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  });
});
