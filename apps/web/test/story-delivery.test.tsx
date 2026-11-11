// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryDeliveryPanel } from "../components/story/story-delivery";
import type { StoryDelivery } from "../lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const at = "2026-10-21T10:00:00.000Z";
function snapshot(revision = 1): StoryDelivery {
  const pullRequests = ["app", "api", "worker"].map((name, index) => ({
    repositoryId: `repo-${name}`,
    repository: `example/${name}`,
    number: index + 1,
    required: true,
    primary: index === 0,
    origin: "registered" as const,
    title: `Feature in ${name}`,
    url: `https://github.com/example/${name}/pull/${index + 1}`,
    state: index === 0 ? ("merged" as const) : ("open" as const),
    draft: false,
    headSha: "a".repeat(40),
    headRef: "feature",
    baseRef: "main",
    observedAt: at,
    stale: false,
    checks: { state: "success" as const, headSha: "b".repeat(40), current: false, observedAt: at },
    reviews: {
      state: "unobserved" as const,
      currentHeadCount: 0,
      unverifiedHeadCount: 0,
      truncated: false,
      latest: [],
    },
  }));
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story-a",
    generatedAt: at,
    scope: {
      revision,
      declaredComplete: true,
      origin: "registered",
      updatedAt: at,
      updatedBy: { type: "user", id: "person-a" },
    },
    pullRequests,
    candidate: {
      revision: "d".repeat(64),
      state: "recorded",
      requiredCount: 3,
      mergedCount: 1,
      allRequiredMerged: false,
    },
    available: {
      items: [
        {
          repositoryId: "repo-extra",
          repository: "example/extra",
          number: 4,
          title: "Another required change",
          url: "https://github.com/example/extra/pull/4",
          headSha: "c".repeat(40),
          state: "open",
          draft: false,
          stale: false,
        },
      ],
      hasMore: false,
      nextOffset: null,
    },
  };
}

let container: HTMLDivElement, root: Root, fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetch = vi.fn(async () => Response.json(snapshot()));
  vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(
  initial: StoryDelivery | undefined = snapshot(),
  canWrite = true,
  canExecute = false,
) {
  await act(async () =>
    root.render(
      <StoryDeliveryPanel
        projectId="project-a"
        storyId="story-a"
        initial={initial}
        canWrite={canWrite}
        canExecute={canExecute}
      />,
    ),
  );
}
function button(text: string) {
  const node = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!node) throw Error(`Missing button ${text}`);
  return node;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function control(label: string) {
  const node = [...container.querySelectorAll("label")]
    .find((item) => item.textContent?.includes(label))
    ?.querySelector("input");
  if (!node) throw Error(`Missing control ${label}`);
  return node;
}
async function find(text: string) {
  const input = control("Find a project PR");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Search PRs");
}
function postCalls() {
  return fetch.mock.calls.filter((call) => call[1]?.method === "POST");
}

describe("story delivery UI", () => {
  it("discloses execution before an execution-capable user saves the PR set", async () => {
    await render(snapshot(), true, true);
    await click("Edit PR set");
    expect(container.textContent).toContain("Saving also authorizes automatic preview updates");
    expect(container.textContent).toContain("Your data is retained");
    expect(button("Save PR set and update preview")).toBeDefined();
    expect(postCalls()).toHaveLength(0);
    await click("Save PR set and update preview");
    expect(postCalls()).toHaveLength(1);
  });

  it("shows all required PRs, partial merges and old-head CI to a reader without making requests", async () => {
    await render(snapshot(), false);
    expect(container.textContent).toContain("1 of 3 required PRs observed merged");
    for (const name of ["app", "api", "worker"])
      expect(container.textContent).toContain(`example/${name}`);
    expect(container.textContent).toContain("CI success · older commit");
    expect(container.textContent).toContain("Reviews not observed");
    expect(container.textContent).not.toContain("Reviews · 0");
    expect(container.textContent).not.toContain("Edit PR set");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("distinguishes unknown review commits and an unknown PR head from a known older commit", async () => {
    function withReview(headSha: string | null, commitSha: string | null) {
      const value = snapshot();
      const first = value.pullRequests[0];
      if (!first) throw Error("Missing fixture PR");
      first.headSha = headSha;
      first.reviews = {
        state: "recorded",
        currentHeadCount: 0,
        unverifiedHeadCount: 1,
        truncated: false,
        latest: [
          {
            reviewId: "review-1",
            author: "reviewer",
            state: "APPROVED",
            commitSha,
            submittedAt: at,
            url: null,
            current: false,
          },
        ],
      };
      return value;
    }
    await render(withReview("a".repeat(40), null), false);
    expect(container.textContent).toContain("commit unknown");
    expect(container.textContent).toContain("not verified on current head");
    expect(container.textContent).not.toContain("other commit");
    await render(withReview(null, "b".repeat(40)), false);
    expect(container.textContent).toContain("current head unknown");
    expect(container.textContent).not.toContain("other commit");
    await render(withReview("a".repeat(40), "b".repeat(40)), false);
    expect(container.textContent).toContain("other commit");
  });

  it("requires an explicit complete set rather than promoting a legacy primary or stale merge", async () => {
    const legacy = snapshot();
    legacy.scope = { ...legacy.scope, declaredComplete: false, revision: 0, origin: "legacy" };
    legacy.candidate = {
      ...legacy.candidate,
      revision: null,
      state: "scope_incomplete",
      allRequiredMerged: null,
    };
    legacy.pullRequests = legacy.pullRequests
      .slice(0, 1)
      .map((pull) => ({ ...pull, origin: "legacy" }));
    await render(legacy);
    expect(container.textContent).toContain("complete set of required PRs has not been declared");
    expect(container.textContent).toContain("Source PR association");
    await render({ ...snapshot(), candidate: { ...snapshot().candidate, state: "stale" } });
    expect(container.textContent).toContain("GitHub observations are stale");
    expect(container.textContent).not.toContain("accepted");
  });

  it("keeps edits through live refresh, saves the captured revision and allows explicit recovery from conflicts", async () => {
    await render();
    await click("Edit PR set");
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove example/api #2"]',
    );
    await act(async () => remove?.click());
    await render(snapshot(2));
    expect(container.querySelector('button[aria-label="Remove example/api #2"]')).toBeNull();
    expect(container.textContent).toContain("saved set changed while you were editing");
    fetch.mockResolvedValueOnce(
      Response.json(
        { error: { message: "The delivery set changed. Reload it before saving your edits." } },
        { status: 409 },
      ),
    );
    await click("Save PR set");
    const sent = JSON.parse(postCalls()[0]?.[1].body);
    expect(sent.expected_revision).toBe(1);
    expect(sent.pull_requests).toHaveLength(2);
    expect(sent.declared_complete).toBe(false);
    expect(container.textContent).toContain("The delivery set changed");
    expect(container.querySelector('button[aria-label="Remove example/api #2"]')).toBeNull();
    fetch.mockResolvedValueOnce(Response.json(snapshot(2)));
    await click("Reload saved set (discard edits)");
    expect(container.querySelector('button[aria-label="Remove example/api #2"]')).not.toBeNull();
    await click("Save PR set");
    expect(JSON.parse(postCalls()[1]?.[1].body).expected_revision).toBe(2);
  });

  it("reuses an uncertain save's idempotency key and sends only one concurrent mutation", async () => {
    await render();
    await click("Edit PR set");
    fetch.mockRejectedValueOnce(Error("Connection lost"));
    await click("Save PR set");
    const first = postCalls()[0]?.[1];
    expect(container.textContent).toContain("Connection lost");
    let resolve: (value: Response) => void = () => undefined;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    await act(async () => {
      button("Save PR set").click();
      button("Save PR set").click();
    });
    expect(postCalls()).toHaveLength(2);
    const second = postCalls()[1]?.[1];
    expect(second.body).toBe(first.body);
    expect(second.headers["idempotency-key"]).toBe(first.headers["idempotency-key"]);
    await act(async () => resolve(Response.json(snapshot(2))));
    expect(container.textContent).not.toContain("Save PR set");
  });

  it("changes the retry key after edits, preserves a required primary and explicitly reconfirms completeness", async () => {
    await render();
    await click("Edit PR set");
    fetch.mockRejectedValueOnce(Error("Connection lost"));
    await click("Save PR set");
    const first = JSON.parse(postCalls()[0]?.[1].body);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Add example/extra #4"]')
        ?.click(),
    );
    expect(control("These are all the PRs").checked).toBe(false);
    await act(async () => control("These are all the PRs").click());
    await click("Save PR set");
    const second = JSON.parse(postCalls()[1]?.[1].body);
    expect(second.pull_requests).toHaveLength(4);
    expect(second.pull_requests.filter((pull: { primary: boolean }) => pull.primary)).toHaveLength(
      1,
    );
    expect(second.declared_complete).toBe(true);
    expect(second.idempotency_key).not.toBe(first.idempotency_key);
  });

  it("names each selection accessibly and makes a related PR required when it becomes primary", async () => {
    await render();
    await click("Edit PR set");
    const required = container.querySelector<HTMLInputElement>(
      'input[aria-label="Required for example/api #2"]',
    );
    const primary = container.querySelector<HTMLInputElement>(
      'input[aria-label="Primary for example/api #2"]',
    );
    if (!required || !primary) throw Error("Missing named PR selection controls");
    await act(async () => required.click());
    expect(required.checked).toBe(false);
    await act(async () => primary.click());
    expect(required.checked).toBe(true);
    expect(required.disabled).toBe(true);
    await click("Save PR set");
    const sent = JSON.parse(postCalls()[0]?.[1].body);
    expect(sent.pull_requests.filter((pull: { primary: boolean }) => pull.primary)).toEqual([
      { repository: "example/api", number: 2, required: true, primary: true },
    ]);
  });

  it("uses the submitted filter when paging and clears it on reopening the editor", async () => {
    await render();
    await click("Edit PR set");
    fetch.mockResolvedValueOnce(
      Response.json({
        ...snapshot(),
        available: { ...snapshot().available, hasMore: true, nextOffset: 10 },
      }),
    );
    await find("api");
    await click("More PRs");
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("q=api");
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("offset=10");
    await click("Cancel edits");
    await click("Edit PR set");
    expect(String(fetch.mock.calls.at(-1)?.[0])).toContain("q=");
    expect(control("Find a project PR").value).toBe("");
    expect(postCalls()).toHaveLength(0);
  });

  it("shows search denial and empty results without losing the selected PRs", async () => {
    await render();
    await click("Edit PR set");
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Permission denied" } }, { status: 403 }),
    );
    await find("unavailable");
    expect(container.textContent).toContain("Permission denied");
    expect(container.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(3);
    fetch.mockResolvedValueOnce(
      Response.json({ ...snapshot(), available: { items: [], hasMore: false, nextOffset: null } }),
    );
    await find("no matching PR");
    expect(container.textContent).toContain("No matching PRs in the project mirror");
    expect(container.querySelectorAll('button[aria-label^="Remove "]')).toHaveLength(3);
    await render(snapshot(), false);
    expect(container.textContent).not.toContain("Save PR set");
  });
});
