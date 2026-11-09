"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import type { StoryFocus, StorySection } from "@/lib/story-focus";
import { PLAN_PROPOSAL_EVENT, type PlanProposalSource } from "@/lib/story-plan-events";

export type StorySectionContent = {
  key: StorySection;
  label: string;
  content: ReactNode;
};

/** Stable keyed panels keep drafts and inspections while their observations refresh. */
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
  const [lead, setLead] = useState(focus.section);
  const [opened, setOpened] = useState<Partial<Record<StorySection, boolean>>>({
    [focus.section]: true,
  });
  const root = useRef<HTMLDivElement>(null);
  const revealedNavigation = useRef<string | null>(null);
  const changed = lead !== focus.section;

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
      const section = target.closest<HTMLDetailsElement>("details[data-story-section]");
      if (section) {
        const key = section.dataset.storySection as StorySection;
        setOpened((old) => (old[key] ? old : { ...old, [key]: true }));
      }
      requestAnimationFrame(() => {
        if (!target.isConnected) return;
        target.scrollIntoView({ block: "start" });
        if (moveFocus) {
          if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
          target.focus({ preventScroll: true });
        }
      });
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
    setLead(focus.section);
    setOpened((old) => ({ ...old, [focus.section]: true }));
    requestAnimationFrame(() => {
      const summary = root.current?.querySelector<HTMLElement>(
        `details[data-story-section="${focus.section}"] > summary`,
      );
      summary?.focus();
      summary?.scrollIntoView({ block: "start" });
    });
  }
  const first = sections.find((section) => section.key === lead);
  function panel(section: StorySectionContent) {
    return (
      <details
        key={section.key}
        id={`story-section-${section.key}`}
        data-story-section={section.key}
        open={opened[section.key] ?? false}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setOpened((old) => (old[section.key] === open ? old : { ...old, [section.key]: open }));
        }}
        className="min-w-0 scroll-mt-6"
      >
        <summary className="min-h-11 cursor-pointer border border-(--line) bg-(--bg-subtle) px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-(--info)">
          {section.label}
          {section.key === lead ? " · in focus" : ""}
        </summary>
        <div className="mt-3 min-w-0">{section.content}</div>
      </details>
    );
  }
  return (
    <div ref={root} className="flex min-w-0 flex-col gap-6" data-story-sections>
      <div className="min-w-0 border-l-2 border-(--human) pl-4">
        <h2 className="font-semibold">{focus.title}</h2>
        <p className="mt-2 text-sm text-(--mut)">{focus.detail}</p>
        {changed ? (
          <p className="mt-2 text-sm" role="status">
            The next step changed. Your open panels and drafts stay in place.{" "}
            <button
              type="button"
              onClick={showCurrent}
              className="min-h-11 text-(--info) underline"
            >
              Show the current step first
            </button>
          </p>
        ) : null}
        <nav aria-label="Story sections" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <a
            href="#conversation"
            className="inline-flex min-h-11 items-center text-(--info) underline"
          >
            Conversation
          </a>
          {sections.map((section) => (
            <a
              key={section.key}
              href={`#story-section-${section.key}`}
              className="inline-flex min-h-11 items-center text-(--info) underline"
            >
              {section.label}
            </a>
          ))}
        </nav>
      </div>
      {[
        ...(first ? [panel(first)] : []),
        <div key="conversation">{conversation}</div>,
        ...sections.filter((section) => section.key !== lead).map(panel),
      ]}
    </div>
  );
}
