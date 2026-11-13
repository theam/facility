// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryCompletionPanel } from "../components/story/story-completion";
import type { StoryCompletion } from "../lib/api";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { at, snapshot } from "./fixtures/story-completion";

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
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    await act(async () => button.click());
  }

  async function type(selector: string, value: string) {
    const node = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!node) throw new Error(`Missing ${selector}`);
    await act(async () => {
      const prototype =
        node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function attempts() {
    return fetch.mock.calls.map(([, request]) => {
      const body = JSON.parse(request.body);
      expect(request.headers["idempotency-key"]).toBe(body.idempotency_key);
      return body;
    });
  }

  function rejectRequests() {
    fetch.mockImplementation(async () =>
      Response.json(
        { error: { code: "conflict", message: "Retry after review" } },
        { status: 409 },
      ),
    );
  }

  it("retries completion once per exact candidate after a conflict", async () => {
    rejectRequests();
    await render(snapshot());
    await click("Complete source issue");
    await click("Complete source issue");
    const refreshed = snapshot();
    refreshed.candidate.revision = "b".repeat(64);
    await render(refreshed);
    await click("Complete source issue");
    const [first, retry, changed] = attempts();
    expect(retry.idempotency_key).toBe(first.idempotency_key);
    expect(changed.candidate_revision).toBe(refreshed.candidate.revision);
    expect(changed.idempotency_key).not.toBe(first.idempotency_key);
  });

  it.each([
    "state",
    "summary",
    "evidence",
    "event",
    "candidate",
  ])("uses a new integration key when %s changes after a conflict", async (change) => {
    rejectRequests();
    const initial = snapshot("record_integration");
    initial.integration.policy = { mode: "manual", repository: null };
    initial.integration.state = "pending";
    await render(initial);
    await type("textarea", "Staging deploy");
    await click("Record success");
    await click("Record success");
    if (change === "summary") await type("textarea", "Staging deploy verified");
    if (change === "evidence") await type('input[type="url"]', "https://example.test/evidence");
    if (change === "event" || change === "candidate") {
      const refreshed = structuredClone(initial);
      if (change === "event") refreshed.integration.eventId = "new-event";
      else refreshed.candidate.revision = "b".repeat(64);
      await render(refreshed);
    }
    await click(change === "state" ? "Record failure" : "Record success");
    const [first, retry, changed] = attempts();
    expect(retry.idempotency_key).toBe(first.idempotency_key);
    expect(changed.idempotency_key).not.toBe(first.idempotency_key);
    expect(changed.summary).toBe(
      change === "summary" ? "Staging deploy verified" : "Staging deploy",
    );
    expect(changed.state).toBe(change === "state" ? "failed" : "succeeded");
    expect(changed.evidence_url).toBe(
      change === "evidence" ? "https://example.test/evidence" : null,
    );
    expect(changed.event_id).toBe(change === "event" ? "new-event" : null);
    expect(changed.candidate_revision).toBe((change === "candidate" ? "b" : "a").repeat(64));
  });

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
  it("preserves unsaved configuration and focus when completion observations refresh", async () => {
    await render(snapshot());
    const mode = container.querySelector<HTMLSelectElement>("select");
    const repository = container.querySelector<HTMLInputElement>(
      'input[placeholder="owner/repository"]',
    );
    const notices = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!mode || !repository || !notices) throw new Error("Missing configuration form");
    await act(async () => {
      mode.value = "repository_dispatch";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
      notices.click();
    });
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        repository,
        "example/draft",
      );
      repository.dispatchEvent(new Event("input", { bubbles: true }));
      repository.focus();
    });
    const observed = snapshot("wait_completion");
    observed.integration.policy = { mode: "manual", repository: null };
    await render(observed);
    expect(container.textContent).toContain("Wait for source completion");
    expect(mode.value).toBe("repository_dispatch");
    expect(repository.value).toBe("example/draft");
    expect(notices.checked).toBe(false);
    expect(document.activeElement).toBe(repository);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("updates untouched configuration from fresh observations", async () => {
    await render(snapshot());
    const observed = snapshot();
    observed.integration.policy = { mode: "repository_dispatch", repository: "example/observed" };
    observed.notices.in_app = false;
    await render(observed);
    expect(container.querySelector("select")?.value).toBe("repository_dispatch");
    expect(
      container.querySelector<HTMLInputElement>('input[placeholder="owner/repository"]')?.value,
    ).toBe("example/observed");
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(
      false,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    "other",
    "unavailable",
  ])("explains an %s source without an executable completion action", async (reason) => {
    const current = snapshot();
    current.source =
      reason === "other"
        ? { kind: "other", state: "unavailable", url: null }
        : { kind: "github_issue", state: "unavailable", url: "https://example.test/issues/1" };
    await render(current, true);
    expect(container.textContent).toContain(
      reason === "other" ? "No source issue linked" : "Source issue unavailable",
    );
    expect(container.textContent).not.toContain("Complete source issue");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("identifies the exact source and the completion effect without turning a merge into completion", async () => {
    await render(snapshot(), true);
    expect(
      container.querySelector('[aria-label="Completion source"] a')?.getAttribute("href"),
    ).toBe("https://example.test/issues/1");
    expect(container.textContent).toContain("then suspends workspace compute");
    expect(container.textContent).toContain("Suspension not recorded");
    expect(container.textContent).not.toContain("Delivery completed");
    const unsafe = snapshot();
    unsafe.source.url = "javascript:alert(1)";
    await render(unsafe, false);
    expect(container.querySelector('[aria-label="Completion source"] a')).toBeNull();
    expect(container.textContent).toContain("Source issue link unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
});
