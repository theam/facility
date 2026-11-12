import {
  type PublishedReviewHead,
  type ReviewCandidate,
  ReviewPullSnapshotSchema,
  type StoryDelivery,
} from "@facility/core";
import {
  type FacilityDb,
  githubChecks,
  storyPreviewConvergences,
  turnGitEvidence,
  workspaceEvents,
  workspaces,
} from "@facility/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { GithubClientFactory } from "../github/client.js";
import { isSafeGitBranch } from "../workspaces/git-branch.js";
import { GithubConsultationSources, underDeadline } from "./consultation-sources.js";
import { readStoryDelivery } from "./delivery.js";
import { deliveryCandidate } from "./delivery-projection.js";
import {
  declaresRegisteredDelivery,
  ReviewCycleStop,
  ReviewEvidenceUnavailable,
  reviewPullKey,
  transientGithubFailure,
} from "./review-cycle-rules.js";
import type { ReviewCycle } from "./review-cycle-state.js";
import { type WorkflowScope, workflowDigest } from "./workflow-policy.js";

type Pull = ReviewCandidate["pullRequests"][number];
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const PullRef = z.object({
  sha,
  ref: z.string(),
  repo: z.object({ full_name: z.string() }),
});
const GithubPull = z.object({
  number: z.number().int().positive(),
  state: z.literal("open"),
  draft: z.literal(false),
  head: PullRef,
  base: PullRef,
  changed_files: z.number().int().min(1).max(100),
  labels: z
    .array(z.object({ name: z.string() }))
    .max(100)
    .optional(),
});
const ComparedFile = z.object({
  filename: z.string().min(1).max(500),
  previous_filename: z.string().min(1).max(500).optional(),
  status: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().max(40_000),
});
const GithubCompare = z.object({
  base_commit: z.object({ sha }),
  merge_base_commit: z.object({ sha }),
  status: z.enum(["ahead", "diverged"]),
  files: z.array(ComparedFile).max(100),
});

export class ReviewCycleSource {
  readonly files: GithubConsultationSources;

  constructor(
    db: FacilityDb,
    private readonly factory: GithubClientFactory,
  ) {
    this.files = new GithubConsultationSources(db, factory);
  }

  private async get(
    db: FacilityDb | undefined,
    scope: WorkflowScope,
    pull: { repositoryId: string; repository: string },
    query: { number: number } | { from: string; to: string },
    signal: AbortSignal,
  ) {
    try {
      return await underDeadline(this.getConnected(db, scope, pull, query, signal), signal);
    } catch (error) {
      if (error instanceof ReviewCycleStop) throw error;
      if (transientGithubFailure(error)) throw new ReviewEvidenceUnavailable();
      throw new ReviewCycleStop("Required GitHub evidence could not be verified.");
    }
  }

  private async getConnected(
    db: FacilityDb | undefined,
    scope: WorkflowScope,
    pull: { repositoryId: string; repository: string },
    query: { number: number } | { from: string; to: string },
    signal: AbortSignal,
  ) {
    const repository = await this.files.identity(scope, pull.repositoryId, db);
    if (pull.repository.toLowerCase() !== `${repository.owner}/${repository.name}`.toLowerCase())
      throw new ReviewCycleStop("A connected repository changed during review.");
    const client = await this.factory(repository.installationNumber);
    if (!client.request) throw new ReviewCycleStop("GitHub evidence is unavailable.");
    signal.throwIfAborted();
    const args = {
      owner: repository.owner,
      repo: repository.name,
      request: { signal, timeout: 10_000 },
    };
    return (
      "number" in query
        ? await client.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
            ...args,
            pull_number: query.number,
          })
        : await client.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
            ...args,
            basehead: `${sha.parse(query.from)}...${sha.parse(query.to)}`,
            per_page: 1,
          })
    ).data;
  }

  async pull(
    db: FacilityDb,
    scope: WorkflowScope,
    expected: Pick<Pull, "repositoryId" | "repository" | "number" | "primary">,
    signal: AbortSignal,
    requiredLabel?: string,
  ) {
    const value = GithubPull.safeParse(
      await this.get(db, scope, expected, { number: expected.number }, signal),
    );
    if (
      !value.success ||
      value.data.number !== expected.number ||
      [value.data.head, value.data.base].some(
        (ref) =>
          ref.repo.full_name.toLowerCase() !== expected.repository.toLowerCase() ||
          !isSafeGitBranch(ref.ref),
      )
    )
      throw new ReviewCycleStop(
        "A required PR is unavailable, draft, closed, or outside its connected repository.",
      );
    if (
      requiredLabel &&
      !value.data.labels?.some((label) => label.name.toLowerCase() === requiredLabel.toLowerCase())
    )
      throw new ReviewCycleStop(
        "A required PR lacks the label that assigns review ownership to Facility.",
      );
    return {
      ...expected,
      headRef: value.data.head.ref,
      headSha: value.data.head.sha,
      baseRef: value.data.base.ref,
      baseSha: value.data.base.sha,
      changedFiles: value.data.changed_files,
      url: `https://github.com/${expected.repository}/pull/${expected.number}`,
    };
  }

  async diff(scope: WorkflowScope, pull: Pull, signal: AbortSignal) {
    const comparison = GithubCompare.safeParse(
      await this.get(undefined, scope, pull, { from: pull.baseSha, to: pull.headSha }, signal),
    );
    if (
      !comparison.success ||
      comparison.data.base_commit.sha !== pull.baseSha ||
      comparison.data.files.length !== pull.changedFiles ||
      comparison.data.files.some((file) => {
        const lines = file.patch.split("\n");
        return (
          lines.filter((line) => line.startsWith("+")).length !== file.additions ||
          lines.filter((line) => line.startsWith("-")).length !== file.deletions
        );
      })
    )
      throw new ReviewCycleStop(
        "GitHub could not supply the complete pinned diff for a required PR.",
      );
    return comparison.data;
  }

  async fastForward(
    db: FacilityDb,
    scope: WorkflowScope,
    before: Pull,
    after: Pull,
    signal: AbortSignal,
  ) {
    const comparison = z
      .object({
        status: z.literal("ahead"),
        base_commit: z.object({ sha }),
        merge_base_commit: z.object({ sha }),
      })
      .safeParse(
        await this.get(db, scope, after, { from: before.headSha, to: after.headSha }, signal),
      );
    return (
      comparison.success &&
      comparison.data.base_commit.sha === before.headSha &&
      comparison.data.merge_base_commit.sha === before.headSha
    );
  }
}

export type CandidateEvidence =
  | { state: "waiting"; reason: string; candidate?: ReviewCandidate }
  | { state: "ready"; candidate: ReviewCandidate };

/** Under the story lock: the registered delivery is still the one the evidence read
 * outside the lock describes. GitHub is not called here. */
export async function assertDeliveryUnchanged(
  db: FacilityDb,
  scope: WorkflowScope,
  candidate: ReviewCandidate | null | undefined,
) {
  if (!candidate) return;
  // The candidate pins live heads, which the stored mirror may not show yet; the
  // registered scope is what must not change between the read and the lock.
  const delivery = await readStoryDelivery(db, scope);
  if (delivery.scope.revision !== candidate.scopeRevision)
    throw new ReviewCycleStop("The registered delivery scope changed during the cycle.");
}

function assertCompleteRegister(delivery: StoryDelivery, heads: PublishedReviewHead[] | null) {
  if (!declaresRegisteredDelivery(delivery, heads))
    throw new ReviewCycleStop(
      "Register the complete delivery and verify the Builder's exact published heads.",
    );
  return delivery.pullRequests.filter((pull) => pull.required);
}

export async function captureReviewCandidate(
  db: FacilityDb,
  source: ReviewCycleSource,
  cycle: ReviewCycle,
  requirePreview: boolean,
  signal: AbortSignal,
): Promise<CandidateEvidence> {
  const delivery = await readStoryDelivery(db, cycle);
  const required = assertCompleteRegister(delivery, cycle.data.expectedHeads);
  const observed = await Promise.all(
    required.map(async (pull) => {
      const live = await source.pull(
        db,
        cycle,
        {
          repositoryId: pull.repositoryId,
          repository: pull.repository,
          number: pull.number,
          primary: pull.primary,
        },
        signal,
        cycle.data.policy.requiredPullLabel,
      );
      if (
        cycle.data.expectedHeads?.find((head) => reviewPullKey(head) === reviewPullKey(live))
          ?.headSha !== live.headSha
      )
        throw new ReviewCycleStop("A required PR head differs from the Builder's published head.");
      const runs = await db
        .select({
          id: githubChecks.checkId,
          name: githubChecks.name,
          status: githubChecks.status,
          conclusion: githubChecks.conclusion,
          observedAt: githubChecks.syncedAt,
        })
        .from(githubChecks)
        .where(
          and(
            eq(githubChecks.orgId, cycle.orgId),
            eq(githubChecks.projectId, cycle.projectId),
            eq(githubChecks.repositoryId, pull.repositoryId),
            eq(githubChecks.headSha, live.headSha),
          ),
        )
        .orderBy(desc(githubChecks.updatedAt), desc(githubChecks.checkId))
        .limit(100);
      const byName = new Map<string, (typeof runs)[number]>();
      for (const run of runs) if (!byName.has(run.name)) byName.set(run.name, run);
      return ReviewPullSnapshotSchema.parse({
        ...live,
        checks: {
          headSha: pull.checks.headSha,
          state:
            pull.checks.current && pull.headSha === live.headSha ? pull.checks.state : "unobserved",
          observedAt: pull.checks.observedAt,
          runs: [...byName.values()].map((run) => ({
            ...run,
            observedAt: run.observedAt.toISOString(),
          })),
        },
      });
    }),
  );
  const primary = observed.find((pull) => pull.primary);
  const [evidence] = await db
    .select()
    .from(turnGitEvidence)
    .where(
      and(
        eq(turnGitEvidence.orgId, cycle.orgId),
        eq(turnGitEvidence.projectId, cycle.projectId),
        eq(turnGitEvidence.storyId, cycle.storyId),
        eq(turnGitEvidence.turnId, cycle.data.lastBuilderTurnId),
      ),
    )
    .limit(1);
  if (
    !primary ||
    !evidence?.completedAt ||
    evidence.captureError ||
    evidence.dirty ||
    evidence.finalBranch !== primary.headRef ||
    evidence.finalSha !== primary.headSha
  )
    throw new ReviewCycleStop(
      "The retained Builder checkout does not prove the primary PR branch and published head.",
    );
  if (cycle.data.status.candidate) {
    await assertSameCode(db, source, cycle, observed, delivery.scope.revision, signal);
  }
  // Pin exact live code even when the mirror still has the previous Builder head.
  // Later observations may fill in evidence, never replace this code snapshot.
  const code = deliveryCandidate(
    delivery.scope,
    delivery.pullRequests.map((pull) => {
      const live = observed.find((item) => reviewPullKey(item) === reviewPullKey(pull));
      return live ? { ...pull, headSha: live.headSha, state: "open", stale: false } : pull;
    }),
  );
  if (!code.revision) throw new ReviewCycleStop("The delivery revision could not be pinned.");
  const [preview] = await db
    .select()
    .from(storyPreviewConvergences)
    .where(
      and(
        eq(storyPreviewConvergences.orgId, cycle.orgId),
        eq(storyPreviewConvergences.projectId, cycle.projectId),
        eq(storyPreviewConvergences.storyId, cycle.storyId),
      ),
    )
    .limit(1);
  const previewEvidence: ReviewCandidate["preview"] =
    preview?.state === "ready" &&
    preview.deployedGeneration === code.revision &&
    preview.desiredGeneration === code.revision
      ? { generation: preview.deployedGeneration, observedAt: preview.updatedAt.toISOString() }
      : null;
  if (previewEvidence) {
    const [event] = await db
      .select({ data: workspaceEvents.data })
      .from(workspaceEvents)
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, workspaceEvents.workspaceId),
          eq(workspaces.orgId, workspaceEvents.orgId),
        ),
      )
      .where(
        and(
          eq(workspaceEvents.orgId, cycle.orgId),
          eq(workspaces.projectId, cycle.projectId),
          eq(workspaces.storyId, cycle.storyId),
          eq(workspaceEvents.type, "preview.converged"),
          sql`${workspaceEvents.data}->>'generation' = ${previewEvidence.generation}`,
        ),
      )
      .orderBy(desc(workspaceEvents.createdAt))
      .limit(1);
    const sources = z
      .object({
        sources: z
          .array(
            z.object({
              repository: z.string(),
              headSha: sha,
              submodules: z
                .array(
                  z.object({
                    repository: z.string(),
                    path: z.string(),
                    pinnedSha: sha,
                    headSha: sha,
                  }),
                )
                .max(100),
            }),
          )
          .max(50),
      })
      .safeParse(event?.data);
    if (sources.success) previewEvidence.sources = sources.data.sources;
  }
  const candidate: ReviewCandidate = {
    id: workflowDigest({
      authorization: cycle.data.authorization,
      reviewerManifestHash: cycle.data.reviewerManifestHash,
      deliveryRevision: code.revision,
      code: observed.map(codeIdentity),
    }),
    deliveryRevision: code.revision,
    scopeRevision: delivery.scope.revision,
    pullRequests: observed,
    preview: previewEvidence,
  };
  if (
    delivery.candidate.state !== "recorded" ||
    delivery.candidate.revision !== code.revision ||
    required.some((pull) => pull.state !== "open" || pull.draft !== false)
  )
    return {
      state: "waiting",
      candidate,
      reason: "Waiting for GitHub to observe the exact published heads.",
    };
  if (observed.some((pull) => pull.checks.state === "failure"))
    throw new ReviewCycleStop("CI failed on a required PR head.");
  if (observed.some((pull) => pull.checks.state !== "success" || !pull.checks.observedAt))
    return {
      state: "waiting",
      candidate,
      reason: "Waiting for CI evidence on all required heads.",
    };
  for (const requiredCheck of cycle.data.policy.requiredChecks ?? []) {
    const pull = observed.find(
      (item) => item.repository.toLowerCase() === requiredCheck.repository.toLowerCase(),
    );
    if (!pull)
      throw new ReviewCycleStop("A configured required check is outside the registered PR set.");
    const check = pull.checks.runs.find((run) => run.name === requiredCheck.name);
    if (check?.status !== "completed")
      return {
        state: "waiting",
        candidate,
        reason: "Waiting for the configured required checks on the exact heads.",
      };
    if (check.conclusion !== "success")
      throw new ReviewCycleStop("A configured required check did not succeed on its exact head.");
  }
  if (requirePreview && !previewEvidence) {
    if (
      preview &&
      ["blocked", "failed"].includes(preview.state) &&
      preview.desiredGeneration === candidate.deliveryRevision
    )
      throw new ReviewCycleStop("The required preview failed or is blocked for this candidate.");
    return {
      state: "waiting",
      candidate,
      reason: "Waiting for a preview of the exact delivery candidate.",
    };
  }
  return { state: "ready", candidate };
}

function codeIdentity(pull: Pull) {
  return [
    pull.repositoryId,
    pull.number,
    pull.baseRef,
    pull.baseSha,
    pull.headRef,
    pull.headSha,
    pull.primary,
  ];
}

async function assertSameCode(
  db: FacilityDb,
  source: ReviewCycleSource,
  cycle: ReviewCycle,
  live: Pull[],
  scopeRevision: number,
  signal: AbortSignal,
) {
  const baseline = cycle.data.status.candidate;
  if (!baseline) return;
  const correcting =
    cycle.phase === "waiting_for_evidence" &&
    cycle.data.lastBuilderTurnId !== cycle.originTurnId &&
    cycle.data.status.reviews.at(-1)?.candidate.id === baseline.id;
  if (baseline.scopeRevision !== scopeRevision || baseline.pullRequests.length !== live.length)
    throw new ReviewCycleStop("The registered delivery scope changed during the cycle.");
  let changed = false;
  for (const pull of live) {
    const before = baseline.pullRequests.find(
      (item) => reviewPullKey(item) === reviewPullKey(pull),
    );
    if (
      !before ||
      workflowDigest(codeIdentity({ ...pull, headSha: before.headSha })) !==
        workflowDigest(codeIdentity(before))
    )
      throw new ReviewCycleStop("A required PR or base commit changed during the cycle.");
    if (before.headSha === pull.headSha) continue;
    changed = true;
    if (!correcting || !(await source.fastForward(db, cycle, before, pull, signal)))
      throw new ReviewCycleStop(
        "A required PR head changed outside an authorized fast-forward correction.",
      );
  }
  if (correcting && !changed)
    throw new ReviewCycleStop("The Builder correction did not publish a new candidate.");
}
