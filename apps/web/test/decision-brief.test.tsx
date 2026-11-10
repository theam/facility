// @vitest-environment jsdom
import type { StoryPlan } from "@facility/sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import brief from "../../../packages/core/test/fixtures/decision-brief.json";
import { PlanContent } from "../components/story/plan-content";

function plan(): StoryPlan {
  return {
    revision: 3,
    digest: "d".repeat(64),
    markdown: `# Full original\n\nImplementation details stay available.\n\n\`\`\`facility-decision\n${JSON.stringify(brief)}\n\`\`\``,
    decisionBrief: { status: "available", brief: structuredClone({ ...brief, schemaVersion: 1 }) },
    repositories: [{ repositoryId: "repo", repository: "example/app" }],
    agents: ["builder", "reviewer", "qa"].map((name) => ({
      name,
      manifestHash: "a".repeat(64),
      engine: "codex",
      model: "fixture",
      repositoryId: "repo",
      catalogCommitSha: "b".repeat(40),
      observedAt: "2026-11-05T10:00:00Z",
    })),
    proposedBy: { type: "user", id: "ada", name: "Ada" },
    proposedAt: "2026-11-05T10:00:00Z",
    source: { messageId: "original-message", turnId: "planner-turn", role: "agent" },
  };
}
let container: HTMLDivElement, root: Root;
const fetcher = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value = plan()) {
  await act(async () => root.render(<PlanContent plan={value} />));
}
describe("saved author brief presentation", () => {
  it("reads top to bottom with options, recommendation and risk visible and no format switch", async () => {
    await render();
    const section = container.querySelector("section");
    if (!section) throw Error("Missing brief");
    expect(section.querySelector("fieldset, input[type='radio']")).toBeNull();
    expect(section.querySelector("details")).toBeNull();
    expect(section.textContent).not.toContain("Options and sources");
    expect(section.textContent).not.toContain("Author recommends");
    const options = section.querySelector('ol[aria-label="Options and consequences"]');
    for (const option of brief.options) {
      expect(options?.textContent).toContain(option.label);
      expect(options?.textContent).toContain(option.consequence.text);
    }
    const recommended = [...(options?.querySelectorAll("li") ?? [])].find((item) =>
      item.textContent?.includes("Recommended"),
    );
    expect(recommended?.textContent).toContain(
      brief.options.find((option) => option.id === brief.recommendation?.optionId)?.label,
    );
    expect(recommended?.textContent).toContain(`Why: ${brief.recommendation?.reason.text}`);
    const text = section.textContent ?? "";
    const order = [
      brief.summary.text,
      brief.whyNow.text,
      brief.options[0]?.label ?? "",
      brief.decisiveRisk.text,
      brief.unknowns[0]?.text ?? "",
      "Sources",
    ].map((value) => text.indexOf(value));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(section.textContent).toContain("not checks made by Facility");
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
  });
  it("numbers each source once in reading order and links every statement to it", async () => {
    await render();
    const section = container.querySelector("section");
    const markers = [...(section?.querySelectorAll<HTMLAnchorElement>("p a") ?? [])];
    expect(markers.length).toBeGreaterThan(0);
    expect(section?.querySelector("a")?.href).toBe(brief.evidence[0]?.url);
    for (const marker of markers) {
      const index = Number(marker.textContent?.replace(/\D/g, ""));
      const listed = section?.querySelectorAll<HTMLAnchorElement>('ol[aria-label="Sources"] a')[
        index - 1
      ];
      expect(listed?.href).toBe(marker.href);
      expect(marker.getAttribute("aria-label")).toMatch(/^Source \d+: /);
    }
    const listed = [
      ...(section?.querySelectorAll<HTMLAnchorElement>('ol[aria-label="Sources"] a') ?? []),
    ];
    expect(new Set(listed.map((link) => link.href)).size).toBe(listed.length);
    for (const source of brief.evidence)
      expect(listed.map((link) => link.href)).toContain(source.url);
    for (const claim of [brief.summary, brief.whyNow, brief.decisiveRisk])
      for (const id of claim.evidenceIds)
        expect(markers.map((link) => link.href)).toContain(
          brief.evidence.find((source) => source.id === id)?.url,
        );
  });
  it("keeps the full original one toggle away and separates proposer, source and execution roles", async () => {
    await render();
    const original = [...container.querySelectorAll("details")].find((node) =>
      node.querySelector("summary")?.textContent?.includes("Original plan r3"),
    );
    expect(original?.open).toBe(false);
    await act(async () => original?.querySelector("summary")?.click());
    expect(original?.open).toBe(true);
    expect(original?.textContent).toContain("Implementation details stay available.");
    expect(container.textContent).toContain("proposed by Ada");
    expect(container.textContent).toContain("Agents selected for execution");
    for (const role of ["builder", "reviewer", "qa"]) expect(container.textContent).toContain(role);
    expect(container.textContent).toContain("original-message");
    expect(container.textContent).not.toContain("Ada recommends");
  });
  it("falls back to the original on missing, malformed or older-server briefs and never invents a recommendation", async () => {
    for (const decisionBrief of [
      undefined,
      { status: "absent" as const },
      { status: "invalid" as const, reason: "duplicate" as const },
    ]) {
      await render({ ...plan(), decisionBrief });
      expect(container.textContent).toContain("Implementation details stay available.");
      expect(container.querySelector("fieldset")).toBeNull();
      expect(container.querySelector("details")?.textContent).not.toContain(
        "Implementation details stay available.",
      );
    }
    const value = plan();
    if (value.decisionBrief?.status !== "available") throw Error("Missing brief");
    value.decisionBrief.brief.recommendation = null;
    value.decisionBrief.brief.summary.text = '<img src=x onerror="attack()">';
    await render(value);
    expect(container.textContent).toContain("No recommendation supplied");
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="attack()">');
  });
  it("keeps every view bound to its immutable revision", async () => {
    await render();
    await render({ ...plan(), revision: 4, digest: "e".repeat(64) });
    expect(container.querySelector("section")?.getAttribute("aria-label")).toContain("plan r4");
    expect(container.textContent).toContain("Supplied in plan r4");
  });
});
