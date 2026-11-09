// @vitest-environment jsdom
import type {
  StoryAgent,
  StoryConsultation,
  StoryConsultationOptions,
  StoryConsultations,
} from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoryConsultationPanel } from "../components/story/story-consultation";
import { consultationDraftKey, readConsultationDraft } from "../lib/consultation-draft";
import { readStoryDraft, storyDraftKey, writeStoryDraft } from "../lib/story-draft";

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

const sha = "a".repeat(40),
  newerSha = "b".repeat(40);
const agent = { name: "reviewer", engine: "codex", model: "gpt-5.5", enabled: true } as StoryAgent;
function capabilities(): StoryConsultationOptions {
  return {
    costsVisible: true,
    executor: "provider_api_text",
    catalogSha: sha,
    agents: [
      {
        ...agent,
        reasoningEffort: "high",
        manifestHash: "original-manifest",
        eligible: true,
        reason: null,
        estimateCents: 2,
      },
    ],
    repositories: [{ id: "repo-a", repository: "example/project", branch: "main", commitSha: sha }],
    limits: { files: 4, fileBytes: 8192, requestBytes: 8000, outputTokens: 2048 },
  };
}
function consultation(overrides: Partial<StoryConsultation> = {}): StoryConsultation {
  return {
    id: "cons-a",
    storyId: "story-a",
    state: "succeeded",
    executor: "provider_api_text",
    agent: {
      name: "reviewer",
      engine: "codex",
      model: "gpt-5.5",
      reasoningEffort: "high",
      manifestHash: "original-manifest",
      catalogSha: sha,
    },
    provider: "openai",
    providerModel: "gpt-5.5",
    request: "Review this proposal",
    result: "Suggested implementation",
    resultHash: "r".repeat(43),
    errorCode: null,
    actor: { type: "user", id: "person-a", name: "Test person" },
    context: {
      hash: "h".repeat(43),
      taskState: null,
      throughMessageSeq: 3,
      omittedMessages: 0,
      summaryIncluded: true,
      omissions: ["Uncommitted workspace files are excluded"],
      requestedSources: [],
      workspaceFilesIncluded: false,
      files: [],
    },
    billing: { costsVisible: true, state: "confirmed", costCents: 1, estimatedCents: 2 },
    createdAt: "2026-10-21T12:00:00.000Z",
    startedAt: "2026-10-21T12:00:01.000Z",
    endedAt: "2026-10-21T12:00:02.000Z",
    expiresAt: "2026-10-21T12:02:00.000Z",
    cancelRequestedAt: null,
    ...overrides,
  };
}
function listing(items: StoryConsultation[] = []): StoryConsultations {
  return { items, total: items.length, limit: 10, offset: 0 };
}
let container: HTMLDivElement, root: Root;
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let options: StoryConsultationOptions, saved: StoryConsultations;
let failPost: boolean, failHistory: boolean;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
  options = capabilities();
  saved = listing();
  failPost = false;
  failHistory = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/options")) return Response.json(options);
    if (url.endsWith("/handoff"))
      return Response.json({
        consultationId: "cons-a",
        resultHash: "r".repeat(43),
        agent: "reviewer",
        message: "Implement the selected result from cons-a with its recorded hash.",
        requiresExplicitSend: true,
      });
    if (url.endsWith("/messages")) return Response.json({ queued: { queued: false } });
    if (url.endsWith("/cancel")) return Response.json(consultation({ state: "canceled" }));
    if (init?.method === "POST") {
      if (failPost) throw new Error("Response lost");
      const item = consultation({
        state: "queued",
        result: null,
        resultHash: null,
        startedAt: null,
        endedAt: null,
        billing: {
          costsVisible: false,
          state: "not_started",
          costCents: null,
          estimatedCents: null,
        },
      });
      saved = listing([item]);
      return Response.json(item, { status: 202 });
    }
    if (failHistory)
      return Response.json({ error: { message: "History unavailable" } }, { status: 503 });
    return Response.json(saved);
  });
  vi.stubGlobal("fetch", fetch);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render({
  owner = "person-a",
  story = "story-a",
  execute = true,
  initial = listing(),
  initialError,
}: {
  owner?: string;
  story?: string;
  execute?: boolean;
  initial?: StoryConsultations;
  initialError?: string;
} = {}) {
  await act(async () =>
    root.render(
      <StoryConsultationPanel
        key={`${owner}:${story}`}
        projectId="project-a"
        storyId={story}
        initial={initialError ? undefined : initial}
        initialError={initialError}
        agents={[agent]}
        defaultAgent="reviewer"
        canExecute={execute}
        draftOwnerId={owner}
      />,
    ),
  );
}
function button(text: string) {
  const node = [...container.querySelectorAll("button")].find(
    (node) => node.textContent?.replace(/→$/, "").trim() === text,
  );
  if (!node) throw Error(`Missing button: ${text}`);
  return node;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
function control(label: string): HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement {
  const node = [...container.querySelectorAll("label")]
    .find((node) => node.querySelector("span")?.textContent === label)
    ?.querySelector("input,textarea,select");
  if (!node) throw Error(`Missing control: ${label}`);
  return node as ReturnType<typeof control>;
}
async function change(label: string, value: string) {
  await act(async () => {
    const node = control(label);
    const prototype =
      node instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(node, value);
    node.dispatchEvent(
      new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
    );
  });
}
async function submit(label = "Start a read-only consultation") {
  await act(async () =>
    container
      .querySelector(`form[aria-label="${label}"]`)
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
const posts = () => fetch.mock.calls.filter(([, init]) => init?.method === "POST");

describe("story consultation UI boundaries", () => {
  it("opens a focused draft using a read-only capability check and keeps an ineligible configured agent", async () => {
    options = {
      ...options,
      agents: options.agents.map((entry) => ({
        ...entry,
        eligible: false,
        reason: "provider_api_key_unavailable",
      })),
    };
    await render();
    expect(fetch).not.toHaveBeenCalled();
    await click("New consultation");
    expect(control("Consult with").value).toBe("reviewer");
    expect(document.activeElement).toBe(control("Consultation question"));
    await change("Consultation question", "Can you review this?");
    expect(button("Start consultation").disabled).toBe(true);
    expect(container.textContent).toContain("Native subscription login is not used");
    expect(posts()).toHaveLength(0);
  });

  it("preserves a separate draft and pinned sources across close, refresh and account/story changes", async () => {
    writeStoryDraft(storyDraftKey("person-a", "project-a", "story-a"), {
      agent: "reviewer",
      message: "Existing implementation draft",
    });
    await render();
    await click("New consultation");
    await change("Consultation question", "Saved consultation draft");
    await click("Add source file");
    await change("Source 1 repository", "repo-a");
    await change("Source 1 file path", "src/service.ts");
    options = {
      ...options,
      catalogSha: newerSha,
      repositories: options.repositories.map((repository) => ({
        ...repository,
        commitSha: newerSha,
      })),
    };
    await click("Refresh options");
    expect(control("Source 1 exact commit").value).toBe(sha);
    await click("Close consultation draft");
    await click("Resume consultation draft");
    expect(control("Consultation question").value).toBe("Saved consultation draft");
    await render({ owner: "person-b" });
    await click("New consultation");
    expect(control("Consultation question").value).toBe("");
    await render({ story: "story-b" });
    await click("New consultation");
    expect(control("Consultation question").value).toBe("");
    await render();
    await click("Resume consultation draft");
    expect(control("Consultation question").value).toBe("Saved consultation draft");
    expect(control("Source 1 exact commit").value).toBe(sha);
    expect(readStoryDraft(storyDraftKey("person-a", "project-a", "story-a"))?.message).toBe(
      "Existing implementation draft",
    );
    expect(posts()).toHaveLength(0);
  });

  it("retries the exact original paid intent after a lost response and remount despite newer configuration", async () => {
    failPost = true;
    await render();
    await click("New consultation");
    await change("Consultation question", "Paid question");
    await submit();
    const first = posts()[0];
    expect(first).toBeDefined();
    expect(container.textContent).toContain("Response lost");
    const durable = readConsultationDraft(consultationDraftKey("person-a", "project-a", "story-a"));
    expect(durable?.attempt?.body).toEqual(JSON.parse(String(first?.[1]?.body)));
    options = {
      ...options,
      catalogSha: newerSha,
      agents: options.agents.map((entry) => ({
        ...entry,
        model: "gpt-5.4",
        manifestHash: "new-manifest",
      })),
    };
    await render({ owner: "person-b" });
    await render();
    await click("Resume consultation draft");
    expect(control("Consultation question").disabled).toBe(true);
    expect(container.textContent).toContain("Retry the original request for gpt-5.5");
    failPost = false;
    await submit();
    expect(posts()).toHaveLength(2);
    expect(posts()[1]?.[1]?.body).toBe(first?.[1]?.body);
    expect(new Headers(posts()[1]?.[1]?.headers).get("idempotency-key")).toBe(
      new Headers(first?.[1]?.headers).get("idempotency-key"),
    );
    expect(
      readConsultationDraft(consultationDraftKey("person-a", "project-a", "story-a")),
    ).toBeNull();
  });

  it("creates a new paid identity only after explicitly editing an unresolved intent", async () => {
    failPost = true;
    await render();
    await click("New consultation");
    await change("Consultation question", "Original question");
    await submit();
    await click("Edit as a new request");
    await change("Consultation question", "Changed question");
    await submit();
    const bodies = posts().map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies[0].idempotency_key).not.toBe(bodies[1].idempotency_key);
    expect(bodies[1].message).toBe("Changed question");
  });

  it("prepares an editable implementation request and starts work only on its separate send", async () => {
    writeStoryDraft(storyDraftKey("person-a", "project-a", "story-a"), {
      agent: "reviewer",
      message: "Main draft",
    });
    await render({ initial: listing([consultation()]) });
    await click("Prepare implementation request");
    expect(posts()).toHaveLength(0);
    expect(control("Message").value).toContain("cons-a with its recorded hash");
    expect(document.activeElement).toBe(control("Message"));
    await change("Message", "Implement only the reviewed change from cons-a.");
    await submit("Send an implementation request");
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0]?.[0])).toMatch(/\/messages$/);
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toMatchObject({
      agent: "reviewer",
      message: "Implement only the reviewed change from cons-a.",
    });
    expect(readStoryDraft(storyDraftKey("person-a", "project-a", "story-a"))?.message).toBe(
      "Main draft",
    );
  });

  it("renders untrusted output as text and hides mutation controls and costs from a viewer", async () => {
    const item = consultation({
      result:
        '<img src="https://example.test/steal" onerror="alert(1)"><script>alert(1)</script> [run](javascript:alert(1))',
      billing: { costsVisible: false, state: "confirmed", costCents: null, estimatedCents: null },
    });
    await render({ execute: false, initial: listing([item]) });
    expect(container.querySelector("pre")?.textContent).toBe(item.result);
    expect(container.querySelector("img,script,a")).toBeNull();
    expect(container.textContent).not.toContain("$0.01");
    expect(container.textContent).not.toContain("New consultation");
    expect(container.textContent).not.toContain("Prepare implementation request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps a failed history read distinct from an empty history and retains results and draft on refresh failure", async () => {
    await render({ initialError: "Initial history unavailable" });
    expect(container.textContent).toContain("Initial history unavailable");
    expect(container.textContent).not.toContain("No consultations saved");
    await render({ initial: listing([consultation()]) });
    await click("New consultation");
    await change("Consultation question", "Keep this draft");
    failHistory = true;
    await click("Refresh consultations");
    expect(container.textContent).toContain("History unavailable");
    expect(container.textContent).toContain("Suggested implementation");
    expect(control("Consultation question").value).toBe("Keep this draft");
    expect(posts()).toHaveLength(0);
  });

  it("removes observed cost details after permission loss and keeps a final result over a stale queued receipt", async () => {
    await render({ initial: listing([consultation()]) });
    expect(container.textContent).toContain("$0.01");
    saved = listing([
      consultation({
        state: "queued",
        result: null,
        resultHash: null,
        endedAt: null,
        billing: {
          costsVisible: false,
          state: "not_started",
          costCents: null,
          estimatedCents: null,
        },
      }),
    ]);
    await click("Refresh consultations");
    expect(container.textContent).toContain("Suggested implementation");
    expect(container.textContent).toContain("succeeded");
    expect(container.textContent).not.toContain("$0.01");
    expect(container.textContent).toContain("Cost details are unavailable");
  });

  it("blocks another consultation while one is active and exposes explicit cancellation", async () => {
    await render({
      initial: listing([
        consultation({ state: "running", endedAt: null, result: null, resultHash: null }),
      ]),
    });
    await click("New consultation");
    await change("Consultation question", "Wait for the active one");
    await submit();
    expect(button("Start consultation").disabled).toBe(true);
    expect(posts()).toHaveLength(0);
    await click("Cancel consultation");
    expect(posts()).toHaveLength(1);
    expect(String(posts()[0]?.[0])).toMatch(/\/cancel$/);
    expect(container.textContent).toContain("canceled");
  });

  it("keeps an admission estimate distinct from an unknown final charge and an absent result", async () => {
    await render({
      initial: listing([
        consultation({
          state: "failed",
          result: null,
          resultHash: null,
          errorCode: "consultation_provider_unavailable",
          billing: { costsVisible: true, state: "unconfirmed", costCents: null, estimatedCents: 2 },
        }),
      ]),
    });
    expect(container.textContent).toContain("Usage unconfirmed.");
    expect(container.textContent).toContain(
      "Admission estimate: $0.02. The final charge is unknown.",
    );
    expect(container.textContent).not.toContain("Reserved estimate");
    expect(container.querySelector("pre")).toBeNull();
  });
});
