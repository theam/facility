// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewStory } from "../components/story/new-story";
import { engineIdentity, providerIdentity } from "../lib/ai-identity";
import type { AgentChoice } from "../lib/backlog-presentation";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const agents: AgentChoice[] = ["builder", "architect"].map((name) => ({
  name,
  description: `${name} action`,
  engine: engineIdentity("codex"),
  provider: providerIdentity("openai"),
  model: "gpt-5.5",
  isDefault: name === "builder",
}));
let container: HTMLDivElement;
let root: Root;
let fetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetch = vi.fn(async () =>
    Response.json(
      { error: { code: "agent_unavailable", message: "Agent is not available" } },
      { status: 409 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  await act(async () =>
    root.render(
      <NewStory
        projectId="project-a"
        agents={agents}
        defaultAgent="builder"
        titleGeneration={false}
        linked={null}
        clearHref="/projects/project-a/stories#new-story"
      />,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function type(text: string) {
  const node = container.querySelector("textarea");
  if (!node) throw Error("Missing request");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(node, text);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
function attempts() {
  return fetch.mock.calls.map(([, init]) => {
    const body = JSON.parse(String(init?.body)) as { idempotency_key: string; message: string };
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(body.idempotency_key);
    return body;
  });
}

describe("new story idempotency", () => {
  it("retries an unchanged request with the same key", async () => {
    await type("Add a health check");
    await submit();
    await submit();
    const [first, second] = attempts();
    expect(container.textContent).toContain("Agent is not available");
    expect(second?.idempotency_key).toBe(first?.idempotency_key);
  });

  it("uses a new key once the failed request is edited", async () => {
    await type("Add a health check");
    await submit();
    await type("Add a health check and document it");
    await submit();
    const [first, second] = attempts();
    expect(second?.message).toBe("Add a health check and document it");
    expect(second?.idempotency_key).not.toBe(first?.idempotency_key);
  });

  it("uses a new key once a different action is chosen", async () => {
    await type("Add a health check");
    await submit();
    const architect = [...container.querySelectorAll("label")]
      .find((label) => label.textContent?.startsWith("architect"))
      ?.querySelector("input");
    await act(async () => architect?.click());
    await submit();
    const [first, second] = attempts();
    expect(first).not.toHaveProperty("agent");
    expect(second).toMatchObject({ agent: "architect", message: "Add a health check" });
    expect(second?.idempotency_key).not.toBe(first?.idempotency_key);
  });
});
