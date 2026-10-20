// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryComposer } from "../components/story/story-actions";
import type { StoryAgent } from "../lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const agents = [{ name: "builder", enabled: true, model: "example-model" }] as StoryAgent[];
const holder = {
  kind: "person",
  turnId: "turn_original",
  name: "Ada",
  since: "2026-01-01T00:00:00Z",
};
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
async function compose(control = true) {
  await act(async () =>
    root.render(
      <StoryComposer
        projectId="project"
        storyId="story"
        agents={agents}
        canControlSession={control}
      />,
    ),
  );
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      "Please continue",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
describe("interactive session send choices", () => {
  it("queues without interrupting, or requires the exact displayed holder for takeover", async () => {
    const fetch = vi.fn(async (_input: unknown, options: RequestInit) =>
      Response.json(options.method === "GET" ? { holder } : { queued: { queued: true } }),
    );
    vi.stubGlobal("fetch", fetch);
    await compose();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.querySelector("dialog")?.textContent).toContain("Ada");
    await act(async () => button("Cancel").click());
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await act(async () => button("Send when it ends").click());
    const queued = JSON.parse(String(fetch.mock.calls.at(-1)?.[1].body));
    expect(queued).toMatchObject({ message: "Please continue", agent: "builder" });
    expect(queued).not.toHaveProperty("takeover_turn_id");
    await compose();
    await act(async () => button("Take over and send now").click());
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1].body))).toMatchObject({
      takeover_turn_id: "turn_original",
      confirm_takeover: true,
    });
  });
  it("keeps the queue available without offering takeover to an observer", async () => {
    const fetch = vi.fn(async () => Response.json({ holder }));
    vi.stubGlobal("fetch", fetch);
    await compose(false);
    expect(container.textContent).toContain("Send when it ends");
    expect(container.textContent).not.toContain("Take over and send now");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not send when the fresh ownership lookup fails", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { message: "Permission denied" } }, { status: 403 }),
    );
    vi.stubGlobal("fetch", fetch);
    await compose();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Permission denied");
  });
});
