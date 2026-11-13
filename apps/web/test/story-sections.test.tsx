// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StorySections } from "../components/story/story-sections";
import type { StoryFocus } from "../lib/story-focus";
import { requestPlanProposal } from "../lib/story-plan-events";

let container: HTMLDivElement;
let root: Root;
const mounted = vi.fn();
const unmounted = vi.fn();
const scroll = vi.fn();
const previousScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
function Draft({ id }: { id: string }) {
  useEffect(() => {
    mounted(id);
    return () => {
      unmounted(id);
    };
  }, [id]);
  return <textarea aria-label={id} defaultValue="Draft in progress" />;
}
const focus = (section: "plan" | "delivery", decision = true): StoryFocus => ({
  section,
  title: `Current ${section}`,
  detail: "Recorded next step",
  decision,
});
async function render(current = focus("plan"), navigationKey = "current") {
  await act(async () =>
    root.render(
      <StorySections
        focus={current}
        scope={{ projectId: "project", storyId: "story" }}
        navigationKey={navigationKey}
        conversation={
          <section id="conversation">
            <Draft id="conversation-draft" />
            <p id="message-source">Exact original</p>
            <a href="#story-section-delivery">Linked delivery evidence</a>
          </section>
        }
        sections={[
          {
            key: "plan",
            label: "Plan",
            content: (
              <section id="story-plan">
                <Draft id="plan-draft" />
              </section>
            ),
          },
          {
            key: "delivery",
            label: "Delivery",
            content: <section id="story-delivery">Exact delivery</section>,
          },
        ]}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(0), 0),
  );
  Object.defineProperty(Element.prototype, "scrollIntoView", { value: scroll, configurable: true });
  window.history.replaceState({}, "", "/");
  mounted.mockClear();
  unmounted.mockClear();
  scroll.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
  if (previousScroll) Object.defineProperty(Element.prototype, "scrollIntoView", previousScroll);
  else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
});
const panel = (key: string) =>
  container.querySelector<HTMLElement>(`[data-story-section="${key}"]`);
const tab = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
    (node) => node.textContent === label,
  );
const children = () =>
  [...(container.querySelector("[data-story-sections]")?.children ?? [])].map(
    (node) => node.getAttribute("data-story-section") ?? node.getAttribute("role") ?? node.tagName,
  );
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
describe("story sections", () => {
  it("shows a pending decision first and alone, then conversation, then details in tabs", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await render();
    expect(children()).toEqual(["plan", "DIV", "tablist", "delivery"]);
    expect(panel("plan")?.getAttribute("aria-label")).toBe("Your decision");
    expect(panel("plan")?.hidden).toBe(false);
    expect(panel("plan")?.textContent).toContain("Current plan");
    expect(tab("Plan")).toBeUndefined();
    expect(tab("Delivery")?.getAttribute("aria-selected")).toBe("true");
    expect(tab("Delivery")?.getAttribute("aria-controls")).toBe("story-section-delivery");
    expect(panel("delivery")?.getAttribute("role")).toBe("tabpanel");
    expect(container.textContent).not.toContain("Details and navigation");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the details in tabs without a decision block when no person is needed", async () => {
    await render(focus("delivery", false));
    expect(container.querySelector('[aria-label="Your decision"]')).toBeNull();
    expect(children()).toEqual(["DIV", "tablist", "plan", "delivery"]);
    expect(tab("Delivery")?.getAttribute("aria-selected")).toBe("true");
    expect(panel("plan")?.hidden).toBe(true);
    expect(panel("delivery")?.hidden).toBe(false);
    await act(async () => tab("Plan")?.click());
    expect(panel("plan")?.hidden).toBe(false);
    expect(panel("delivery")?.hidden).toBe(true);
  });
  it("moves between tabs with the keyboard and keeps one tab stop", async () => {
    await render(focus("delivery", false));
    const delivery = tab("Delivery");
    delivery?.focus();
    await act(async () =>
      delivery?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );
    expect(document.activeElement).toBe(tab("Plan"));
    expect(tab("Plan")?.getAttribute("aria-selected")).toBe("true");
    expect(tab("Plan")?.tabIndex).toBe(0);
    expect(tab("Delivery")?.tabIndex).toBe(-1);
    await act(async () =>
      tab("Plan")?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    expect(document.activeElement).toBe(tab("Delivery"));
  });
  it("opens the tab that holds linked evidence without writes", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await render(focus("plan", false));
    expect(panel("delivery")?.hidden).toBe(true);
    await act(async () =>
      container.querySelector<HTMLAnchorElement>('a[href="#story-section-delivery"]')?.click(),
    );
    await settle();
    expect(panel("delivery")?.hidden).toBe(false);
    expect(tab("Delivery")?.getAttribute("aria-selected")).toBe("true");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves both drafts and focus on refresh, and keeps their instances when explicitly changing the lead", async () => {
    await render();
    const plan = container.querySelector<HTMLTextAreaElement>('[aria-label="plan-draft"]');
    const conversation = container.querySelector<HTMLTextAreaElement>(
      '[aria-label="conversation-draft"]',
    );
    if (!plan || !conversation) throw Error("Missing drafts");
    plan.value = "Unsaved scope";
    conversation.value = "Unsaved question";
    plan.focus();
    await render(focus("delivery"));
    expect(document.activeElement).toBe(plan);
    expect(panel("plan")?.getAttribute("aria-label")).toBe("Your decision");
    expect(container.textContent).toContain("The next step changed");
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="status"] button')?.click();
    });
    await settle();
    expect(panel("delivery")?.getAttribute("aria-label")).toBe("Your decision");
    expect(panel("plan")?.getAttribute("role")).toBe("tabpanel");
    expect(container.querySelector('[aria-label="plan-draft"]')).toBe(plan);
    expect(container.querySelector('[aria-label="conversation-draft"]')).toBe(conversation);
    expect(plan.value).toBe("Unsaved scope");
    expect(conversation.value).toBe("Unsaved question");
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(unmounted).not.toHaveBeenCalled();
  });
  it("reveals an exact fragment on entry while preserving the decision and conversation", async () => {
    window.history.replaceState({}, "", "/#story-delivery");
    await render();
    await settle();
    expect(panel("delivery")?.hidden).toBe(false);
    expect(panel("plan")?.hidden).toBe(false);
    expect(scroll).toHaveBeenCalled();
  });
  it("reveals a plan proposed from this conversation, while ignoring another story's event", async () => {
    await render(focus("delivery", false));
    const source = {
      projectId: "project",
      storyId: "other",
      messageId: "message",
      markdown: "Original proposal",
    };
    await act(async () => requestPlanProposal(source));
    await settle();
    expect(panel("plan")?.hidden).toBe(true);
    await act(async () => requestPlanProposal({ ...source, storyId: "story" }));
    await settle();
    expect(panel("plan")?.hidden).toBe(false);
    expect(tab("Plan")?.getAttribute("aria-selected")).toBe("true");
  });
  it("reopens an exact destination when its query changes but the fragment stays the same", async () => {
    window.history.replaceState({}, "", "/?planRevision=2#story-plan");
    await render(focus("delivery", false), "plan:2");
    await settle();
    expect(panel("plan")?.hidden).toBe(false);
    await act(async () => tab("Delivery")?.click());
    expect(panel("plan")?.hidden).toBe(true);
    window.history.replaceState({}, "", "/?planRevision=3#story-plan");
    await render(focus("delivery", false), "plan:3");
    await settle();
    expect(panel("plan")?.hidden).toBe(false);
    expect(unmounted).not.toHaveBeenCalled();
  });
});
