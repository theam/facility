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
async function format(value: string) {
  const radio = container.querySelector<HTMLInputElement>(`input[value="${value}"]`);
  if (!radio) throw Error("Missing format control");
  await act(async () => radio.click());
}
describe("saved author brief presentation", () => {
  it("keeps the decision and risk visible before optional formats, with the exact original still accessible", async () => {
    await render();
    const section = container.querySelector("section");
    const alternatives = section?.querySelector("details");
    expect(alternatives?.open).toBe(false);
    expect(alternatives?.querySelector("fieldset")).not.toBeNull();
    const risk = [...(section?.querySelectorAll("p") ?? [])].find(
      (node) => node.textContent === brief.decisiveRisk.text,
    );
    expect(risk).toBeDefined();
    expect(risk?.closest("details")).toBeNull();
    expect(section?.textContent).not.toContain("How to view the options");
    expect(section?.textContent).not.toContain("The decision in brief");
    await act(async () => alternatives?.querySelector("summary")?.click());
    expect(alternatives?.open).toBe(true);
    await format("diagram");
    expect(section?.textContent).toContain(brief.decisiveRisk.text);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("presents identical options, decisive risk, missing evidence and direct sources in all three formats without writes", async () => {
    await render();
    for (const value of ["summary", "comparison", "diagram"]) {
      await format(value);
      const section = container.querySelector("section");
      for (const option of brief.options) {
        expect(section?.textContent).toContain(option.label);
        expect(section?.textContent).toContain(option.consequence.text);
      }
      expect(section?.textContent).toContain(brief.decisiveRisk.text);
      expect(section?.textContent).toContain(brief.unknowns[0]?.text);
      expect(section?.querySelector("a")?.href).toBe(brief.evidence[0]?.url);
      expect(container.querySelector<HTMLInputElement>(`input[value="${value}"]`)?.checked).toBe(
        true,
      );
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
  });
  it("links each source once in the visible brief and keeps every link in the options view", async () => {
    await render();
    const section = container.querySelector("section");
    const visible = [...(section?.querySelectorAll("a") ?? [])]
      .filter((link) => !link.closest("details"))
      .map((link) => link.href);
    expect(visible.length).toBeGreaterThan(0);
    expect(new Set(visible).size).toBe(visible.length);
    const cited = new Set(
      [brief.summary, brief.whyNow, brief.decisiveRisk, ...brief.unknowns].flatMap(
        (claim) => claim.evidenceIds,
      ),
    );
    for (const id of cited)
      expect(visible).toContain(brief.evidence.find((source) => source.id === id)?.url);
    const options = section?.querySelector("details");
    for (const option of brief.options)
      for (const id of option.consequence.evidenceIds)
        expect([...(options?.querySelectorAll("a") ?? [])].map((link) => link.href)).toContain(
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
  it("resets presentation when the immutable plan changes and keeps every view bound to its revision", async () => {
    await render();
    await format("comparison");
    await render({ ...plan(), revision: 4, digest: "e".repeat(64) });
    expect(container.querySelector<HTMLInputElement>('input[value="summary"]')?.checked).toBe(true);
    expect(container.querySelector("section")?.getAttribute("aria-label")).toContain("plan r4");
  });
});
