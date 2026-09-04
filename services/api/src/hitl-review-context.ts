import { type FacilityDb, type proposals, repos } from "@facility/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  type BuilderPlanFreshnessOptions,
  resolveBuilderPlanFreshnessForProposal,
} from "./builder-plan-freshness.js";
import {
  createGithubClientFactory,
  type FacilityGithubClient,
  type GithubClientFactory,
} from "./github/client.js";
import { createGithubClientForRepo } from "./github/kickstart.js";
import type { AppConfig } from "./types.js";

export const REVIEW_CONTEXT_MAX_AGE_MS = 5 * 60_000;

const RepositorySchema = z.object({
  id: z.string(),
  owner: z.string(),
  name: z.string(),
});

const GitShaSchema = z.string().regex(/^[a-f0-9]{40}$/i);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

const ReviewContextBaseSchema = z.object({
  version: z.literal(1),
  source: z.enum(["facility_web", "github_plan_comment"]),
  repository: RepositorySchema.nullable(),
  branch: z.string().nullable(),
  planBaseSha: GitShaSchema.nullable(),
  planSha256: Sha256Schema.nullable(),
  presentedAt: z.string().datetime(),
});

export const ReviewContextV1Schema = z.discriminatedUnion("status", [
  ReviewContextBaseSchema.extend({
    status: z.literal("available"),
    presentedBaseSha: GitShaSchema,
    issueRevisionSha256: Sha256Schema,
    comparison: z.object({
      status: z.enum(["identical", "ahead", "behind", "diverged"]),
      aheadBy: z.number().int().nonnegative(),
      behindBy: z.number().int().nonnegative(),
      changedPaths: z.array(z.string()).max(300),
      changedPathsTruncated: z.boolean(),
    }),
  }),
  ReviewContextBaseSchema.extend({
    status: z.literal("unavailable"),
    reason: z.enum([
      "proposal_context_invalid",
      "repository_unavailable",
      "github_client_unavailable",
      "github_evidence_unavailable",
      "comparison_unavailable",
    ]),
  }),
]);

export type ReviewContextV1 = z.infer<typeof ReviewContextV1Schema>;
export type ReviewContextSource = ReviewContextV1["source"];

type ReviewContextClient = Pick<
  FacilityGithubClient,
  "getDefaultBranchSha" | "getIssue" | "listIssueComments" | "compareCommits"
>;

export type ReviewContextOptions = BuilderPlanFreshnessOptions & {
  config?: AppConfig;
  githubFactory?: GithubClientFactory;
  githubClient?: { owner: string; repo: string; client: ReviewContextClient };
  now?: Date;
};

export async function buildPlanReviewContext(
  db: FacilityDb,
  proposal: Pick<typeof proposals.$inferSelect, "orgId" | "projectId" | "payload">,
  source: ReviewContextSource,
  options: ReviewContextOptions = {},
): Promise<ReviewContextV1> {
  const payload = objectValue(proposal.payload);
  const repoId = stringValue(payload.repoId);
  const planBaseSha = gitSha(payload.workspaceBaseSha);
  const planSha256 = sha256Digest(payload.planSha256);
  const presentedAt = (options.now ?? new Date()).toISOString();
  const repo =
    proposal.projectId && repoId
      ? (
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
        )[0]
      : undefined;
  const common = {
    version: 1 as const,
    source,
    repository: repo ? { id: repo.id, owner: repo.owner, name: repo.name } : null,
    branch: repo?.defaultBranch ?? null,
    planBaseSha,
    planSha256,
    presentedAt,
  };
  if (!repoId || !planBaseSha || !planSha256) {
    return { ...common, status: "unavailable", reason: "proposal_context_invalid" };
  }
  if (!repo) return { ...common, status: "unavailable", reason: "repository_unavailable" };

  let client: ReviewContextClient;
  try {
    if (options.githubClient) {
      if (options.githubClient.owner !== repo.owner || options.githubClient.repo !== repo.name) {
        return { ...common, status: "unavailable", reason: "github_client_unavailable" };
      }
      client = options.githubClient.client;
    } else {
      const factory =
        options.githubFactory ??
        (options.config ? createGithubClientFactory(options.config) : undefined);
      if (!factory) {
        return { ...common, status: "unavailable", reason: "github_client_unavailable" };
      }
      client = await createGithubClientForRepo(db, factory, repo);
    }
  } catch {
    return { ...common, status: "unavailable", reason: "github_client_unavailable" };
  }

  let freshness: Awaited<ReturnType<typeof resolveBuilderPlanFreshnessForProposal>>;
  try {
    freshness = await resolveBuilderPlanFreshnessForProposal(db, proposal, {
      githubClient: { owner: repo.owner, repo: repo.name, client },
    });
  } catch {
    return { ...common, status: "unavailable", reason: "github_evidence_unavailable" };
  }

  try {
    const comparison =
      planBaseSha === freshness.baseSha
        ? {
            status: "identical" as const,
            aheadBy: 0,
            behindBy: 0,
            changedPaths: [] as string[],
            changedPathsTruncated: false,
          }
        : await client.compareCommits(planBaseSha, freshness.baseSha);
    return {
      ...common,
      status: "available",
      presentedBaseSha: freshness.baseSha,
      issueRevisionSha256: freshness.issueRevisionSha256,
      comparison,
    };
  } catch {
    return { ...common, status: "unavailable", reason: "comparison_unavailable" };
  }
}

export function reviewContextFromEventData(data: unknown) {
  return ReviewContextV1Schema.safeParse(objectValue(data).reviewContext);
}

export function renderReviewContextMarkdown(context: ReviewContextV1) {
  const repository = context.repository
    ? `${context.repository.owner}/${context.repository.name}`
    : "unavailable";
  const lines = [
    "## Review context",
    "",
    `- **Repository:** \`${repository}\``,
    `- **Branch:** \`${context.branch ?? "unavailable"}\``,
    `- **Plan based on:** \`${shortSha(context.planBaseSha)}\``,
  ];
  if (context.status === "available") {
    const changed = context.comparison.changedPaths.length;
    lines.push(
      `- **Currently presented:** \`${shortSha(context.presentedBaseSha)}\``,
      `- **Drift:** ${context.comparison.aheadBy} commits ahead, ${context.comparison.behindBy} behind; ${changed}${context.comparison.changedPathsTruncated ? "+" : ""} changed paths`,
    );
    if (changed) {
      lines.push(
        "",
        "<details>",
        `<summary>Changed paths (${changed}${context.comparison.changedPathsTruncated ? "+" : ""})</summary>`,
        "",
        ...context.comparison.changedPaths.map((path) => `- \`${escapeBackticks(path)}\``),
        "",
        "</details>",
      );
    }
  } else {
    lines.push(
      "- **Currently presented:** unavailable",
      `- **Evidence status:** unavailable (\`${context.reason}\`)`,
    );
  }
  lines.push("", `_Presented at ${context.presentedAt}._`);
  return lines.join("\n");
}

function shortSha(value: string | null) {
  return value ? value.slice(0, 12) : "unavailable";
}

function escapeBackticks(value: string) {
  return value.replace(/`/g, "\\`");
}

function gitSha(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function sha256Digest(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
