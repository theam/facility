// @vitest-environment jsdom
import { createServer } from "node:http";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { WorkspaceControls } from "../components/story/workspace-story-controls";
import type { StoryWorkspace, WorkspaceStory } from "../lib/api";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const story: WorkspaceStory = {
  id: "story_preview",
  provider: "manual",
  externalId: "preview",
  title: "Preview",
  titleSource: "user",
  createdAt: "2026-09-09T00:00:00Z",
  status: "working",
  activeAgentName: null,
  branch: "main",
  pullRequestNumber: null,
  pullRequestUrl: null,
  updatedAt: "2026-09-09T00:00:00Z",
  archivedAt: null,
  deletedAt: null,
};
const workspace: StoryWorkspace = {
  id: "ws_preview",
  provider: "fake",
  state: "running",
  volumeRef: "retained",
  setupChecksum: "prepared",
  environment: { ports: [{ service: "app", port: 3000 }] },
  endpoints: [],
  error: null,
  lastActivityAt: story.updatedAt,
  destroyedAt: null,
};
const nativeFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let opened: MockInstance<typeof window.open>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  opened = vi.spyOn(window, "open").mockReturnValue(null);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(canExecute = true) {
  await act(async () =>
    root.render(
      <WorkspaceControls
        projectId="proj_preview"
        story={story}
        workspace={workspace}
        canExecute={canExecute}
        canWrite={false}
      />,
    ),
  );
}
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw Error(`Missing button: ${label}`);
  return found;
}
async function clickAndWait(label: string, done: () => boolean) {
  await act(async () => {
    button(label).click();
    for (let i = 0; i < 200 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done()).toBe(true);
  });
}

describe("preview launch controls", () => {
  it("requests a fresh grant for reopening instead of rendering a consumed bearer link", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ url: "https://preview.test/auth?token=first" }))
      .mockResolvedValueOnce(Response.json({ url: "https://preview.test/auth?token=second" }));
    vi.stubGlobal("fetch", fetch);
    await render();
    await clickAndWait("open app ↗", () => opened.mock.calls.length === 1);
    expect(container.querySelector("a[href*='token=']")).toBeNull();
    await clickAndWait("Open a new authenticated preview ↗", () => opened.mock.calls.length === 2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(opened.mock.calls.map((call) => call[0])).toEqual([
      "https://preview.test/auth?token=first",
      "https://preview.test/auth?token=second",
    ]);
    expect(opened).toHaveBeenLastCalledWith(expect.any(String), "_blank", "noopener,noreferrer");
  });

  it("shows authorization failures without opening or reusing the previous grant", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ url: "https://preview.test/auth?token=first" }))
        .mockResolvedValueOnce(
          Response.json({ error: { message: "Permission denied" } }, { status: 403 }),
        ),
    );
    await render();
    await clickAndWait("open app ↗", () => opened.mock.calls.length === 1);
    await clickAndWait("Open a new authenticated preview ↗", () => !button("open app ↗").disabled);
    expect(container.querySelector("[role='alert']")?.textContent).toBe("Permission denied");
    expect(opened).toHaveBeenCalledTimes(1);
    expect(container.querySelector("a[href*='token=']")).toBeNull();
  });

  it("does not offer preview launches without execution permission", async () => {
    await render(false);
    expect(container.querySelector("button")).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });
});

it("integrates repeated UI launches with a local one-time exchange server", async () => {
  const issued = new Set<string>();
  const consumed = new Set<string>();
  let count = 0;
  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    response.setHeader("content-type", "application/json");
    if (
      request.method === "POST" &&
      url.pathname ===
        "/api/v1/projects/proj_preview/workspace-stories/story_preview/preview/app/open"
    ) {
      const token = `grant-${++count}`;
      issued.add(token);
      response.end(JSON.stringify({ url: `${origin}/exchange?token=${token}` }));
    } else if (url.pathname === "/exchange") {
      const token = url.searchParams.get("token") ?? "";
      response.statusCode = issued.has(token) && !consumed.has(token) ? 200 : 401;
      consumed.add(token);
      response.end("{}");
    } else {
      response.statusCode = 404;
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing test server address");
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) =>
    nativeFetch(new URL(input, origin), init),
  );
  try {
    await render();
    await clickAndWait("open app ↗", () => opened.mock.calls.length === 1);
    const first = String(opened.mock.calls[0]?.[0]);
    expect((await nativeFetch(first)).status).toBe(200);
    expect((await nativeFetch(first)).status).toBe(401);
    await clickAndWait("Open a new authenticated preview ↗", () => opened.mock.calls.length === 2);
    const second = String(opened.mock.calls[1]?.[0]);
    expect(second).not.toBe(first);
    expect((await nativeFetch(second)).status).toBe(200);
    expect(count).toBe(2);
    expect(container.querySelector("a[href*='token=']")).toBeNull();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
