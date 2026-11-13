// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunActivity } from "../components/story/run-activity";
import { StoryProgress } from "../components/story/story-progress";
import type { StoryActivityItem, WorkspaceStoryBundle } from "../lib/api";

const at = "2026-11-05T10:00:00Z";
const turn = (id = "turn-a") => ({
  id,
  agentName: "builder",
  engine: "codex",
  model: "fixture",
  state: "running",
  error: null,
  triggerType: "ui",
  createdAt: at,
  startedAt: at,
  endedAt: null,
});
const item = (seq: number, id = "turn-a"): StoryActivityItem => ({
  seq,
  turn_id: id,
  type: "engine.item.completed",
  kind: "command",
  title: `Recorded event ${seq}`,
  text: `Command ${seq}`,
  truncated: seq === 4,
  size_bytes: 3000,
  created_at: at,
});
const page = (
  items: StoryActivityItem[],
  more = false,
  order: "asc" | "desc" = "desc",
  id = "turn-a",
) => ({
  turn: turn(id),
  items,
  has_more: more,
  next_cursor: more ? items.at(-1)?.seq : null,
  order,
});
let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function flush() {
  await act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}
async function render(id = "turn-a") {
  await act(async () =>
    root.render(
      <RunActivity projectId="project" storyId="story" turnId={id} progressMessages={null} />,
    ),
  );
}
function button(text: string) {
  const node = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.startsWith(text),
  );
  if (!node) throw Error(`Missing ${text}`);
  return node;
}
async function toggle(open: boolean) {
  const details = container.querySelector("details");
  if (!details) throw Error("Missing details");
  await act(async () => {
    details.open = open;
    details.dispatchEvent(new Event("toggle"));
  });
  await flush();
}
async function click(text: string) {
  await act(async () => button(text).click());
  await flush();
}
const entries = () => [...container.querySelectorAll("li")].map((node) => node.textContent);

describe("live run activity", () => {
  it("keeps read history and full evidence stable while an entire burst is buffered and then shown once", async () => {
    let burst = false;
    fetcher.mockImplementation(async (input: string) => {
      const url = new URL(input, "http://local");
      if (url.pathname.endsWith("/events/4"))
        return Response.json({ data: { full: "Retained original output" } });
      if (url.searchParams.has("after")) {
        const all = burst ? Array.from({ length: 29 }, (_, i) => item(i + 6)) : [];
        const fresh = all.filter((e) => e.seq > Number(url.searchParams.get("after")));
        return Response.json(page(fresh.slice(0, 10), fresh.length > 10, "asc"));
      }
      if (url.searchParams.has("before")) return Response.json(page([item(3), item(2), item(1)]));
      return Response.json(page([item(5), item(4)], true));
    });
    await render();
    expect(fetcher).not.toHaveBeenCalled();
    await toggle(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await click("Load the full stored event");
    await click("Older activity");
    expect(entries()).toHaveLength(5);
    expect(container.textContent).toContain("Retained original output");
    const focused = button("Check now");
    focused.focus();
    burst = true;
    await act(async () => vi.advanceTimersByTimeAsync(8000));
    await flush();
    expect(entries()).toHaveLength(5);
    expect(container.textContent).toContain("Show new activity (29)");
    expect(document.activeElement).toBe(focused);
    expect(container.textContent).toContain("Retained original output");
    const show = button("Show new activity");
    show.focus();
    await click("Show new activity");
    expect(entries()).toHaveLength(34);
    expect(entries()[0]).toContain("Recorded event 34");
    expect(entries().at(-1)).toContain("Recorded event 1");
    expect(container.textContent).toContain("Retained original output");
    expect(document.activeElement).toBe(show);
    await click("Check now");
    expect(container.textContent).toContain("Show new activity (0)");
    expect(entries()).toHaveLength(34);
    expect(fetcher.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
  });
  it("bounds a large catch-up and continues from the last consumed event", async () => {
    fetcher.mockImplementation(async (input: string) => {
      const after = new URL(input, "http://local").searchParams.get("after");
      if (after === null) return Response.json(page([item(5)]));
      const fresh = Array.from({ length: 120 }, (_, i) => item(i + 6)).filter(
        (e) => e.seq > Number(after),
      );
      return Response.json(page(fresh.slice(0, 10), fresh.length > 10, "asc"));
    });
    await render();
    await toggle(true);
    await click("Check now");
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(container.textContent).toContain("Show new activity (50)");
    expect(container.textContent).toContain("More new activity available");
    await click("Check now");
    expect(container.textContent).toContain("Show new activity (100)");
    await click("Check now");
    expect(container.textContent).toContain("Show new activity (120)");
    await click("Show new activity");
    expect(entries()).toHaveLength(121);
    expect(entries()[0]).toContain("Recorded event 125");
    expect(entries().at(-1)).toContain("Recorded event 5");
  });

  it("finishes an in-flight page but stops catch-up when the reader closes the panel", async () => {
    let finish: (response: Response) => void = () => {};
    fetcher.mockImplementation((input: string) =>
      input.includes("after=")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(Response.json(page([item(5)]))),
    );
    await render();
    await toggle(true);
    await act(async () => button("Check now").click());
    await toggle(false);
    await act(async () => finish(Response.json(page([item(6)], true, "asc"))));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Show new activity (1)");
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("checks only while open and visible and resumes from the consumed sequence", async () => {
    fetcher.mockImplementation(async (input: string) =>
      Response.json(input.includes("after=") ? page([], false, "asc") : page([item(5)])),
    );
    await render();
    await toggle(true);
    await toggle(false);
    const closed = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(fetcher).toHaveBeenCalledTimes(closed);
    await toggle(true);
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("after=5");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const hidden = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(fetcher).toHaveBeenCalledTimes(hidden);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(hidden + 1);
  });
  it("preserves prior evidence on read failure and refuses an older server that ignores the incremental cursor", async () => {
    let mode = "error";
    fetcher.mockImplementation(async (input: string) => {
      if (!input.includes("after=")) return Response.json(page([item(5)]));
      if (mode === "error")
        return Response.json({ error: { message: "Read unavailable" } }, { status: 503 });
      if (mode === "old") return Response.json({ ...page([item(5)]), order: undefined });
      return Response.json(page([item(6)], false, "asc"));
    });
    await render();
    await toggle(true);
    await click("Check now");
    expect(container.textContent).toContain("Read unavailable");
    expect(entries()).toHaveLength(1);
    mode = "old";
    await click("Check now");
    expect(container.textContent).toContain("cannot confirm incremental activity");
    const requests = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(16000));
    expect(fetcher).toHaveBeenCalledTimes(requests);
    mode = "ok";
    await click("Check now");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("Show new activity (1)");
  });
  it("ignores late activity from a previously inspected run", async () => {
    let finish: (r: Response) => void = () => {};
    fetcher.mockImplementation((input: string) =>
      input.includes("turn-a")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(Response.json(page([item(9, "turn-b")], false, "desc", "turn-b"))),
    );
    await render();
    await toggle(true);
    await render("turn-b");
    await toggle(true);
    await act(async () => finish(Response.json(page([item(5)]))));
    await flush();
    expect(entries()).toHaveLength(1);
    expect(entries()[0]).toContain("Recorded event 9");
    expect(container.textContent).not.toContain("Recorded event 5");
  });
  it("distinguishes unavailable latest activity from an observed empty history without fetching", async () => {
    await act(async () =>
      root.render(<StoryProgress projectId="project" storyId="story" progress={undefined} />),
    );
    expect(container.textContent).toContain("unavailable from this server");
    expect(container.textContent).not.toContain("No work activity recorded");
    await act(async () =>
      root.render(
        <StoryProgress
          projectId="project"
          storyId="story"
          progress={{ observedAt: at, latest: null }}
        />,
      ),
    );
    expect(container.textContent).toContain("No work activity recorded yet");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("pins an inspected run when the story's latest activity changes", async () => {
    fetcher.mockImplementation(async () => Response.json(page([item(5)])));
    const progress = (id: string): WorkspaceStoryBundle["progress"] => ({
      observedAt: at,
      latest: { turn: turn(id), activity: item(5, id) },
    });
    await act(async () =>
      root.render(
        <StoryProgress projectId="project" storyId="story" progress={progress("turn-a")} />,
      ),
    );
    expect(fetcher).not.toHaveBeenCalled();
    await click("Inspect this run");
    await act(async () =>
      root.render(
        <StoryProgress projectId="project" storyId="story" progress={progress("turn-b")} />,
      ),
    );
    expect(container.textContent).toContain("this inspection stays on the selected run");
    expect(container.textContent).toContain("turn-a");
    await click("Check now");
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toContain("/turns/turn-a/activity");
  });
});
