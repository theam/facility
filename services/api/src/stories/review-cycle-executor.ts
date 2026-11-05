import type { AgentManifest } from "@facility/agents";
import {
  CONSULTATION_LIMITS,
  DeliveryReviewResultSchema,
  type ReviewCandidate,
} from "@facility/core";
import { type FacilityDb, stories, storyMessages } from "@facility/db";
import { and, desc, eq, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { ReviewSandbox } from "../workspaces/review-sandbox.js";
import { type ConsultationProvider, consultationCapability } from "./consultation-policy.js";
import { callConsultationProvider } from "./consultation-provider.js";
import { underDeadline } from "./consultation-sources.js";
import { ReviewCycleStop } from "./review-cycle-rules.js";
import type { ReviewCycleSource } from "./review-cycle-source.js";
import type { ReviewCycle } from "./review-cycle-state.js";
import { readWorkflowPlan } from "./workflow-execution.js";

const resultContract = JSON.stringify(z.toJSONSchema(DeliveryReviewResultSchema));
const instructions = [
  "Return one JSON object following the schema below. Copy candidate.id and the exact required repository, PR number, baseSha and headSha into reviewedPulls.",
  "Account for each approved acceptance criterion. Use a stable criterion ID. Use it as a finding's requirement when it is violated.",
  "Review all required PRs as one delivery. Trace consumers beyond the diff, security boundaries, existing data and regressions. Report missing essential evidence.",
  "Use open for new or persisting findings. In round 2 include every previous finding by ID and use resolved only with evidence on the new heads.",
  "Use P2 with category suggestion for non-blocking P2 feedback. Use requires_decision for a fix outside the approved scope or a decision the Builder cannot make.",
  "Report CI and isolated tests as observations bound to the candidate. Distinguish static evidence and reproduced behavior.",
].join("\n");

export class ReviewCycleExecutor {
  constructor(
    private readonly db: FacilityDb,
    private readonly source: ReviewCycleSource,
    private readonly credential: (
      scope: { orgId: string; projectId: string },
      provider: ConsultationProvider,
    ) => Promise<string | undefined>,
    private readonly sandbox?: ReviewSandbox,
    private readonly call = callConsultationProvider,
  ) {}

  async run(
    cycle: ReviewCycle,
    reviewer: AgentManifest,
    turnId: string,
    signal: AbortSignal,
    beforeInference: () => Promise<void>,
  ) {
    const scope = { orgId: cycle.orgId, projectId: cycle.projectId, storyId: cycle.storyId };
    const candidate = cycle.data.status.candidate;
    if (!candidate) throw new ReviewCycleStop("The queued review has no pinned candidate.");
    const effort = reviewer.engine === "codex" ? reviewer.options?.reasoning_effort : null;
    const capability = consultationCapability(
      reviewer.engine,
      reviewer.model,
      reviewer.prompt,
      effort,
    );
    if (!capability.eligible)
      throw new ReviewCycleStop("The configured Reviewer needs a supported, priced API model.");
    const apiKey = await this.credential(scope, capability.provider);
    if (!apiKey)
      throw new ReviewCycleStop("The configured Reviewer provider credential is unavailable.");

    const [context, [story], [request]] = await Promise.all([
      readWorkflowPlan(this.db, scope),
      this.db
        .select({ title: stories.title, externalId: stories.externalId })
        .from(stories)
        .where(
          and(
            eq(stories.orgId, scope.orgId),
            eq(stories.projectId, scope.projectId),
            eq(stories.id, scope.storyId),
          ),
        )
        .limit(1),
      this.db
        .select({ seq: storyMessages.seq })
        .from(storyMessages)
        .where(
          and(
            eq(storyMessages.orgId, scope.orgId),
            eq(storyMessages.projectId, scope.projectId),
            eq(storyMessages.storyId, scope.storyId),
            eq(storyMessages.turnId, turnId),
            eq(storyMessages.role, "user"),
          ),
        )
        .limit(1),
    ]);
    if (!story || !request || !context.plan || !context.decision)
      throw new ReviewCycleStop("The approved plan or story context is unavailable.");
    const conversation = await this.db
      .select({
        role: storyMessages.role,
        body: sql<string>`left(${storyMessages.body}, 3000)`,
      })
      .from(storyMessages)
      .where(
        and(
          eq(storyMessages.orgId, scope.orgId),
          eq(storyMessages.projectId, scope.projectId),
          eq(storyMessages.storyId, scope.storyId),
          lte(storyMessages.seq, request.seq - 1),
        ),
      )
      .orderBy(desc(storyMessages.seq))
      .limit(6);

    const evidenceSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
    const [diffs, files] = await Promise.all([
      Promise.all(
        candidate.pullRequests.map(async (pull) => ({
          repository: pull.repository,
          number: pull.number,
          comparison: await this.source.diff(scope, pull, evidenceSignal),
        })),
      ),
      this.readSources(cycle, candidate, evidenceSignal),
    ]);
    let verification: Awaited<ReturnType<ReviewSandbox>> | undefined;
    if (cycle.data.policy.syntheticTest) {
      if (!this.sandbox)
        throw new ReviewCycleStop("Isolated synthetic verification is unavailable on this worker.");
      verification = await this.sandbox(
        cycle.data.policy.syntheticTest.argv,
        files.filter((file) => file.revision === "head").map(({ path, text }) => ({ path, text })),
        signal,
      );
      if (verification.exitCode !== 0)
        throw new ReviewCycleStop(
          "The isolated synthetic verification failed on the pinned candidate.",
        );
    }
    const prompt = [
      reviewer.prompt,
      instructions,
      resultContract,
      JSON.stringify({
        story,
        conversation: conversation.reverse(),
        conversationCoverage:
          "Up to six recent messages, each limited to 3000 characters. The approved plan controls scope.",
        approvedPlan: {
          markdown: context.plan.markdown,
          revision: context.plan.revision,
          decision: context.decision.decisionRevision,
        },
        candidate,
        diffs,
        files,
        verification,
        previous: cycle.data.status.reviews.at(-1)?.result,
      }),
    ].join("\n\n");
    if (prompt.includes(apiKey))
      throw new ReviewCycleStop("The review snapshot contains a provider credential.");
    if (Buffer.byteLength(prompt) > CONSULTATION_LIMITS.inputBytes - 1_000)
      throw new ReviewCycleStop("The complete review snapshot exceeds its input limit.");
    await beforeInference();
    return this.call({
      purpose: "delivery_review",
      provider: capability.provider,
      model: reviewer.model,
      apiKey,
      prompt,
      reasoningEffort: effort,
      signal,
    });
  }
  private async readSources(cycle: ReviewCycle, candidate: ReviewCandidate, signal: AbortSignal) {
    const inputs = (cycle.data.policy.sources ?? []).flatMap((file) => {
      const matches = candidate.pullRequests.filter(
        (pull) => pull.repository.toLowerCase() === file.repository.toLowerCase(),
      );
      if (!matches.length)
        throw new ReviewCycleStop("A configured review source is outside the required PR set.");
      return matches.map((pull) => ({ file, pull, multiple: matches.length > 1 }));
    });
    if (inputs.length > 24) throw new ReviewCycleStop("Too many pinned review files.");
    return Promise.all(
      inputs.map(async ({ file, pull, multiple }) => {
        const source = await underDeadline(
          this.source.files.read(cycle, {
            repository_id: pull.repositoryId,
            commit_sha: file.revision === "base" ? pull.baseSha : pull.headSha,
            path: file.path,
          }),
          signal,
        );
        return {
          path: [pull.repository, ...(multiple ? [pull.number] : []), file.path].join("/"),
          commitSha: source.commitSha,
          revision: file.revision ?? "head",
          text: source.text,
        };
      }),
    );
  }
}
