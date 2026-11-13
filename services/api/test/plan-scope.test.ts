import type { PlanAgent } from "@facility/core";
import { describe, expect, it } from "vitest";
import {
  matchesPlanAgent,
  matchesPlanRepositoryScope,
  repositoryScopeDifference,
} from "../src/stories/plan-scope.js";

const agent = { name: "planner", hash: "a".repeat(64), engine: "codex" as const, model: "fixture" };
const selected: PlanAgent = {
  name: agent.name,
  manifestHash: agent.hash,
  engine: agent.engine,
  model: agent.model,
  repositoryId: "app",
  catalogCommitSha: "b".repeat(40),
  observedAt: "2026-11-05T00:00:00Z",
};
const primary = { id: "app", owner: "example", name: "app", role: "primary" };
const dependency = { id: "api", owner: "example", name: "api", role: "dependency" };
const connected = [primary, dependency];
const repositories = connected.map((repo) => ({
  repositoryId: repo.id,
  repository: `${repo.owner}/${repo.name}`,
}));

describe("execution plan scope comparison", () => {
  it("requires the retained agent's exact execution configuration", () => {
    expect(matchesPlanAgent(selected, agent)).toBe(true);
    expect(matchesPlanAgent(undefined, agent)).toBe(false);
    for (const changed of [
      { name: "builder" },
      { hash: "c".repeat(64) },
      { engine: "claude_code" as const },
      { model: "different" },
    ]) {
      expect(matchesPlanAgent(selected, { ...agent, ...changed })).toBe(false);
    }
  });
  it("accepts ordering and case differences without treating a new repository connection as the old scope", () => {
    expect(
      matchesPlanRepositoryScope(
        [...repositories]
          .reverse()
          .map((repo) => ({ ...repo, repository: repo.repository.toUpperCase() })),
        connected,
        "app",
      ),
    ).toBe(true);
    expect(
      matchesPlanRepositoryScope(
        repositories,
        [{ ...primary, id: "replacement" }, dependency],
        "replacement",
      ),
    ).toBe(false);
    expect(
      matchesPlanRepositoryScope(
        repositories,
        [primary, { ...dependency, name: "renamed" }],
        "app",
      ),
    ).toBe(false);
  });
  it("rejects incomplete scope, removed repositories and a different primary source", () => {
    expect(matchesPlanRepositoryScope(repositories.slice(0, 1), connected, "app")).toBe(false);
    expect(matchesPlanRepositoryScope(repositories, connected.slice(0, 1), "app")).toBe(false);
    expect(matchesPlanRepositoryScope(repositories, connected, "api")).toBe(false);
    expect(matchesPlanRepositoryScope([], [], undefined)).toBe(false);
  });
  it("identifies repositories missing from a proposal and connections that changed", () => {
    expect(repositoryScopeDifference(repositories.slice(0, 1), connected)).toEqual({
      missing: ["example/api"],
      removed: [],
    });
    expect(repositoryScopeDifference(repositories, [{ ...primary, id: "replacement" }])).toEqual({
      missing: ["example/app"],
      removed: ["example/app", "example/api"],
    });
  });
});
