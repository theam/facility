import { createHash } from "node:crypto";
import { newId } from "@facility/core";
import {
  agentDefs,
  type FacilityDb,
  inboundEvents,
  integrations,
  projects,
  runEvents,
  runs,
} from "@facility/db";
import { and, eq } from "drizzle-orm";
import { withBuilderPlanPreflight } from "../builder-plan-policy.js";
import { ApiError } from "../errors.js";
import {
  type IssueSeverity,
  normalizeSeverity,
  PlatformIssueScopeMismatchError,
  raisePlatformIssue,
} from "../watchtower/issues.js";
import { applyFacilitySignal, FacilitySignalSchema } from "./signals.js";

type Enqueue = (queue: string, data: Record<string, unknown>) => Promise<unknown>;

export async function processGenericInboundEvent(
  db: FacilityDb,
  inboundEventId: string,
  enqueue?: Enqueue,
) {
  const row = (
    await db
      .select({ event: inboundEvents, integration: integrations })
      .from(inboundEvents)
      .innerJoin(integrations, eq(inboundEvents.integrationId, integrations.id))
      .where(eq(inboundEvents.id, inboundEventId))
      .limit(1)
  )[0];
  if (!row || row.event.processedAt) return null;

  try {
    const payload = objectOrEmpty(row.event.payload);
    const config = objectOrEmpty(row.integration.config);
    const projectId = await resolveProjectId(
      db,
      row.event.orgId,
      row.integration.projectId,
      payload,
      config,
    );
    const signalCandidate = objectOrEmpty(payload.signal).schema ? payload.signal : payload;
    const isTypedSignal = objectOrEmpty(signalCandidate).schema === "facility.signal.v1";
    const issue = isTypedSignal
      ? (
          await applyFacilitySignal(db, {
            orgId: row.event.orgId,
            projectId,
            signal: FacilitySignalSchema.parse(signalCandidate),
            fallbackFingerprint: fallbackFingerprint(
              row.integration.id,
              row.event.eventType,
              payload,
            ),
            ...(projectId ? { issueScope: { projectId } } : {}),
          })
        ).issue
      : await raiseLegacyIssue(
          db,
          row.event.orgId,
          projectId,
          row.integration.id,
          row.integration.name,
          row.event.eventType,
          payload,
        );
    const run = await maybeEnqueueRun(db, row.event, row.integration, payload, config, enqueue);
    await db
      .update(inboundEvents)
      .set({ processedAt: new Date() })
      .where(eq(inboundEvents.id, inboundEventId));
    return { issue, run };
  } catch (error) {
    const failure =
      error instanceof PlatformIssueScopeMismatchError
        ? new ApiError(
            400,
            "generic_inbound_fingerprint_scope_mismatch",
            "Inbound fingerprints cannot target an issue in another project",
          )
        : error;
    await db
      .update(inboundEvents)
      .set({ error: failure instanceof Error ? failure.message : "unknown error" })
      .where(eq(inboundEvents.id, inboundEventId));
    throw failure;
  }
}

async function raiseLegacyIssue(
  db: FacilityDb,
  orgId: string,
  projectId: string | null,
  integrationId: string,
  integrationName: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  return raisePlatformIssue(
    db,
    {
      orgId,
      projectId,
      kind: stringField(payload.issue, "kind") ?? stringField(payload, "kind") ?? "generic_inbound",
      severity: severityField(payload.issue) ?? severityField(payload) ?? "warn",
      fingerprint:
        stringField(payload.issue, "fingerprint") ??
        stringField(payload, "fingerprint") ??
        fallbackFingerprint(integrationId, eventType, payload),
      title:
        stringField(payload.issue, "title") ??
        stringField(payload, "title") ??
        `${integrationName} inbound event`,
      bodyMd:
        stringField(payload.issue, "bodyMd") ??
        stringField(payload.issue, "body") ??
        stringField(payload, "bodyMd") ??
        stringField(payload, "body") ??
        "Generic inbound payload received.",
    },
    projectId ? { projectId } : undefined,
  );
}

async function resolveProjectId(
  db: FacilityDb,
  orgId: string,
  integrationProjectId: string | null,
  payload: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const projectId = selectInboundProjectId(integrationProjectId, payload, config);
  if (!projectId) return null;
  const project = (
    await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)))
      .limit(1)
  )[0];
  if (!project) {
    throw new ApiError(400, "generic_inbound_project_not_found", "Inbound project was not found");
  }
  return project.id;
}

export function selectInboundProjectId(
  integrationProjectId: string | null,
  payload: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const requestedProjectId =
    stringField(payload.signal, "projectId") ??
    stringField(payload.issue, "projectId") ??
    stringField(payload, "projectId") ??
    stringField(config, "projectId");
  if (integrationProjectId && requestedProjectId && requestedProjectId !== integrationProjectId) {
    throw new ApiError(
      400,
      "generic_inbound_project_scope_mismatch",
      "Project-scoped integrations cannot target another project",
    );
  }
  return integrationProjectId ?? requestedProjectId ?? null;
}

async function maybeEnqueueRun(
  db: FacilityDb,
  event: typeof inboundEvents.$inferSelect,
  integration: typeof integrations.$inferSelect,
  payload: Record<string, unknown>,
  config: Record<string, unknown>,
  enqueue?: Enqueue,
) {
  const runConfig = objectOrEmpty(payload.run);
  const shouldRun = config.enqueueRun === true || runConfig.enqueue === true;
  if (!shouldRun) return null;
  const projectId = await resolveProjectId(db, event.orgId, integration.projectId, payload, config);
  if (!projectId) throw new Error("generic_inbound_run_project_required");
  const agent = await resolveAgent(db, event.orgId, projectId, runConfig, config);
  const mode = stringField(runConfig, "mode") ?? stringField(config, "mode") ?? agent.name;
  const engine = stringField(runConfig, "engine") ?? stringField(config, "engine") ?? agent.engine;
  const trigger = {
    type: "generic_inbound",
    integrationId: integration.id,
    inboundEventId: event.id,
    eventType: event.eventType,
  };
  const run = (
    await withBuilderPlanPreflight(
      db,
      {
        orgId: event.orgId,
        projectId,
        mode,
        agentDefId: agent.id,
        trigger,
        actor: { type: "system", id: `integration:${integration.id}` },
        source: "generic_inbound",
      },
      (tx, admission) =>
        tx
          // builder-plan-preflight: inbound_dispatch
          .insert(runs)
          .values({
            id: newId("run"),
            orgId: event.orgId,
            projectId,
            agentDefId: agent.id,
            mode: admission.mode,
            engine,
            trigger,
            createdBy: { type: "system", id: `integration:${integration.id}` },
          })
          .returning(),
    )
  )[0];
  if (!run) throw new Error("generic_inbound_run_insert_failed");
  await db.insert(runEvents).values({
    orgId: event.orgId,
    runId: run.id,
    seq: 1,
    type: "queued",
    data: { queue: "runs.dispatch" },
  });
  await enqueue?.("runs.dispatch", { runId: run.id, orgId: event.orgId });
  return run;
}

async function resolveAgent(
  db: FacilityDb,
  orgId: string,
  projectId: string,
  runConfig: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  const agentDefId = stringField(runConfig, "agentDefId") ?? stringField(config, "agentDefId");
  if (agentDefId) {
    const agent = (
      await db.select().from(agentDefs).where(eq(agentDefs.id, agentDefId)).limit(1)
    )[0];
    if (!agent || agent.orgId !== orgId || agent.projectId !== projectId || !agent.enabled) {
      throw new Error("generic_inbound_agent_not_found");
    }
    return agent;
  }
  const agentName = stringField(runConfig, "agent") ?? stringField(config, "agent");
  if (!agentName) throw new Error("generic_inbound_agent_required");
  const agents = await db
    .select()
    .from(agentDefs)
    .where(
      and(
        eq(agentDefs.orgId, orgId),
        eq(agentDefs.projectId, projectId),
        eq(agentDefs.enabled, true),
      ),
    );
  const agent = agents.find((row) => row.name === agentName);
  if (!agent) throw new Error("generic_inbound_agent_not_found");
  return agent;
}

function fallbackFingerprint(
  integrationId: string,
  eventType: string,
  payload: Record<string, unknown>,
) {
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `generic_inbound:${integrationId}:${eventType}:${digest}`;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string | undefined {
  const object = objectOrEmpty(value);
  const raw = object[key];
  return typeof raw === "string" && raw.trim() ? raw : undefined;
}

function severityField(value: unknown): IssueSeverity | undefined {
  const raw = stringField(value, "severity");
  return raw ? normalizeSeverity(raw) : undefined;
}
