// @vitest-environment jsdom
import type { StoryDelivery } from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixtureData from "../../../packages/core/test/fixtures/delivery-decision-brief.json";
import { DeliveryDecisionBrief } from "../components/story/delivery-decision-brief";

type Projection = NonNullable<StoryDelivery["decisionBrief"]>;
const fixture = fixtureData as {
  subject: Extract<Projection, { status: "available" }>["subject"];
  brief: Extract<Projection, { status: "available" }>["brief"];
};

const source = {
  messageId: "msg-review",
  seq: 1,
  createdAt: "2026-11-05T12:00:00Z",
  digest: "e".repeat(64),
  turn: {
    id: "turn-review",
    agentName: "custom-reviewer",
    engine: "codex",
    model: "configured-model",
  },
};
const available: Projection = {
  status: "available",
  source,
  subject: fixture.subject,
  brief: fixture.brief,
};
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const render = async (projection?: Projection) =>
  act(async () =>
    root.render(<DeliveryDecisionBrief projection={projection} storyUrl="/projects/p/stories/s" />),
  );
describe("delivery author brief", () => {
  it("presents the same saved claims and sources in three formats with an exact original link", async () => {
    await render(available);
    expect(container.textContent).toContain("custom-reviewer");
    expect(container.textContent).toContain("Supplied for delivery scope r4");
    expect(container.textContent).not.toContain("plan r");
    const original = container.querySelector('a[href*="messageId"]');
    expect(original?.getAttribute("href")).toBe(
      "/projects/p/stories/s?messageId=msg-review#message-msg-review",
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const format of ["summary", "comparison", "diagram"]) {
      const input = container.querySelector<HTMLInputElement>(`input[value="${format}"]`);
      if (!input) throw Error("Missing format");
      await act(async () => input.click());
      expect(input.checked).toBe(true);
      expect(container.textContent).toContain(fixture.brief.summary.text);
      expect(container.textContent).toContain(fixture.brief.decisiveRisk.text);
      expect(container.textContent).toContain("Author recommends:");
      expect(
        container.querySelectorAll('a[href="https://example.com/reviews/delivery-4"]').length,
      ).toBeGreaterThan(0);
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
  it.each([
    "stale",
    "unverifiable",
  ] as const)("keeps a %s brief behind an explicit historical disclosure", async (status) => {
    await render({
      ...available,
      status,
      reason: status === "stale" ? "heads_changed" : "observations_stale",
    } as Projection);
    const disclosure = [...container.querySelectorAll("details")].find(
      (node) => node.querySelector("summary")?.textContent === "Read the saved author statements",
    );
    expect(disclosure).toBeDefined();
    expect(disclosure?.open).toBe(false);
    expect(container.textContent).toContain(
      status === "stale" ? "Historical brief" : "Brief is not verified",
    );
    expect(container.querySelector('a[href*="msg-review"]')).not.toBeNull();
  });
  it("shows an invalid latest source without an older recommendation and handles absent or legacy projections", async () => {
    await render({
      status: "invalid",
      reason: "malformed",
      source: { ...source, messageId: "msg-latest" },
    });
    expect(container.textContent).toContain("could not be parsed");
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(container.querySelector('a[href*="msg-latest"]')).not.toBeNull();
    await render({ status: "absent" });
    expect(container.textContent).toContain("No author delivery brief is recorded");
    await render();
    expect(container.textContent).toBe("");
  });
});
