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
const focus = (section: "plan" | "delivery"): StoryFocus => ({
  section,
  title: `Current ${section}`,
  detail: "Recorded next step",
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
describe("story sections", () => {
  it("keeps the active review next to conversation and opens linked secondary evidence without writes", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await render();
    const plan = container.querySelector<HTMLDetailsElement>('[data-story-section="plan"]');
    const delivery = container.querySelector<HTMLDetailsElement>('[data-story-section="delivery"]');
    expect(plan?.open).toBe(true);
    expect(delivery?.open).toBe(false);
    expect(plan?.nextElementSibling?.querySelector("#conversation")).not.toBeNull();
    const link = container.querySelector<HTMLAnchorElement>('a[href="#story-section-delivery"]');
    await act(async () => {
      link?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(delivery?.open).toBe(true);
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
    expect(
      container
        .querySelector("[data-story-sections] > details")
        ?.getAttribute("data-story-section"),
    ).toBe("plan");
    expect(container.textContent).toContain("The next step changed");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      container
        .querySelector("[data-story-sections] > details")
        ?.getAttribute("data-story-section"),
    ).toBe("delivery");
    expect(container.querySelector('[aria-label="plan-draft"]')).toBe(plan);
    expect(container.querySelector('[aria-label="conversation-draft"]')).toBe(conversation);
    expect(plan.value).toBe("Unsaved scope");
    expect(conversation.value).toBe("Unsaved question");
    expect(mounted).toHaveBeenCalledTimes(2);
    expect(unmounted).not.toHaveBeenCalled();
  });
  it("reveals an exact fragment on entry while preserving the default review and conversation", async () => {
    window.history.replaceState({}, "", "/#story-delivery");
    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(
      container.querySelector<HTMLDetailsElement>('[data-story-section="delivery"]')?.open,
    ).toBe(true);
    expect(container.querySelector<HTMLDetailsElement>('[data-story-section="plan"]')?.open).toBe(
      true,
    );
    expect(scroll).toHaveBeenCalled();
  });
  it("reveals a plan proposed from this conversation, while ignoring another story's event", async () => {
    await render(focus("delivery"));
    const plan = container.querySelector<HTMLDetailsElement>('[data-story-section="plan"]');
    const source = {
      projectId: "project",
      storyId: "other",
      messageId: "message",
      markdown: "Original proposal",
    };
    await act(async () => requestPlanProposal(source));
    expect(plan?.open).toBe(false);
    await act(async () => requestPlanProposal({ ...source, storyId: "story" }));
    expect(plan?.open).toBe(true);
  });
  it("reopens an exact destination when its query changes but the fragment stays the same", async () => {
    window.history.replaceState({}, "", "/?planRevision=2#story-plan");
    await render(focus("delivery"), "plan:2");
    const plan = container.querySelector<HTMLDetailsElement>('[data-story-section="plan"]');
    if (!plan) throw Error("Missing plan panel");
    await act(async () => {
      plan.open = false;
      plan.dispatchEvent(new Event("toggle"));
    });
    expect(plan.open).toBe(false);
    window.history.replaceState({}, "", "/?planRevision=3#story-plan");
    await render(focus("plan"), "plan:3");
    expect(plan.open).toBe(true);
    expect(unmounted).not.toHaveBeenCalled();
  });
});
