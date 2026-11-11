"use client";

import { cardClassName, StatusPill } from "@facility/ui";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { StoryFocus, StorySection } from "@/lib/story-focus";
import { PLAN_PROPOSAL_EVENT, type PlanProposalSource } from "@/lib/story-plan-events";

export type StorySectionContent = {
  key: StorySection;
  label: string;
  content: ReactNode;
};

type StoryTab = "plan" | "delivery" | "progress" | "consultation" | "environment";

/** Five places for the details; each section keeps its own id and gates. */
const TABS: { key: StoryTab; label: string; sections: StorySection[] }[] = [
  { key: "plan", label: "Plan", sections: ["plan"] },
  {
    key: "delivery",
    label: "Delivery",
    sections: ["delivery", "workflow", "preview", "completion"],
  },
  { key: "progress", label: "Activity", sections: ["progress"] },
  { key: "consultation", label: "Consult", sections: ["consultation"] },
  { key: "environment", label: "Environment", sections: ["environment"] },
];

function tabOf(section: StorySection): StoryTab {
  return TABS.find((tab) => tab.sections.includes(section))?.key ?? "plan";
}

/**
 * A step that waits on a person comes first, alone. The conversation follows,
 * and every other section sits in one tab row. Panels stay mounted while
 * hidden so drafts and inspections survive refreshes and tab changes.
 */
export function StorySections({
  focus,
  sections,
  conversation,
  scope,
  navigationKey,
}: {
  focus: StoryFocus;
  sections: StorySectionContent[];
  conversation: ReactNode;
  scope: { projectId: string; storyId: string };
  navigationKey: string;
}) {
  const [lead, setLead] = useState({ section: focus.section, decision: focus.decision });
  const ids = useId();
  const root = useRef<HTMLDivElement>(null);
  const revealedNavigation = useRef<string | null>(null);
  const changed = lead.section !== focus.section || lead.decision !== focus.decision;

  const tabs = TABS.map((tab) => ({
    ...tab,
    sections: sections.filter(
      (section) =>
        tab.sections.includes(section.key) && !(lead.decision && section.key === lead.section),
    ),
  })).filter((tab) => tab.sections.length > 0);
  const preferred = lead.decision ? "progress" : tabOf(lead.section);
  const [selected, setSelected] = useState<StoryTab>(preferred);
  const current = tabs.some((tab) => tab.key === selected) ? selected : (tabs[0]?.key ?? "plan");

  useEffect(() => {
    function reveal(hash: string, moveFocus: boolean) {
      let id: string;
      try {
        id = decodeURIComponent(hash.slice(1));
      } catch {
        return;
      }
      const target = document.getElementById(id);
      if (!target || !root.current?.contains(target)) return;
      const panel = target.closest<HTMLElement>("[data-story-tab]");
      if (panel) setSelected(panel.dataset.storyTab as StoryTab);
      // Two frames: the selected tab must render visible before it can scroll into view.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!target.isConnected) return;
          target.scrollIntoView({ block: "start" });
          if (moveFocus) {
            if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
            target.focus({ preventScroll: true });
          }
        }),
      );
    }
    function hashChange() {
      reveal(window.location.hash, false);
    }
    function proposal(event: Event) {
      const source = (event as CustomEvent<PlanProposalSource>).detail;
      if (source?.projectId === scope.projectId && source.storyId === scope.storyId)
        reveal("#story-plan", false);
    }
    function click(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.target === "_blank") return;
      const url = new URL(link.href, window.location.href);
      if (
        url.origin === location.origin &&
        url.pathname === location.pathname &&
        url.search === location.search &&
        url.hash
      )
        reveal(url.hash, true);
    }
    if (revealedNavigation.current !== navigationKey) {
      revealedNavigation.current = navigationKey;
      hashChange();
    }
    window.addEventListener("hashchange", hashChange);
    window.addEventListener(PLAN_PROPOSAL_EVENT, proposal);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("hashchange", hashChange);
      window.removeEventListener(PLAN_PROPOSAL_EVENT, proposal);
      document.removeEventListener("click", click, true);
    };
  }, [scope.projectId, scope.storyId, navigationKey]);

  function showCurrent() {
    setLead({ section: focus.section, decision: focus.decision });
    setSelected(focus.decision ? "progress" : tabOf(focus.section));
    requestAnimationFrame(() => {
      const target = document.getElementById(
        focus.decision ? `story-section-${focus.section}` : `${ids}-tab-${tabOf(focus.section)}`,
      );
      target?.focus();
      target?.scrollIntoView({ block: "start" });
    });
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>) {
    const index = tabs.findIndex((tab) => tab.key === current);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const key = tabs[next]?.key;
    if (!key) return;
    setSelected(key);
    document.getElementById(`${ids}-tab-${key}`)?.focus();
  }

  const decision = lead.decision ? sections.find((section) => section.key === lead.section) : null;
  const tabFor = (key: StorySection) => tabs.find((tab) => tab.sections.some((s) => s.key === key));
  const panelId = (key: StorySection) => `story-section-${key}`;
  // One parent for every panel: changing the lead or the tab moves or hides
  // the same instances, so drafts, focus and open inspections survive.
  const ordered = [...(decision ? [decision] : []), ...tabs.flatMap((tab) => tab.sections)];
  function panel(section: StorySectionContent) {
    const lead = section === decision;
    const tab = tabFor(section.key);
    return (
      <section
        key={`section:${section.key}`}
        id={panelId(section.key)}
        data-story-section={section.key}
        data-story-tab={lead ? undefined : tab?.key}
        role={lead ? undefined : "tabpanel"}
        aria-labelledby={lead || !tab ? undefined : `${ids}-tab-${tab.key}`}
        aria-label={lead ? "Your decision" : undefined}
        tabIndex={-1}
        hidden={!lead && tab?.key !== current}
        className={`${cardClassName} min-w-0 scroll-mt-6 px-5 py-5 focus:outline-none sm:px-6 ${lead ? "ring-1 ring-(--human)/25" : ""}`}
      >
        {lead ? (
          <p key="label" className="mb-4">
            <StatusPill tone="human">{focus.title}</StatusPill>
          </p>
        ) : null}
        <div key="content" className="min-w-0">
          {section.content}
        </div>
      </section>
    );
  }
  const tablist = tabs.length ? (
    <div
      key="tabs"
      role="tablist"
      aria-label="Story details"
      className="-mb-4 flex gap-6 overflow-x-auto border-b border-(--line)"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          id={`${ids}-tab-${tab.key}`}
          type="button"
          role="tab"
          aria-selected={tab.key === current}
          aria-controls={tab.sections.map((section) => panelId(section.key)).join(" ")}
          tabIndex={tab.key === current ? 0 : -1}
          onClick={() => setSelected(tab.key)}
          onKeyDown={moveTab}
          className={`-mb-px min-h-11 shrink-0 border-b-2 text-sm focus-visible:outline-2 focus-visible:outline-(--info) ${tab.key === current ? "border-(--ink) text-(--ink)" : "border-transparent text-(--mut) hover:text-(--ink)"}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  ) : null;
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-8" data-story-sections>
      {[
        ...(changed
          ? [
              <p key="changed" className="text-sm text-(--mut)" role="status">
                The next step changed.{" "}
                <button
                  type="button"
                  onClick={showCurrent}
                  className="min-h-11 text-(--info) underline"
                >
                  Show it
                </button>
              </p>,
            ]
          : []),
        ...(decision ? [panel(decision)] : []),
        <div key="conversation">{conversation}</div>,
        ...(tablist ? [tablist] : []),
        ...ordered.filter((section) => section !== decision).map(panel),
      ]}
    </div>
  );
}
