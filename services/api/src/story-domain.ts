import type { FacilityDb } from "@facility/db";
import { AgentCatalogService, GithubAgentCatalogSource } from "./agents/catalog.js";
import { GithubAgentTriggerService } from "./agents/github-triggers.js";
import { AgentScheduler } from "./agents/scheduler.js";
import {
  createGithubClientFactory,
  createGithubMaintainerTokenFactory,
  type GithubClientFactory,
  type GithubMaintainerTokenFactory,
} from "./github/client.js";
import { GithubMirrorService } from "./github/mirror.js";
import { GithubWorkspaceCredentialBroker } from "./github/workspace-credentials.js";
import { CostBudgetService } from "./insights/costs.js";
import { StoryWorkspaceService } from "./stories/service.js";
import { TurnDispatcher } from "./turns/dispatcher.js";
import { AgentEngineRegistry, ClaudeCodeEngine, CodexEngine } from "./turns/engines.js";
import { TurnGitEvidenceService } from "./turns/git-evidence.js";
import type { AppConfig } from "./types.js";
import { DockerWorkspaceRuntime } from "./workspaces/docker.js";
import { WorkspacePreviewService } from "./workspaces/preview.js";
import {
  GithubProjectManifestSource,
  ProjectEnvironmentService,
} from "./workspaces/project-environment.js";
import type { WorkspaceRuntime } from "./workspaces/runtime.js";
import { VercelWorkspaceRuntime } from "./workspaces/vercel.js";

export type StoryDomain = {
  runtime: WorkspaceRuntime;
  stories: StoryWorkspaceService;
  catalog: AgentCatalogService;
  credentials: GithubWorkspaceCredentialBroker;
  projectManifests: GithubProjectManifestSource;
  environment: ProjectEnvironmentService;
  engines: AgentEngineRegistry;
  dispatcher: TurnDispatcher;
  previews: WorkspacePreviewService;
  scheduler: AgentScheduler;
  githubTriggers: GithubAgentTriggerService;
  mirror: GithubMirrorService;
  costs: CostBudgetService;
  evidence: TurnGitEvidenceService;
};

export function createStoryDomain(input: {
  db: FacilityDb;
  config: AppConfig;
  enqueue: (queue: string, data: Record<string, unknown>) => Promise<unknown>;
  runtime?: WorkspaceRuntime;
  githubFactory?: GithubClientFactory;
  maintainerTokenFactory?: GithubMaintainerTokenFactory;
}): StoryDomain {
  const runtime = input.runtime ?? workspaceRuntime(input.config);
  const githubFactory =
    input.githubFactory ??
    (input.config.githubAppId && input.config.githubAppPrivateKey
      ? createGithubClientFactory(input.config)
      : unavailableGithubFactory);
  const tokenFactory =
    input.maintainerTokenFactory ??
    (input.config.githubAppId && input.config.githubAppPrivateKey
      ? createGithubMaintainerTokenFactory(input.config)
      : unavailableTokenFactory);
  const catalog = new AgentCatalogService(
    input.db,
    new GithubAgentCatalogSource(input.db, githubFactory),
  );
  const credentials = new GithubWorkspaceCredentialBroker(input.db, tokenFactory);
  const costs = new CostBudgetService(input.db);
  const projectManifests = new GithubProjectManifestSource(input.db, githubFactory);
  const environment = new ProjectEnvironmentService(input.db, runtime);
  const stories = new StoryWorkspaceService(input.db, runtime, async (turn) => {
    await input.enqueue("turns.dispatch", {
      orgId: turn.orgId,
      projectId: turn.projectId,
      turnId: turn.id,
    });
  });
  const mirror = new GithubMirrorService(input.db, githubFactory, stories);
  const engines = new AgentEngineRegistry([
    new ClaudeCodeEngine(runtime),
    new CodexEngine(runtime),
  ]);
  const evidence = new TurnGitEvidenceService(input.db, runtime);
  const dispatcher = new TurnDispatcher(
    input.db,
    stories,
    catalog,
    credentials,
    projectManifests,
    environment,
    engines,
    evidence,
    costs,
  );
  const previews = new WorkspacePreviewService(
    input.db,
    input.config,
    runtime,
    credentials,
    projectManifests,
    environment,
  );
  const scheduler = new AgentScheduler(
    input.db,
    catalog,
    stories,
    projectManifests,
    input.config.workspaceImage,
  );
  const githubTriggers = new GithubAgentTriggerService(
    input.db,
    catalog,
    stories,
    projectManifests,
    input.config.workspaceImage,
    mirror,
  );
  return {
    runtime,
    stories,
    catalog,
    credentials,
    projectManifests,
    environment,
    engines,
    dispatcher,
    previews,
    scheduler,
    githubTriggers,
    mirror,
    costs,
    evidence,
  };
}

function workspaceRuntime(config: AppConfig): WorkspaceRuntime {
  if (config.workspaceDriver === "docker") return new DockerWorkspaceRuntime();
  if (config.workspaceDriver === "vercel") {
    const credentials =
      config.vercelToken && config.vercelTeamId && config.vercelProjectId
        ? {
            token: config.vercelToken,
            teamId: config.vercelTeamId,
            projectId: config.vercelProjectId,
          }
        : undefined;
    return new VercelWorkspaceRuntime(credentials);
  }
  return new UnsupportedWorkspaceRuntime();
}

class UnsupportedWorkspaceRuntime implements WorkspaceRuntime {
  readonly provider = "fake" as const;
  private unavailable(): never {
    throw new Error("Facility 0.12 story workspaces support docker or vercel runtimes");
  }
  create(): never {
    return this.unavailable();
  }
  wake(): never {
    return this.unavailable();
  }
  exec(): never {
    return this.unavailable();
  }
  expose(): never {
    return this.unavailable();
  }
  inspect(): never {
    return this.unavailable();
  }
  suspend(): never {
    return this.unavailable();
  }
  destroy(): never {
    return this.unavailable();
  }
}

const unavailableGithubFactory: GithubClientFactory = async () => {
  throw new Error("GitHub App credentials are not configured");
};

const unavailableTokenFactory: GithubMaintainerTokenFactory = async () => {
  throw new Error("GitHub App credentials are not configured");
};
