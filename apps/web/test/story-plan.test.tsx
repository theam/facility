// @vitest-environment jsdom
import type { PlanDecisionReview, StoryAgent, StoryPlan, StoryPlans } from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanConfirmation } from "../components/story/plan-confirmation";
import { StoryPlanPanel } from "../components/story/story-plan";
import { PLAN_PROPOSAL_EVENT } from "../lib/story-plan-events";

const navigation = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
const at = "2026-10-21T10:00:00.000Z";
const actor = { type: "user" as const, id: "person-a", name: "Ada" };
const agents: StoryAgent[] = ["planner", "builder"].map((name) => ({
  name,
  description: "Fixture",
  engine: "codex",
  model: "fixture-model",
  enabled: true,
  options: {},
  triggers: [{ type: "manual" }],
  file: `.agents/${name}.md`,
  prompt: "Fixture",
  hash: "a".repeat(64),
  commit_sha: "b".repeat(40),
  synced_at: at,
  schedule_status: { schedules: [], last_result: null },
}));
function plan(revision = 1): StoryPlan {
  return {
    revision,
    digest: "d".repeat(64),
    markdown: "## Agreed scope\n\nImplement and verify the change.",
    repositories: [{ repositoryId: "repo-a", repository: "example/app" }],
    agents: [
      {
        name: "planner",
        manifestHash: "a".repeat(64),
        engine: "codex",
        model: "fixture-model",
        repositoryId: "repo-a",
        catalogCommitSha: "b".repeat(40),
        observedAt: at,
      },
    ],
    proposedBy: actor,
    proposedAt: at,
    source: null,
  };
}
function snapshot(revision = 1): StoryPlans {
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story-a",
    generatedAt: at,
    state: { revision, decisionRevision: 0, status: revision ? "proposed" : "none" },
    plan: revision ? plan(revision) : null,
    decision: null,
    history: { items: [], hasMore: false, nextBeforeRevision: null },
    decisions: { items: [], hasMore: false, nextBeforeRevision: null },
    pending: { items: [], hasMore: false },
  };
}
function review(): PlanDecisionReview {
  return {
    schemaVersion: 1,
    orgId: "org-a",
    projectId: "project-a",
    storyId: "story-a",
    plan: plan(),
    state: snapshot().state,
    decision: null,
    proof: "p".repeat(43),
    request: {
      id: "dreq-a",
      planRevision: 1,
      planDigest: "d".repeat(64),
      decisionRevision: 0,
      intent: "approve",
      reason: null,
      requestedBy: { type: "service", id: "service-a", name: null },
      requestedAt: at,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      boundUserId: null,
      status: "pending",
      confirmationUrl: "https://facility.example/review/dreq-a",
    },
  };
}
function confirmed(): StoryPlans {
  const value = snapshot();
  value.state = { revision: 1, decisionRevision: 1, status: "approved" };
  value.decision = {
    id: "dec-a",
    decisionRevision: 1,
    planRevision: 1,
    planDigest: "d".repeat(64),
    intent: "approve",
    reason: null,
    confirmedBy: actor,
    confirmedAt: at,
    method: "interactive_session",
    requestId: "dreq-a",
  };
  value.decisions.items = [value.decision];
  return value;
}
let container: HTMLDivElement, root: Root, fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetch = vi.fn(async () =>
    Response.json({
      items: [{ repository: "example/app", primary: true }],
      hasMore: false,
      nextOffset: null,
    }),
  );
  vi.stubGlobal("fetch", fetch);
  navigation.push.mockReset();
  navigation.refresh.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function render(
  initial: StoryPlans | undefined = snapshot(),
  canWrite = true,
  catalog = agents,
) {
  await act(async () =>
    root.render(
      <StoryPlanPanel
        projectId="project-a"
        storyId="story-a"
        initial={initial}
        agents={catalog}
        defaultAgent="planner"
        canWrite={canWrite}
        userId="person-a"
      />,
    ),
  );
}
async function renderReview(value = review()) {
  await act(async () => root.render(<PlanConfirmation key={value.request.id} initial={value} />));
}
function button(text: string) {
  const value = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!value) throw Error(`Missing button: ${text}`);
  return value;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function textarea() {
  const node = container.querySelector("textarea");
  if (!node) throw Error("Missing plan textarea");
  return node;
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea(),
      text,
    );
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function writes() {
  return fetch.mock.calls.filter((call) => call[1]?.method === "POST");
}
function body(index = 0) {
  return JSON.parse(writes()[index]?.[1]?.body ?? "{}");
}
async function proposeSource(markdown: string, storyId = "story-a") {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent(PLAN_PROPOSAL_EVENT, {
        detail: { projectId: "project-a", storyId, messageId: "msg-a", markdown },
      }),
    );
  });
}

describe("revision-bound plan UI", () => {
  it("shows readable scope and receipt state without initiating requests or offering viewer mutations", async () => {
    await render(confirmed(), false);
    expect(container.textContent).toContain("Approved for this revision");
    expect(container.textContent).toContain("example/app");
    expect(container.textContent).toContain("planner");
    expect(container.textContent).toContain("approved on r1 by Ada");
    expect(
      [...container.querySelectorAll("button")].some((node) =>
        /Propose|Review approval|Request changes/.test(node.textContent ?? ""),
      ),
    ).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves a proposal after failure and retries with the same key and exact scope", async () => {
    await render(snapshot(0));
    await click("Propose plan");
    expect(document.activeElement).toBe(textarea());
    await type("  ## New plan\n\nPreserve this exact text.\n");
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Temporary save failure" } }, { status: 503 }),
    );
    await click("Save plan proposal");
    expect(textarea().value).toContain("Preserve this exact text");
    expect(container.textContent).toContain("Temporary save failure");
    const first = body();
    fetch.mockResolvedValueOnce(Response.json(snapshot()));
    await click("Save plan proposal");
    expect(body(1)).toEqual(first);
    expect(first).toMatchObject({
      expected_revision: 0,
      repositories: ["example/app"],
      agents: ["planner"],
    });
    expect(first.markdown).toBe("  ## New plan\n\nPreserve this exact text.\n");
    expect(first).not.toHaveProperty("source_message_id");
    expect(navigation.refresh).toHaveBeenCalledOnce();
    expect(navigation.push).not.toHaveBeenCalled();
  });
  it("requires an explicit action before replacing a draft with an exact source message", async () => {
    await render();
    await click("Propose revision");
    await type("Keep my draft");
    await proposeSource("Other story", "story-other");
    expect(container.textContent).not.toContain("Replace your current draft");
    await proposeSource("## Source plan\n");
    expect(textarea().value).toBe("Keep my draft");
    await click("Keep my draft");
    expect(textarea().value).toBe("Keep my draft");
    await proposeSource("## Source plan\n");
    await click("Use this message");
    expect(textarea().value).toBe("## Source plan\n");
    fetch.mockResolvedValueOnce(Response.json(snapshot(2)));
    await click("Save plan proposal");
    expect(body()).toMatchObject({ markdown: "## Source plan\n", source_message_id: "msg-a" });
  });
  it("clears source attribution on an edit and does not approve that proposal", async () => {
    await render();
    await proposeSource("## Source plan\n");
    await click("Use this message");
    await type("Edited proposal");
    fetch.mockResolvedValueOnce(Response.json(snapshot(2)));
    await click("Save plan proposal");
    expect(body()).not.toHaveProperty("source_message_id");
    expect(writes()).toHaveLength(1);
    expect(container.textContent).toContain("Awaiting a decision on this revision");
  });

  it("keeps exact source attribution when an existing proposal is saved without editing", async () => {
    const value = snapshot();
    if (!value.plan) throw Error("Missing fixture plan");
    value.plan.source = { messageId: "msg-original", turnId: null, role: "agent" };
    await render(value);
    await click("Propose revision");
    fetch.mockResolvedValueOnce(Response.json(value));
    await click("Save plan proposal");
    expect(body()).toMatchObject({
      expected_revision: 1,
      markdown: value.plan.markdown,
      source_message_id: "msg-original",
    });
    expect(container.textContent).toContain("Plan r1");
  });
  it("preserves a draft across live refresh and requires an explicit new base after a conflict", async () => {
    await render();
    await click("Propose revision");
    await type("My scoped change");
    await render({ ...snapshot(2), generatedAt: "2026-10-21T10:01:00.000Z" });
    expect(textarea().value).toBe("My scoped change");
    expect(button("Save plan proposal").disabled).toBe(true);
    await click("Use my draft after r2");
    fetch.mockResolvedValueOnce(Response.json(snapshot(3)));
    await click("Save plan proposal");
    expect(body()).toMatchObject({ expected_revision: 2, markdown: "My scoped change" });
  });
  it("lets the user remove an unavailable selected agent instead of trapping the draft", async () => {
    await render(
      snapshot(),
      true,
      agents.filter((agent) => agent.name === "builder"),
    );
    await click("Propose revision");
    expect(button("Save plan proposal").disabled).toBe(true);
    const labels = [...container.querySelectorAll("label")];
    await act(async () =>
      labels
        .find((label) => label.textContent?.includes("planner · unavailable"))
        ?.querySelector("input")
        ?.click(),
    );
    await act(async () =>
      labels
        .find((label) => label.textContent?.includes("builder · fixture-model"))
        ?.querySelector("input")
        ?.click(),
    );
    expect(button("Save plan proposal").disabled).toBe(false);
  });
  it("requests a review with stable retries and keeps a prior rejection reason out of an approval request", async () => {
    await render();
    await click("Request changes");
    await type("Add a regression");
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Temporary request failure" } }, { status: 503 }),
    );
    await click("Review requested changes");
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Temporary request failure" } }, { status: 503 }),
    );
    await click("Review requested changes");
    expect(body(1)).toEqual(body());
    expect(body()).toMatchObject({
      intent: "reject",
      reason: "Add a regression",
      expected_revision: 1,
      expected_decision_revision: 0,
    });
    fetch.mockResolvedValueOnce(Response.json({ request: { id: "dreq-next" } }));
    await click("Review approval");
    expect(body(2).intent).toBe("approve");
    expect(body(2)).not.toHaveProperty("reason");
    expect(navigation.push).toHaveBeenCalledWith(
      "/projects/project-a/stories/story-a/plan/decisions/dreq-next",
    );
    expect(writes().every((call) => !String(call[0]).endsWith("/confirm"))).toBe(true);
  });
  it("retains the first page while loading older immutable plan history", async () => {
    const current = snapshot(3);
    const { markdown: _text, ...r2 } = plan(2);
    const { markdown: _older, ...r1 } = plan(1);
    current.history = { items: [r2], hasMore: true, nextBeforeRevision: 2 };
    await render(current);
    fetch.mockResolvedValueOnce(
      Response.json({
        ...current,
        generatedAt: "2026-10-21T10:01:00.000Z",
        history: { items: [r1], hasMore: false, nextBeforeRevision: null },
      }),
    );
    await click("Older plan revisions");
    expect(button("Read r2")).toBeDefined();
    expect(button("Read r1")).toBeDefined();
    fetch.mockResolvedValueOnce(Response.json(plan(1)));
    await click("Read r1");
    expect(container.textContent).toContain("Historical plan · r1");
  });

  it("can fill a new history gap after later revisions arrive without losing loaded older records", async () => {
    const header = (revision: number) => {
      const { markdown: _text, ...metadata } = plan(revision);
      return metadata;
    };
    const value = snapshot(3);
    value.history = { items: [header(2)], hasMore: true, nextBeforeRevision: 2 };
    await render(value);
    fetch.mockResolvedValueOnce(
      Response.json({
        ...value,
        history: { items: [header(1)], hasMore: false, nextBeforeRevision: null },
      }),
    );
    await click("Older plan revisions");
    const later = {
      ...snapshot(5),
      generatedAt: "2026-10-21T10:01:00.000Z",
      history: { items: [header(4)], hasMore: true, nextBeforeRevision: 4 },
    };
    await render(later);
    expect(button("Read r1")).toBeDefined();
    expect(button("Older plan revisions")).toBeDefined();
    fetch.mockResolvedValueOnce(
      Response.json({
        ...later,
        history: {
          items: [header(4), header(3), header(2), header(1)],
          hasMore: false,
          nextBeforeRevision: null,
        },
      }),
    );
    await click("Older plan revisions");
    expect(button("Read r3")).toBeDefined();
    expect(button("Read r1")).toBeDefined();
  });
  it("shows unavailable metadata honestly and safely renders agent-authored markup", async () => {
    await act(async () =>
      root.render(
        <StoryPlanPanel
          projectId="project-a"
          storyId="story-a"
          agents={agents}
          defaultAgent="planner"
          canWrite
          userId="person-a"
        />,
      ),
    );
    expect(container.textContent).toContain("Plan metadata is unavailable");
    const value = snapshot();
    if (!value.plan) throw Error("Missing fixture");
    value.plan.markdown = "<script>window.stolen = true</script>\n<img src=x onerror=alert(1)>";
    await render(value);
    expect(container.querySelector("script,img")).toBeNull();
    expect(container.textContent).toContain("<script>");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("interactive confirmation UI", () => {
  it("shows exact scope before confirmation, preserves retry identity and records only one receipt on double click", async () => {
    const value = review();
    await renderReview(value);
    expect(container.textContent).toContain("example/app");
    expect(container.textContent).toContain("planner");
    expect(container.textContent).not.toContain(value.proof);
    expect(container.innerHTML).not.toContain(`?proof=`);
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Temporary confirmation failure" } }, { status: 503 }),
    );
    await click("Approve plan r1");
    expect(container.textContent).toContain("Temporary confirmation failure");
    const first = body();
    let release: (value: Response) => void = () => {
      throw Error("Missing pending request");
    };
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => {
      button("Approve plan r1").click();
      button("Approve plan r1").click();
    });
    expect(writes()).toHaveLength(2);
    expect(body(1)).toEqual(first);
    await act(async () => release(Response.json(confirmed())));
    expect(container.textContent).toContain("Approval recorded for plan r1 by Ada");
    expect(
      [...container.querySelectorAll("button")].some(
        (item) => item.textContent === "Approve plan r1",
      ),
    ).toBe(false);
  });
  it("removes confirmation for superseded or expired reviews and after a conflict reload", async () => {
    const value = review();
    value.request.status = "superseded";
    value.state.revision = 2;
    value.proof = null;
    await renderReview(value);
    expect(container.textContent).toContain("current plan is r2");
    expect(
      [...container.querySelectorAll("button")].some(
        (item) => item.textContent === "Approve plan r1",
      ),
    ).toBe(false);
    const expired = review();
    expired.request.id = "expired";
    expired.request.expiresAt = new Date(Date.now() - 1000).toISOString();
    await renderReview(expired);
    expect(container.textContent).toContain("review has expired");
    const pending = review();
    pending.request.id = "pending";
    await renderReview(pending);
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Another decision was recorded" } }, { status: 409 }),
    );
    await click("Approve plan r1");
    fetch.mockResolvedValueOnce(
      Response.json({
        ...pending,
        proof: null,
        request: { ...pending.request, status: "superseded" },
        state: { ...pending.state, decisionRevision: 1 },
      }),
    );
    await click("Reload review");
    expect(
      [...container.querySelectorAll("button")].some(
        (item) => item.textContent === "Approve plan r1",
      ),
    ).toBe(false);
  });
});

describe("newer plan drafts during save", () => {
  it("keeps a newer unsaved draft when an older proposal finishes saving", async () => {
    await render(snapshot(0));
    await click("Propose plan");
    await type("Submitted text A");
    let release: (value: Response) => void = () => {
      throw Error("No pending request");
    };
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    await click("Save plan proposal");
    expect(body().markdown).toBe("Submitted text A");
    expect(textarea().disabled).toBe(false);
    await type("Newer unsaved text B");
    expect(textarea().value).toBe("Newer unsaved text B");
    const saved = snapshot();
    if (saved.plan) saved.plan.markdown = "Submitted text A";
    await act(async () => release(Response.json(saved)));
    expect(textarea().value).toBe("Newer unsaved text B");
  });
});
