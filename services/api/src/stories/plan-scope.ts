import type { AgentManifest } from "@facility/agents";
import type { PlanAgent, PlanRepository } from "@facility/core";

export type ConnectedPlanRepository = {
  id: string;
  owner: string;
  name: string;
  role: string;
};

export function matchesPlanAgent(
  selected: PlanAgent | undefined,
  agent: Pick<AgentManifest, "name" | "hash" | "engine" | "model">,
) {
  return (
    !!selected &&
    selected.name === agent.name &&
    selected.manifestHash === agent.hash &&
    selected.engine === agent.engine &&
    selected.model === agent.model
  );
}

export function matchesPlanRepositoryScope(
  selected: PlanRepository[],
  connected: ConnectedPlanRepository[],
  agentRepositoryId: string | undefined,
) {
  const primary = connected.find((repository) => repository.role === "primary");
  return (
    !!primary &&
    agentRepositoryId === primary.id &&
    selected.length === connected.length &&
    connected.every((repository) =>
      selected.some(
        (approved) =>
          approved.repositoryId === repository.id &&
          approved.repository.toLowerCase() ===
            `${repository.owner}/${repository.name}`.toLowerCase(),
      ),
    )
  );
}

export function repositoryScopeDifference(
  selected: PlanRepository[],
  connected: ConnectedPlanRepository[],
) {
  const same = (approved: PlanRepository, repository: ConnectedPlanRepository) =>
    approved.repositoryId === repository.id &&
    approved.repository.toLowerCase() === `${repository.owner}/${repository.name}`.toLowerCase();
  return {
    missing: connected
      .filter((repository) => !selected.some((approved) => same(approved, repository)))
      .map((repository) => `${repository.owner}/${repository.name}`),
    removed: selected
      .filter((approved) => !connected.some((repository) => same(approved, repository)))
      .map((approved) => approved.repository),
  };
}
