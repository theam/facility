// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunActivity } from "../components/story/run-activity";
import { StoryConversation } from "../components/story/story-conversation";
import type { StoryConversationPage, StoryMessage, StoryTurnSummary } from "../lib/api";
import { PLAN_PROPOSAL_EVENT } from "../lib/story-plan-events";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const at = "2026-09-10T00:00:00Z";
function turn(id: string, state: StoryTurnSummary["state"] = "succeeded"): StoryTurnSummary {
  return {
    id,
    agentName: "builder",
    engine: "codex",
    model: "gpt-5.5",
    state,
    error: state === "failed" ? "exit 1" : null,
    triggerType: "ui",
    createdAt: at,
    startedAt: at,
    endedAt: state === "running" ? null : "2026-09-10T00:02:00Z",
  };
}
function message(seq: number, overrides: Partial<StoryMessage> = {}): StoryMessage {
  return {
    id: `msg${seq}`,
    seq,
    role: "user",
    body: `Request ${seq}`,
    actor: null,
    turnId: null,
    requestedAgentName: "builder",
    createdAt: at,
    author: { kind: "user", id: "user", name: "Ada Lovelace", handle: null, avatarUrl: null },
    turn: null,
    content: { kind: "text", progressMessages: null, reportedModel: null },
    ...overrides,
  };
}
function exchange(seq: number, id: string, state: StoryTurnSummary["state"] = "succeeded") {
  const run = turn(id, state);
  const request = message(seq, { turnId: id, turn: run });
  const response = message(seq + 1, {
    role: "agent",
    body: `Response ${seq + 1}`,
    turnId: id,
    turn: run,
    author: { kind: "agent", id: "codex:s", name: "builder", handle: null, avatarUrl: null },
    content: { kind: "final_response", progressMessages: 1, reportedModel: null },
  });
  return { request, response };
}
function page(
  messages: StoryMessage[],
  related: StoryMessage[] = [],
  cursor: number | null = null,
): StoryConversationPage {
  return { messages, related, has_more: cursor !== null, next_cursor: cursor };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  });
}
function exchangeTexts() {
  return [...container.querySelectorAll("article")].map((node) => node.textContent ?? "");
}

describe("story conversation paging", () => {
  it("reads oldest first, with older pages above and the latest exchange last", async () => {
    const latest = exchange(5, "turn-c");
    const earlier = exchange(3, "turn-b");
    await act(async () =>
      root.render(
        <StoryConversation
          projectId="proj"
          storyId="story"
          initial={page(
            [latest.response, latest.request, earlier.response, earlier.request],
            [],
            2,
          )}
          waitingTurnIds={[]}
          canExecute
        />,
      ),
    );
    const list = container.querySelector('ol[aria-label="Conversation, oldest first"]');
    expect(list).not.toBeNull();
    expect(exchangeTexts()[0]).toContain("Response 4");
    expect(exchangeTexts().at(-1)).toContain("Response 6");
    expect(
      button("Older messages").compareDocumentPosition(list as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
  it("opens a linked long original in full with its author and preserves focus on refresh", async () => {
    const { request, response } = exchange(1, "turn-source");
    response.body = `${"Original details. ".repeat(150)}Final source fact.`;
    response.author.name = "reviewer";
    if (response.turn) response.turn.agentName = "reviewer";
    const linked = {
      ...page([response], [request]),
      focus: { messageId: response.id, seq: response.seq },
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const props = {
      projectId: "project",
      storyId: "story",
      waitingTurnIds: [],
      canExecute: false,
      initial: linked,
      latestHref: "/projects/project/stories/story?planRevision=1#conversation",
    };
    await act(async () => root.render(<StoryConversation {...props} />));
    expect(container.textContent).toContain("Final source fact.");
    expect(container.textContent).toContain("reviewer");
    expect(document.activeElement?.id).toBe(`message-${response.id}`);
    const link = container.querySelector('a[href*="planRevision=1"]') as HTMLAnchorElement;
    link.focus();
    await act(async () =>
      root.render(<StoryConversation {...props} initial={structuredClone(linked)} />),
    );
    expect(document.activeElement).toBe(link);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("carries the recorded response agent into a plan draft without starting work", async () => {
    const { request, response } = exchange(1, "turn-a");
    if (!request.turn || !response.turn) throw new Error("Missing fixture turn");
    request.turn.agentName = "architect";
    response.turn.agentName = "architect";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const received = vi.fn();
    window.addEventListener(PLAN_PROPOSAL_EVENT, received);
    try {
      await act(async () =>
        root.render(
          <StoryConversation
            projectId="project"
            storyId="story"
            initial={page([response, request])}
            waitingTurnIds={[]}
            canExecute
            canProposePlan
          />,
        ),
      );
      await act(async () => button("Propose as plan").click());
      expect(received).toHaveBeenCalledOnce();
      expect((received.mock.calls[0]?.[0] as CustomEvent).detail).toMatchObject({
        agentName: "architect",
        messageId: response.id,
        markdown: response.body,
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(PLAN_PROPOSAL_EVENT, received);
    }
  });
  it("loads older pages on request, merges related context, and stops at the beginning", async () => {
    const third = exchange(5, "turn-c");
    const second = exchange(3, "turn-b");
    const first = exchange(1, "turn-a");
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("before=4")) {
        // Page: seq 4 and 3 (run b) plus related seq… run a's response only on this page.
        return Response.json(page([first.response], [first.request], 2));
      }
      if (url.includes("before=2")) return Response.json(page([first.request]));
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () =>
      root.render(
        <StoryConversation
          projectId="proj"
          storyId="story"
          initial={page([third.response, third.request, second.response, second.request], [], 4)}
          waitingTurnIds={[]}
          canExecute
        />,
      ),
    );
    expect(exchangeTexts()).toHaveLength(2);
    expect(exchangeTexts().reverse()[0]).toContain("Response 6");
    expect(button("Older messages")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();

    await act(async () => button("Older messages").click());
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "/conversation?order=desc&limit=10&before=4",
    );
    expect(exchangeTexts()).toHaveLength(3);
    expect(exchangeTexts().reverse()[2]).toContain("Request 1");
    expect(exchangeTexts().reverse()[2]).toContain("Response 2");

    await act(async () => button("Older messages").click());
    await settle();
    // The related request arrived again on its own page; nothing duplicates.
    expect(exchangeTexts()).toHaveLength(3);
    expect(container.textContent).toContain("Beginning of the conversation.");
    expect([...container.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
      "Older messages",
    );
  });

  it("shows a retryable error state when an older page fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: { message: "control plane busy" } }, { status: 503 }),
      ),
    );
    const latest = exchange(3, "turn-b");
    await act(async () =>
      root.render(
        <StoryConversation
          projectId="proj"
          storyId="story"
          initial={page([latest.response, latest.request], [], 2)}
          waitingTurnIds={[]}
          canExecute
        />,
      ),
    );
    await act(async () => button("Older messages").click());
    await settle();
    expect(container.querySelector("[role='alert']")?.textContent).toBe("control plane busy");
    expect(button("try again")).toBeTruthy();
    expect(exchangeTexts()).toHaveLength(1);
  });

  it("announces new exchanges instead of moving what a paged reader is looking at", async () => {
    const older = exchange(1, "turn-a");
    const latest = exchange(3, "turn-b");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(page([older.response, older.request]))),
    );
    const render = (initial: StoryConversationPage) =>
      act(async () =>
        root.render(
          <StoryConversation
            projectId="proj"
            storyId="story"
            initial={initial}
            waitingTurnIds={[]}
            canExecute
          />,
        ),
      );
    await render(page([latest.response, latest.request], [], 2));
    await act(async () => button("Older messages").click());
    await settle();
    expect(exchangeTexts()).toHaveLength(2);

    const newest = exchange(5, "turn-c", "running");
    const runningResponseless = page([newest.request, latest.response, latest.request], [], 2);
    await render(runningResponseless);
    expect(exchangeTexts()).toHaveLength(2);
    expect(container.querySelector("[role='status']")?.textContent).toContain("1 new exchange");
    await act(async () => button("Show latest").click());
    expect(exchangeTexts()).toHaveLength(3);
    expect(exchangeTexts().reverse()[0]).toContain("Running");
    expect(exchangeTexts().reverse()[0]).toContain("Cancel turn");
    expect(exchangeTexts().reverse()[0]).not.toContain("Response");

    // A refresh that completes the run updates the exchange in place.
    const completed = exchange(5, "turn-c");
    await render(
      page([completed.response, completed.request, latest.response, latest.request], [], 2),
    );
    expect(exchangeTexts()).toHaveLength(3);
    expect(exchangeTexts().reverse()[0]).toContain("Completed");
    expect(exchangeTexts().reverse()[0]).toContain("Response 6");
    expect(container.querySelector("[role='status']")).toBeNull();
  });

  it("presents failed, canceled, queued and waiting runs without a made-up result", async () => {
    const failed = exchange(7, "turn-f", "failed");
    const canceled = exchange(5, "turn-x", "canceled");
    const queued = message(9, { turnId: "turn-q", turn: turn("turn-q", "queued") });
    const unstarted = message(10);
    const waiting = exchange(3, "turn-w");
    vi.stubGlobal("fetch", vi.fn());
    await act(async () =>
      root.render(
        <StoryConversation
          projectId="proj"
          storyId="story"
          initial={page([
            unstarted,
            queued,
            failed.request,
            canceled.request,
            waiting.response,
            waiting.request,
          ])}
          waitingTurnIds={["turn-w"]}
          canExecute
        />,
      ),
    );
    // Shown oldest first; read newest first to compare.
    const texts = exchangeTexts().reverse();
    expect(texts[0]).toContain("Queued");
    expect(texts[1]).toContain("Queued");
    expect(texts[2]).toContain("Failed");
    expect(texts[2]).toContain("Error details");
    expect(texts[3]).toContain("Canceled");
    expect(texts[4]).toContain("Needs your reply");
    expect(texts[4]).toContain("is waiting for your answer");
    for (const text of texts.slice(0, 4)) expect(text).not.toContain("Response");
  });
});

describe("run activity", () => {
  it("fetches nothing until opened, then pages activity and single raw events", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/events/4")) {
        return Response.json({
          turn_id: "turn-a",
          seq: 4,
          type: "engine.item.completed",
          data: { full: "payload" },
          created_at: at,
        });
      }
      if (url.includes("before=4")) {
        return Response.json({
          turn: turn("turn-a"),
          items: [
            {
              seq: 1,
              turn_id: "turn-a",
              type: "turn.started",
              kind: "lifecycle",
              title: "Run started",
              text: null,
              truncated: false,
              size_bytes: 2,
              created_at: at,
            },
          ],
          has_more: false,
          next_cursor: null,
        });
      }
      return Response.json({
        turn: turn("turn-a"),
        items: [
          {
            seq: 6,
            turn_id: "turn-a",
            type: "turn.succeeded",
            kind: "lifecycle",
            title: "Run completed",
            text: "Duration 4 min",
            truncated: false,
            size_bytes: 20,
            created_at: at,
          },
          {
            seq: 4,
            turn_id: "turn-a",
            type: "engine.item.completed",
            kind: "command",
            title: "Command exit 0",
            text: "pnpm test…",
            truncated: true,
            size_bytes: 40_000,
            created_at: at,
          },
        ],
        has_more: true,
        next_cursor: 4,
      });
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () =>
      root.render(
        <RunActivity projectId="proj" storyId="story" turnId="turn-a" progressMessages={2} />,
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
    const details = container.querySelector("details");
    if (!details) throw new Error("missing details");
    expect(details.textContent).toContain("2 progress messages");

    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event("toggle", { bubbles: false }));
    });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain("/turns/turn-a/activity?limit=10");
    expect(container.textContent).toContain("Run completed");
    expect(container.textContent).toContain("Command exit 0");
    expect(container.textContent).toContain("39.1 KB stored");

    await act(async () => button("Load the full stored event").click());
    await settle();
    expect(container.textContent).toContain('"full": "payload"');

    await act(async () => button("Older activity").click());
    await settle();
    expect(container.textContent).toContain("Run started");
    expect(container.textContent).toContain("Start of this run.");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
