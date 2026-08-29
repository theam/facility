import { type FacilityDb, proposals, repos } from "@facility/db";
import { and, eq } from "drizzle-orm";
import { ApiError } from "./errors.js";
import {
  createGithubClientFactory,
  type FacilityGithubClient,
  type GithubClientFactory,
} from "./github/client.js";
import { githubIssueRevisionContext, githubIssueRevisionSha256 } from "./github/issue-revision.js";
import { createGithubClientForRepo } from "./github/kickstart.js";
import type { AppConfig } from "./types.js";

export type BuilderPlanFreshnessEvidence = {
  baseSha: string;
  issueRevisionSha256: string;
  checkedAt: string;
};

type FreshnessClient = Pick<
  FacilityGithubClient,
  "getDefaultBranchSha" | "getIssue" | "listIssueComments"
>;

export type BuilderPlanFreshnessOptions = {
  config?: AppConfig;
  githubFactory?: GithubClientFactory;
  githubClient?: {
    owner: string;
    repo: string;
    client: FreshnessClient;
  };
};

const ISSUE_CONTEXT_MAX_CHARS = 512 * 1024;

export async function resolveBuilderPlanFreshnessForRun(
  db: FacilityDb,
  run: { orgId: string; projectId: string; trigger: unknown },
  options: BuilderPlanFreshnessOptions = {},
): Promise<BuilderPlanFreshnessEvidence> {
  const trigger = objectValue(run.trigger);
  const proposalId = stringValue(trigger.proposalId);
  const architectRunId = stringValue(trigger.architectRunId);
  if (trigger.source !== "plan_acceptance" || !proposalId || !architectRunId) {
    throw freshnessUnavailable("plan_acceptance_context_missing");
  }
  const proposal = (
    await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.orgId, run.orgId),
          eq(proposals.projectId, run.projectId),
          eq(proposals.id, proposalId),
          eq(proposals.runId, architectRunId),
        ),
      )
      .limit(1)
  )[0];
  if (!proposal) throw freshnessUnavailable("proposal_not_found");
  return resolveBuilderPlanFreshnessForProposal(db, proposal, options);
}

export async function resolveBuilderPlanFreshnessForProposal(
  db: FacilityDb,
  proposal: Pick<typeof proposals.$inferSelect, "orgId" | "projectId" | "payload">,
  options: BuilderPlanFreshnessOptions = {},
): Promise<BuilderPlanFreshnessEvidence> {
  if (!proposal.projectId) throw freshnessUnavailable("proposal_project_missing");
  const payload = objectValue(proposal.payload);
  const repoId = stringValue(payload.repoId);
  const issueNumber = positiveInteger(payload.issueNumber);
  if (!repoId || !issueNumber) throw freshnessUnavailable("proposal_issue_context_missing");
  const repo = (
    await db
      .select()
      .from(repos)
      .where(
        and(
          eq(repos.orgId, proposal.orgId),
          eq(repos.projectId, proposal.projectId),
          eq(repos.id, repoId),
        ),
      )
      .limit(1)
  )[0];
  if (!repo) throw freshnessUnavailable("proposal_repo_missing");

  let client: FreshnessClient;
  try {
    if (options.githubClient) {
      if (options.githubClient.owner !== repo.owner || options.githubClient.repo !== repo.name) {
        throw freshnessUnavailable("github_client_repo_mismatch");
      }
      client = options.githubClient.client;
    } else {
      const factory =
        options.githubFactory ??
        (options.config ? createGithubClientFactory(options.config) : null);
      if (!factory) throw freshnessUnavailable("github_client_unavailable");
      client = await createGithubClientForRepo(db, factory, repo);
    }
    const [baseSha, issue, comments] = await Promise.all([
      client.getDefaultBranchSha(),
      client.getIssue(issueNumber),
      client.listIssueComments(issueNumber, ISSUE_CONTEXT_MAX_CHARS),
    ]);
    const normalizedBaseSha = gitSha(baseSha);
    const issueRevisionSha256 = githubIssueRevisionSha256(
      githubIssueRevisionContext(issue, comments),
    );
    if (!normalizedBaseSha || !issueRevisionSha256) {
      throw freshnessUnavailable("github_freshness_invalid");
    }
    return {
      baseSha: normalizedBaseSha,
      issueRevisionSha256,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === "builder_plan_freshness_unavailable") {
      throw error;
    }
    throw freshnessUnavailable(
      error instanceof Error ? `github_freshness_error:${error.message}` : "github_freshness_error",
    );
  }
}

function freshnessUnavailable(reason: string) {
  return new ApiError(
    409,
    "builder_plan_freshness_unavailable",
    "Facility could not verify the approved repository and issue revision",
    { reason },
  );
}

function gitSha(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
