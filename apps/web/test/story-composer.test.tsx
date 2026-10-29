// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryActions } from "../components/story/story-actions";
import type { StoryAgent, WorkspaceStory } from "../lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("../components/story/story-conversation", () => ({
  COMPOSE_EVENT: "facility:story-compose",
}));
vi.mock("../components/story/workspace-story-controls", () => ({
  WorkspaceControls: () => null,
  CancelTurnButton: () => null,
  storyPath: (project: string, story: string, suffix: string) =>
    `/v1/projects/${project}/workspace-stories/${story}${suffix}`,
}));

const agents = ["designer", "implementer"].map(
  (name) => ({ name, model: "example-model", engine: "codex", enabled: true }) as StoryAgent,
);
const baseStory = {
  id: "story-a",
  deletedAt: null,
  pullRequestUrl: null,
  pullRequestNumber: null,
} as WorkspaceStory;
let container: HTMLDivElement;
let root: Root;
let fetch: ReturnType<typeof vi.fn>;
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  fetch = vi.fn(async () => Response.json({ queued: { queued: false } }));
  vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(owner = "person-a", story = "story-a", catalog = agents) {
  await act(async () =>
    root.render(
      <StoryActions
        key={`${owner}:${story}`}
        projectId="project-a"
        draftOwnerId={owner}
        story={{ ...baseStory, id: story }}
        workspace={null}
        agents={catalog}
        canExecute
        canWrite={false}
        activeTurn={null}
        waitingAgent={null}
        artifacts={[]}
      />,
    ),
  );
}
function button(text: string) {
  const result = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === text,
  );
  if (!result) throw Error(`Missing button: ${text}`);
  return result;
}
function message() {
  const node = container.querySelector("textarea");
  if (!node) throw Error("Missing message");
  return node;
}
function recipient() {
  const node = container.querySelector("select");
  if (!node) throw Error("Missing recipient");
  return node;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function reply(agent: string) {
  await act(async () =>
    window.dispatchEvent(new CustomEvent("facility:story-compose", { detail: { agent } })),
  );
}
async function type(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      message(),
      text,
    );
    message().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

describe("story composer continuity", () => {
  it("retargets and focuses every Reply while preserving the open draft without dispatching", async () => {
    await render();
    await reply("designer");
    await type("Preserve this review context");
    button("send a task").focus();
    await reply("implementer");
    expect(recipient().value).toBe("implementer");
    expect(message().value).toBe("Preserve this review context");
    expect(document.activeElement).toBe(message());
    expect(scroll).toHaveBeenCalled();
    button("send a task").focus();
    await reply("implementer");
    expect(document.activeElement).toBe(message());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps close separate from explicit discard", async () => {
    await render();
    await reply("designer");
    await type("Unsent draft");
    await click("close");
    expect(document.activeElement).toBe(button("send a task"));
    await click("send a task");
    expect(message().value).toBe("Unsent draft");
    await click("discard draft");
    expect(message().value).toBe("");
    expect(container.textContent).toContain("Draft discarded.");
    await type("A new draft");
    expect(container.textContent).not.toContain("Draft discarded.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("restores a draft after remount and isolates people and stories", async () => {
    await render();
    await reply("implementer");
    await type("Only person A, story A");
    await render("person-b");
    await click("send a task");
    expect(message().value).toBe("");
    await render("person-a", "story-b");
    await click("send a task");
    expect(message().value).toBe("");
    await render();
    await click("send a task");
    expect(message().value).toBe("Only person A, story A");
    expect(recipient().value).toBe("implementer");
  });

  it("preserves text when the selected agent disappears and requires another selection", async () => {
    await render();
    await reply("designer");
    await type("Do not silently reroute");
    await render(
      "person-a",
      "story-a",
      agents.filter((agent) => agent.name === "implementer"),
    );
    expect(message().value).toBe("Do not silently reroute");
    expect(recipient().value).toBe("");
    expect(button("send to agent").disabled).toBe(true);
    await submit();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves text and recipient through failure and retries with the same idempotency key", async () => {
    fetch.mockResolvedValueOnce(
      Response.json({ error: { message: "Temporary failure" } }, { status: 503 }),
    );
    await render();
    await reply("implementer");
    await type("Retry this exact request");
    await submit();
    expect(message().value).toBe("Retry this exact request");
    expect(container.textContent).toContain("Temporary failure");
    await submit();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = fetch.mock.calls;
    if (!firstCall || !secondCall) throw Error("Missing send attempts");
    const first = JSON.parse(firstCall[1].body);
    const second = JSON.parse(secondCall[1].body);
    expect(first.idempotency_key).toBe(second.idempotency_key);
    expect(first.agent).toBe("implementer");
    expect(first.message).toBe("Retry this exact request");
    await render("person-b");
    await render();
    await click("send a task");
    expect(message().value).toBe("");
  });

  it("guards duplicate submits while a request is in flight", async () => {
    let finish: (value: Response) => void = () => undefined;
    fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await reply("designer");
    await type("Only one dispatch");
    await submit();
    await submit();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(message().disabled).toBe(true);
    await act(async () => finish(Response.json({ queued: { queued: true } })));
    expect(container.textContent).toContain("Queued for designer");
  });

  it("keeps composition usable when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("full");
    });
    await render();
    await reply("implementer");
    await type("Keep in-memory text");
    await click("close");
    await click("send a task");
    expect(message().value).toBe("Keep in-memory text");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains the draft when no agents remain and can recover after the catalog returns", async () => {
    await render();
    await reply("designer");
    await type("Wait for an available agent");
    await render("person-a", "story-a", []);
    expect(message().value).toBe("Wait for an available agent");
    expect(button("send to agent").disabled).toBe(true);
    await submit();
    expect(fetch).not.toHaveBeenCalled();
    await render();
    expect(message().value).toBe("Wait for an available agent");
    expect(recipient().value).toBe("designer");
  });

  it("restores an uncertain failed send and reuses its key after navigation", async () => {
    fetch.mockRejectedValueOnce(Error("Connection lost"));
    await render();
    await reply("implementer");
    await type("The server may already have accepted this");
    await submit();
    const failed = fetch.mock.calls[0];
    if (!failed) throw Error("Missing failed attempt");
    const key = JSON.parse(failed[1].body).idempotency_key;
    await render("person-b");
    await render();
    await click("send a task");
    await submit();
    const retried = fetch.mock.calls[1];
    if (!retried) throw Error("Missing retry");
    expect(JSON.parse(retried[1].body).idempotency_key).toBe(key);
  });

  it("uses a new request identity after the failed request is edited", async () => {
    fetch.mockRejectedValueOnce(Error("Connection lost"));
    await render();
    await reply("implementer");
    await type("Original request");
    await submit();
    await type("Changed scope");
    await submit();
    const [original, changed] = fetch.mock.calls;
    if (!original || !changed) throw Error("Missing attempts");
    expect(JSON.parse(changed[1].body).idempotency_key).not.toBe(
      JSON.parse(original[1].body).idempotency_key,
    );
  });
});

describe("draft ownership and explicit recipient intent", () => {
  it("preserves an explicitly changed recipient when closing and reopening", async () => {
    await render();
    await reply("designer");
    await type("Please implement this change");
    await act(async () => {
      recipient().value = "implementer";
      recipient().dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(recipient().value).toBe("implementer");
    await click("close");
    await click("send a task");
    expect(message().value).toBe("Please implement this change");
    expect(recipient().value).toBe("implementer");
  });

  it("does not clear a newer restored draft when an old in-flight send completes", async () => {
    let finish!: (value: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await reply("implementer");
    await type("First message, still sending");
    await submit();
    await render("person-a", "story-b");
    await render();
    await click("send a task");
    expect(message().value).toBe("First message, still sending");
    await type("New unsent message after navigation");
    const storedKey = sessionStorage.key(0);
    if (!storedKey) throw Error("Missing retained draft");
    expect(sessionStorage.getItem(storedKey)).toContain("New unsent message");
    await act(async () => finish(Response.json({ queued: { queued: false } })));
    expect(message().value).toBe("New unsent message after navigation");
    await render("person-a", "story-b");
    await render();
    await click("send a task");
    expect(message().value).toBe("New unsent message after navigation");
  });
});
