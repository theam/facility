import { createHash } from "node:crypto";
import { FacilityReceiptSchema, verifyFacilityReceipt } from "@facility/core";
import {
  type AuditInsert,
  actionTypes,
  agentDefs,
  type FacilityDb,
  insertAuditEvent,
  projects,
  proposalEvents,
  proposals,
  repos,
  runs,
} from "@facility/db";
import { agentDefTriggersBuilder, isBuilderMode } from "@facility/run-objective";
import { and, eq, sql } from "drizzle-orm";
import { ApiError } from "./errors.js";

export type BuilderPlanPolicy = "optional" | "required";
export type BuilderPlanDenialCode =
  | "builder_plan_required"
  | "builder_plan_context_invalid"
  | "builder_plan_expired"
  | "builder_plan_rejected"
  | "builder_plan_already_consumed"
  | "builder_plan_stale"
  | "builder_plan_freshness_unavailable";

const BUILDER_PLAN_DENIAL_CODES = new Set<BuilderPlanDenialCode>([
  "builder_plan_required",
  "builder_plan_context_invalid",
  "builder_plan_expired",
  "builder_plan_rejected",
  "builder_plan_already_consumed",
  "builder_plan_stale",
  "builder_plan_freshness_unavailable",
]);

export type BuilderPlanDispatchInput = {
  orgId: string;
  projectId: string;
  mode: string;
  agentDefId?: string | null;
  agentName?: string | null;
  trigger: unknown;
  gh?: unknown;
  runId?: string | null;
  actor?: AuditInsert["actor"];
  source?: string;
  /** Trusted, live evidence resolved by the canonical executor/worker, never request JSON. */
  freshnessEvidence?: {
    baseSha: string;
    issueRevisionSha256: string;
    checkedAt: string;
  };
};

/**
 * Immutable classification produced while the project/agent admission lock is
 * held. Producers must persist `mode`; downstream policy must never have to
 * infer a queued run's security role from a mutable agent definition.
 */
export type BuilderPlanAdmission = {
  mode: string;
  isBuilder: boolean;
};

type BuilderPlanDecisionInput = {
  policy: BuilderPlanPolicy;
  mode: string;
  agentName?: string | null;
  agentIsBuilder?: boolean;
  trigger: unknown;
  acceptanceValid: boolean;
  denialCode?: BuilderPlanDenialCode;
};

export type BuilderPlanDecision =
  | { allowed: true }
  | { allowed: false; code: BuilderPlanDenialCode };

type AcceptanceValidation =
  | { valid: true }
  | { valid: false; code: BuilderPlanDenialCode; reason: string };

const FRESHNESS_EVIDENCE_MAX_AGE_MS = 5 * 60_000;
const FRESHNESS_EVIDENCE_FUTURE_SKEW_MS = 30_000;

/**
 * Pure policy seam shared by API preflight and the worker's final dispatch guard.
 * `acceptanceValid` is deliberately supplied by the caller so tests cannot make
 * a syntactically plausible trigger stand in for durable proposal provenance.
 */
export function builderPlanDecision(input: BuilderPlanDecisionInput): BuilderPlanDecision {
  if (
    !(input.agentIsBuilder ?? builderIdentity(input.mode, input.agentName)) ||
    input.policy === "optional"
  ) {
    return { allowed: true };
  }
  if (objectValue(input.trigger).source !== "plan_acceptance") {
    return { allowed: false, code: "builder_plan_required" };
  }
  return input.acceptanceValid
    ? { allowed: true }
    : { allowed: false, code: input.denialCode ?? "builder_plan_context_invalid" };
}

export function builderIdentity(mode: string, agentName?: string | null) {
  return isBuilderMode(mode) || (agentName ? isBuilderMode(agentName) : false);
}

export function isBuilderPlanDenialError(error: unknown): error is ApiError {
  return error instanceof ApiError && builderPlanDenialCode(error.code) !== null;
}

export function builderPlanDenialCode(value: unknown): BuilderPlanDenialCode | null {
  return typeof value === "string" && BUILDER_PLAN_DENIAL_CODES.has(value as BuilderPlanDenialCode)
    ? (value as BuilderPlanDenialCode)
    : null;
}

export async function builderPlanRequired(
  db: FacilityDb,
  orgId: string,
  projectId: string,
): Promise<boolean> {
  const project = (
    await db
      .select({ policy: projects.builderPlanPolicy })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
      .limit(1)
  )[0];
  if (!project) throw new ApiError(404, "project_not_found", "Project not found");
  return project.policy === "required";
}

/**
 * Serialize Builder admission with project policy activation. Every run
 * producer performs its policy check and insert inside this transaction;
 * PATCHing a project to `required` takes the same lock. This closes the window
 * where a producer could observe `optional`, an administrator could enable the
 * gate, and the producer could then insert an ungoverned row.
 */
export async function withBuilderPlanPreflight<T>(
  db: FacilityDb,
  input: BuilderPlanDispatchInput,
  create: (tx: FacilityDb, admission: BuilderPlanAdmission) => Promise<T>,
): Promise<T> {
  try {
    return await db.transaction(async (transaction) => {
      const tx = transaction as unknown as FacilityDb;
      await lockBuilderPlanPolicy(tx, input.orgId, input.projectId);
      const admission = await assertBuilderPlanDispatch(tx, input);
      return create(tx, admission);
    });
  } catch (error) {
    // The denial audit written by assertBuilderPlanDispatch participates in the
    // admission transaction and is rolled back with the denied insert. Re-emit
    // it after rollback so the stable decision remains durable.
    const apiError = error instanceof ApiError ? error : null;
    const code = apiError ? builderPlanDenialCode(apiError.code) : null;
    if (code) {
      const details = objectValue(apiError?.details);
      await recordBuilderPlanDenial(
        db,
        input,
        code,
        stringValue(details.reason) ?? "transactional_preflight_denied",
      );
    }
    throw error;
  }
}

/** Must be called from an open transaction. */
export async function lockBuilderPlanPolicy(
  db: FacilityDb,
  orgId: string,
  projectId: string,
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`builder-plan:${orgId}:${projectId}`}, 0))`,
  );
}

/**
 * Fail closed immediately before a Builder row can be inserted or provisioned.
 * A reserved trigger string is insufficient: required projects accept only a
 * proposal Facility opened for a sealed Architect receipt and a distinct,
 * durable approval event.
 */
export async function assertBuilderPlanDispatch(
  db: FacilityDb,
  input: BuilderPlanDispatchInput,
): Promise<BuilderPlanAdmission> {
  const agent = await resolvedAgentIdentity(db, input);
  const admission: BuilderPlanAdmission = {
    mode: agent.isBuilder ? canonicalBuilderRunMode(input, agent) : input.mode,
    isBuilder: agent.isBuilder,
  };
  const required = await builderPlanRequired(db, input.orgId, input.projectId);
  if (required && input.agentDefId && !agent.found) {
    await recordBuilderPlanDenial(
      db,
      input,
      "builder_plan_context_invalid",
      "agent_definition_scope_mismatch",
    );
    throw new ApiError(
      409,
      "builder_plan_context_invalid",
      "Builder plan dispatch could not verify the agent definition in this project",
      { reason: "agent_definition_scope_mismatch" },
    );
  }
  if (!agent.isBuilder) return admission;
  if (!required) return admission;

  const trigger = objectValue(input.trigger);
  const validation =
    trigger.source === "plan_acceptance"
      ? await validatePlanAcceptance(db, input, trigger)
      : ({
          valid: false,
          code: "builder_plan_required",
          reason: "plan_acceptance_missing",
        } as const);
  const decision = builderPlanDecision({
    policy: "required",
    mode: input.mode,
    agentName: agent.name,
    agentIsBuilder: agent.isBuilder,
    trigger,
    acceptanceValid: validation.valid,
    denialCode: validation.valid ? undefined : validation.code,
  });
  if (decision.allowed) return admission;
  const denialReason = validation.valid ? "plan_acceptance_invalid" : validation.reason;

  await recordBuilderPlanDenial(db, input, decision.code, denialReason);

  if (decision.code === "builder_plan_required") {
    throw new ApiError(
      409,
      decision.code,
      "This project requires an approved Architect plan before Builder can run",
      { reason: denialReason },
    );
  }
  throw new ApiError(
    409,
    decision.code,
    "Builder plan acceptance is missing valid Facility proposal provenance",
    { reason: denialReason },
  );
}

export async function recordBuilderPlanDenial(
  db: FacilityDb,
  input: BuilderPlanDispatchInput,
  code: BuilderPlanDenialCode,
  reason: string,
): Promise<void> {
  const agentName = (await resolvedAgentIdentity(db, input)).name;
  const trigger = objectValue(input.trigger);
  const planProvenance = objectValue(trigger.planProvenance);
  const expectedBaseSha = gitShaValue(planProvenance.workspaceBaseSha);
  const expectedIssueRevisionSha256 = sha256Value(planProvenance.issueRevisionSha256);
  const observedBaseSha = gitShaValue(input.freshnessEvidence?.baseSha);
  const observedIssueRevisionSha256 = sha256Value(input.freshnessEvidence?.issueRevisionSha256);
  await insertAuditEvent(db, {
    orgId: input.orgId,
    projectId: input.projectId,
    actor: input.actor ?? { type: "system", id: "builder-plan-policy" },
    action: "run.builder_plan_denied",
    target: input.runId
      ? { type: "run", id: input.runId }
      : { type: "project", id: input.projectId },
    payload: {
      code,
      reason,
      source: input.source ?? "unknown",
      mode: input.mode,
      agentDefId: input.agentDefId ?? null,
      agentName: agentName ?? null,
      proposalId: stringValue(trigger.proposalId),
      architectRunId: stringValue(trigger.architectRunId),
      expectedPlanInputs: {
        baseSha: expectedBaseSha,
        issueRevisionSha256: expectedIssueRevisionSha256,
      },
      observedPlanInputs: {
        baseSha: observedBaseSha,
        issueRevisionSha256: observedIssueRevisionSha256,
        checkedAt: stringValue(input.freshnessEvidence?.checkedAt),
      },
    },
  });
}

async function resolvedAgentIdentity(db: FacilityDb, input: BuilderPlanDispatchInput) {
  if (!input.agentDefId) {
    const name = input.agentName ?? null;
    return { name, triggers: null, isBuilder: builderIdentity(input.mode, name), found: true };
  }
  const agent = (
    await db
      .select({ name: agentDefs.name, triggers: agentDefs.triggers })
      .from(agentDefs)
      .where(
        and(
          eq(agentDefs.orgId, input.orgId),
          eq(agentDefs.projectId, input.projectId),
          eq(agentDefs.id, input.agentDefId),
        ),
      )
      .limit(1)
  )[0];
  const name = agent?.name ?? input.agentName ?? null;
  return {
    name,
    triggers: agent?.triggers ?? null,
    found: Boolean(agent),
    isBuilder:
      builderIdentity(input.mode, name) ||
      (agent ? agentDefTriggersBuilder(agent.triggers) : false),
  };
}

function canonicalBuilderRunMode(
  input: BuilderPlanDispatchInput,
  agent: { name: string | null; triggers: unknown },
): "builder" | "codex-builder" {
  const candidates = [
    input.mode,
    input.agentName,
    agent.name,
    ...agentTriggerCommands(agent.triggers),
  ];
  return candidates.some((candidate) => canonicalAgentToken(candidate) === "codex-builder")
    ? "codex-builder"
    : "builder";
}

function agentTriggerCommands(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((trigger) => {
    const entry = objectValue(trigger);
    return [entry.command, entry.handle];
  });
}

function canonicalAgentToken(value: unknown): string | null {
  return typeof value === "string" ? value.replace(/^\//, "").replaceAll("_", "-") : null;
}

async function validatePlanAcceptance(
  db: FacilityDb,
  input: BuilderPlanDispatchInput,
  trigger: Record<string, unknown>,
): Promise<AcceptanceValidation> {
  const proposalId = stringValue(trigger.proposalId);
  const architectRunId = stringValue(trigger.architectRunId);
  const approvedPlan = stringValue(trigger.approvedPlan);
  if (!proposalId || !architectRunId || !approvedPlan) {
    return invalid("builder_plan_context_invalid", "trigger_context_missing");
  }

  const proposal = (
    await db
      .select()
      .from(proposals)
      .where(
        and(
          eq(proposals.orgId, input.orgId),
          eq(proposals.projectId, input.projectId),
          eq(proposals.id, proposalId),
        ),
      )
      .limit(1)
  )[0];
  if (!proposal) return invalid("builder_plan_context_invalid", "proposal_not_found");
  if (proposal.state === "expired") {
    return invalid("builder_plan_expired", "proposal_expired");
  }
  if (proposal.state === "rejected") {
    return invalid("builder_plan_rejected", "proposal_rejected");
  }
  if (
    (proposal.state === "open" && proposal.expiresAt.getTime() <= Date.now()) ||
    (proposal.decidedAt && proposal.decidedAt.getTime() > proposal.expiresAt.getTime())
  ) {
    return invalid("builder_plan_expired", "proposal_expired");
  }
  const linkedRuns = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, input.orgId),
        eq(runs.projectId, input.projectId),
        sql`${runs.trigger}->>'source' = 'plan_acceptance'`,
        sql`${runs.trigger}->>'proposalId' = ${proposal.id}`,
      ),
    )
    .limit(2);
  if (linkedRuns.some((run) => run.id !== input.runId)) {
    return invalid("builder_plan_already_consumed", "proposal_linked_to_another_run");
  }
  const architectLinkedRuns = await db
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(
        eq(runs.orgId, input.orgId),
        eq(runs.projectId, input.projectId),
        sql`${runs.trigger}->>'source' = 'plan_acceptance'`,
        sql`${runs.trigger}->>'architectRunId' = ${architectRunId}`,
      ),
    )
    .limit(2);
  if (architectLinkedRuns.some((run) => run.id !== input.runId)) {
    return invalid("builder_plan_already_consumed", "architect_plan_linked_to_another_run");
  }
  const dispatchingLinkedRun = Boolean(
    input.runId &&
      linkedRuns.some((run) => run.id === input.runId) &&
      architectLinkedRuns.some((run) => run.id === input.runId),
  );
  if (proposal.state === "executed" && !dispatchingLinkedRun) {
    return invalid("builder_plan_context_invalid", "executed_proposal_missing_linked_run");
  }
  if (
    proposal.state !== "executing" &&
    proposal.state !== "executed" &&
    !(proposal.state === "execution_failed" && dispatchingLinkedRun)
  ) {
    return invalid("builder_plan_context_invalid", "proposal_not_executing");
  }
  if (!proposal.decidedBy || !proposal.decidedAt) {
    return invalid("builder_plan_context_invalid", "approval_decision_missing");
  }
  if (proposal.runId !== architectRunId) {
    return invalid("builder_plan_context_invalid", "architect_run_link_mismatch");
  }
  const actionType = (
    await db
      .select()
      .from(actionTypes)
      .where(and(eq(actionTypes.orgId, input.orgId), eq(actionTypes.id, proposal.actionTypeId)))
      .limit(1)
  )[0];
  if (!actionType) return invalid("builder_plan_context_invalid", "action_type_missing");
  if (actionType.name !== "plan_acceptance") {
    return invalid("builder_plan_context_invalid", "action_type_invalid");
  }
  if (objectValue(actionType.executor).type !== "internal") {
    return invalid("builder_plan_context_invalid", "action_executor_invalid");
  }
  if (proposal.contextMd.trim().length === 0 || proposal.contextMd !== approvedPlan) {
    return invalid("builder_plan_context_invalid", "approved_plan_mismatch");
  }
  const planSha256 = createHash("sha256").update(proposal.contextMd).digest("hex");
  const payload = objectValue(proposal.payload);
  const approvalContext = objectValue(trigger.approval);
  const recordedPlanSha256 = payload.planSha256;
  if (
    (recordedPlanSha256 !== undefined && sha256Value(recordedPlanSha256) !== planSha256) ||
    sha256Value(trigger.planSha256) !== planSha256 ||
    stringValue(approvalContext.principal) !== proposal.decidedBy ||
    stringValue(approvalContext.at) !== proposal.decidedAt.toISOString()
  ) {
    return invalid("builder_plan_context_invalid", "plan_or_approval_identity_mismatch");
  }

  const architectRun = (
    await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.orgId, input.orgId),
          eq(runs.projectId, input.projectId),
          eq(runs.id, architectRunId),
        ),
      )
      .limit(1)
  )[0];
  if (!architectRun) {
    return invalid("builder_plan_context_invalid", "architect_run_not_found");
  }
  if (architectRun.status !== "succeeded") {
    return invalid("builder_plan_context_invalid", "architect_run_not_succeeded");
  }
  if (!(await architectRunIdentityValid(db, architectRun))) {
    return invalid("builder_plan_context_invalid", "architect_identity_invalid");
  }

  const events = await db
    .select()
    .from(proposalEvents)
    .where(and(eq(proposalEvents.orgId, input.orgId), eq(proposalEvents.proposalId, proposal.id)));
  const opener = events.find((event) => event.seq === 1);
  const openerActor = objectValue(opener?.actor);
  if (
    opener?.type !== "open" ||
    openerActor.type !== "agent" ||
    openerActor.id !== architectRun.id ||
    objectValue(opener.data).source !== "architect_run"
  ) {
    return invalid("builder_plan_context_invalid", "proposal_origin_invalid");
  }
  const approval = events.find((event) => {
    if (event.type !== "approved") return false;
    const actor = objectValue(event.actor);
    return actor.id === proposal.decidedBy && actor.type === "user";
  });
  if (!approval) return invalid("builder_plan_context_invalid", "approval_event_invalid");

  const repoId = stringValue(payload.repoId);
  const issueNumber = positiveInteger(payload.issueNumber);
  const receiptSha256 = sha256Value(payload.receiptSha256);
  const expectedBaseSha = gitShaValue(payload.workspaceBaseSha);
  const expectedIssueRevision = sha256Value(payload.issueRevisionSha256);
  const planProvenance = objectValue(trigger.planProvenance);
  if (
    stringValue(payload.architectRunId) !== architectRun.id ||
    !repoId ||
    !issueNumber ||
    !receiptSha256
  ) {
    return invalid("builder_plan_context_invalid", "proposal_context_invalid");
  }
  if (
    expectedBaseSha &&
    expectedIssueRevision &&
    (gitShaValue(planProvenance.workspaceBaseSha) !== expectedBaseSha ||
      sha256Value(planProvenance.issueRevisionSha256) !== expectedIssueRevision)
  ) {
    return invalid("builder_plan_context_invalid", "plan_provenance_mismatch");
  }
  const repo = (
    await db
      .select()
      .from(repos)
      .where(
        and(
          eq(repos.orgId, input.orgId),
          eq(repos.projectId, input.projectId),
          eq(repos.id, repoId),
        ),
      )
      .limit(1)
  )[0];
  if (!repo) return invalid("builder_plan_context_invalid", "proposal_repo_invalid");

  const architectGh = objectValue(architectRun.gh);
  const architectTrigger = objectValue(architectRun.trigger);
  const triggerRepo = objectValue(architectTrigger.repo);
  const triggerIssue = objectValue(architectTrigger.issue);
  if (
    architectGh.owner !== repo.owner ||
    architectGh.repo !== repo.name ||
    positiveInteger(architectGh.issueNumber) !== issueNumber ||
    triggerRepo.id !== repo.id ||
    triggerRepo.owner !== repo.owner ||
    triggerRepo.name !== repo.name ||
    positiveInteger(triggerIssue.number) !== issueNumber
  ) {
    return invalid("builder_plan_context_invalid", "architect_issue_context_invalid");
  }

  const builderGh = objectValue(input.gh);
  if (
    builderGh.owner !== repo.owner ||
    builderGh.repo !== repo.name ||
    positiveInteger(builderGh.issueNumber) !== issueNumber
  ) {
    return invalid("builder_plan_context_invalid", "builder_issue_context_invalid");
  }

  const receipt = FacilityReceiptSchema.safeParse(architectRun.receipt);
  if (!receipt.success || !verifyFacilityReceipt(receipt.data)) {
    return invalid("builder_plan_context_invalid", "architect_receipt_invalid");
  }
  const expectedReceiptMode = architectReceiptMode(architectRun.mode);
  if (
    !expectedReceiptMode ||
    receipt.data.integrity?.payload_sha256 !== receiptSha256 ||
    receipt.data.run_id !== architectRun.id ||
    receipt.data.project_id !== input.projectId ||
    receipt.data.mode !== expectedReceiptMode ||
    receipt.data.result !== "succeeded" ||
    receipt.data.github?.owner !== repo.owner ||
    receipt.data.github?.repo !== repo.name ||
    receipt.data.github?.issue !== issueNumber ||
    (expectedBaseSha && receipt.data.github?.base_sha !== expectedBaseSha) ||
    (expectedBaseSha && gitShaValue(architectRun.workspaceBaseSha) !== expectedBaseSha) ||
    (architectRun.agentDefId && receipt.data.agent_id !== architectRun.agentDefId)
  ) {
    return invalid("builder_plan_context_invalid", "architect_receipt_context_invalid");
  }

  const currentBaseSha = gitShaValue(input.freshnessEvidence?.baseSha);
  const currentIssueRevision = sha256Value(input.freshnessEvidence?.issueRevisionSha256);
  const checkedAt = stringValue(input.freshnessEvidence?.checkedAt);
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : Number.NaN;
  const now = Date.now();
  if (
    !expectedBaseSha ||
    !expectedIssueRevision ||
    !currentBaseSha ||
    !currentIssueRevision ||
    !checkedAt ||
    !Number.isFinite(checkedAtMs) ||
    checkedAtMs < now - FRESHNESS_EVIDENCE_MAX_AGE_MS ||
    checkedAtMs > now + FRESHNESS_EVIDENCE_FUTURE_SKEW_MS
  ) {
    return invalid("builder_plan_freshness_unavailable", "freshness_evidence_missing");
  }
  // Legacy Architect proposals did not persist a plan digest. They remain
  // distinguishable as freshness-unavailable when they also predate the
  // trusted base/issue envelope, but no otherwise-complete envelope may omit it.
  if (recordedPlanSha256 === undefined) {
    return invalid("builder_plan_context_invalid", "plan_hash_missing");
  }
  if (currentBaseSha !== expectedBaseSha || currentIssueRevision !== expectedIssueRevision) {
    return invalid("builder_plan_stale", "base_or_issue_revision_changed");
  }
  return { valid: true };
}

function architectReceiptMode(mode: string): "architect" | null {
  const canonical = mode.replaceAll("_", "-");
  return canonical === "architect" || canonical.endsWith("-architect") ? "architect" : null;
}

export async function architectRunIdentityValid(
  db: FacilityDb,
  architectRun: typeof runs.$inferSelect,
): Promise<boolean> {
  const mode = architectRun.mode.replaceAll("_", "-");
  if (mode !== "architect" && !mode.endsWith("-architect")) return false;
  if (!architectRun.agentDefId) return true;
  const agent = (
    await db
      .select({ name: agentDefs.name })
      .from(agentDefs)
      .where(
        and(
          eq(agentDefs.orgId, architectRun.orgId),
          eq(agentDefs.projectId, architectRun.projectId),
          eq(agentDefs.id, architectRun.agentDefId),
        ),
      )
      .limit(1)
  )[0];
  const name = agent?.name.replaceAll("_", "-");
  return Boolean(name && (name === "architect" || name.endsWith("-architect")));
}

function invalid(code: BuilderPlanDenialCode, reason?: string): AcceptanceValidation {
  return { valid: false, code, reason: reason ?? code };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sha256Value(value: unknown): string | null {
  const candidate = stringValue(value);
  return candidate && /^[a-f0-9]{64}$/i.test(candidate) ? candidate.toLowerCase() : null;
}

function gitShaValue(value: unknown): string | null {
  const candidate = stringValue(value);
  return candidate && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}
