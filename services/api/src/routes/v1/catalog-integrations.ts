import {
  ALL_PERMISSIONS,
  MODEL_PRICES_USD_PER_1M,
  PERMISSION_RESOURCES,
  SPECIAL_PERMISSIONS,
} from "@facility/core";
import { agentDefs, integrations, registryItems, runs } from "@facility/db";
// Default-import: cron-parser is CJS and its named exports aren't statically
// visible to Node's ESM loader (tsx runs the openapi script in real ESM mode).
import cronParser from "cron-parser";
import { and, desc, eq, gte, inArray, isNotNull, notInArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TERMINAL_RUN_STATUSES } from "../../sandbox/state.js";
import {
  AnyObject,
  assertProjectScope,
  DateValue,
  IdParams,
  principal,
  type V1RouteContext,
} from "./shared.js";

/**
 * The semantic backbone of the control plane UI: what the platform knows
 * (catalog) and how the engine is doing (per-agent status). Integration
 * lifecycle routes live in integrations.ts so the API has one authoritative
 * implementation for secrets, project scope, delivery history, and events.
 */

const CatalogSchema = z.object({
  engines: z.array(z.object({ id: z.string(), label: z.string(), note: z.string() })),
  models: z.array(
    z.object({
      id: z.string(),
      provider: z.string(),
      inputPer1M: z.number(),
      outputPer1M: z.number(),
    }),
  ),
  permissions: z.object({
    resources: z.array(z.string()),
    special: z.array(z.string()),
    all: z.array(z.string()),
  }),
  triggerTypes: z.array(z.object({ type: z.string(), label: z.string(), note: z.string() })),
});

const AgentRunRef = z.object({
  id: z.string(),
  status: z.string(),
  queuedAt: DateValue,
  endedAt: DateValue.nullable(),
  costCents: z.number().nullable(),
  prUrl: z.string().nullable(),
});

const AgentStatusSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  engine: z.string(),
  model: AnyObject,
  contractItemId: z.string(),
  contractName: z.string().nullable(),
  description: z.string().nullable(),
  triggers: z.array(AnyObject),
  schedule: z
    .object({ cron: z.string(), timezone: z.string().nullable(), source: z.string() })
    .nullable(),
  nextRunAt: DateValue.nullable(),
  lastRun: AgentRunRef.nullable(),
  liveRun: z.object({ id: z.string(), status: z.string() }).nullable(),
  counts14d: z.object({
    total: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    canceled: z.number(),
    awaitingHuman: z.number(),
  }),
  prCount14d: z.number(),
  eventBindings: z.array(
    z.object({
      integrationId: z.string(),
      name: z.string(),
      kind: z.string(),
      enabled: z.boolean(),
      dispatchesRuns: z.boolean(),
    }),
  ),
});

const ENGINES = [
  {
    id: "claude_code",
    label: "Claude Code",
    note: "Anthropic engine — resumable sessions, steering, conversations",
  },
  { id: "codex", label: "Codex", note: "OpenAI GPT-5.5 engine for batch implementation" },
  { id: "byo", label: "Bring your own", note: "your image, your engine — governed I/O only" },
] as const;

// Only trigger paths that actually dispatch today. Adding an entry here
// without a wired dispatcher violates the control-plane honesty rule.
const TRIGGER_TYPES = [
  {
    type: "schedule",
    label: "On a schedule",
    note: "the scheduler arms on save and dispatches at each occurrence",
  },
  {
    type: "manual",
    label: "On demand",
    note: "run now from the agent page, or trigger from an issue",
  },
  {
    type: "generic_inbound",
    label: "Integration event",
    note: "an enabled integration routes inbound events to this agent",
  },
  {
    type: "github_command",
    label: "GitHub slash command",
    note: "issue/PR comment naming the agent on a connected repo",
  },
] as const;

function modelProvider(id: string): string {
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gpt")) return "openai";
  return "custom";
}

type ScheduleShape = { cron: string; timezone: string | null };

function scheduleTriggersOf(triggers: unknown): ScheduleShape[] {
  if (!Array.isArray(triggers)) return [];
  return triggers.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const trigger = candidate as { type?: unknown; config?: unknown };
    if (trigger.type !== "schedule" || !trigger.config || typeof trigger.config !== "object")
      return [];
    const config = trigger.config as { cron?: unknown; timezone?: unknown };
    if (typeof config.cron !== "string") return [];
    return [
      { cron: config.cron, timezone: typeof config.timezone === "string" ? config.timezone : null },
    ];
  });
}

function nextOccurrence(schedule: ScheduleShape, now: Date): Date | null {
  try {
    return cronParser
      .parseExpression(schedule.cron, {
        currentDate: now,
        tz: schedule.timezone ?? "UTC",
      })
      .next()
      .toDate();
  } catch {
    return null;
  }
}

function runCostCents(receipt: unknown): number | null {
  if (!receipt || typeof receipt !== "object") return null;
  const usage = (receipt as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const cents = (usage as { cost_cents?: unknown }).cost_cents;
  return typeof cents === "number" ? cents : null;
}

function runPrUrl(gh: unknown): string | null {
  if (!gh || typeof gh !== "object") return null;
  const pr = (gh as { pr?: unknown }).pr;
  if (typeof pr === "string") return pr;
  if (pr && typeof pr === "object" && typeof (pr as { url?: unknown }).url === "string") {
    return (pr as { url: string }).url;
  }
  return null;
}

// The bespoke learning.nightly packet job owns learning agents (it assembles
// a daily packet first); their real fire time is its cron, not their trigger.
const LEARNING_NIGHTLY_CRON = "0 3 * * *";

export async function registerCatalogIntegrationsRoutes(
  app: FastifyInstance,
  context: V1RouteContext,
) {
  const { db } = context;

  app.get(
    "/v1/catalog",
    {
      config: { permission: "org:read" },
      schema: { response: { 200: CatalogSchema } },
    },
    async () => ({
      engines: [...ENGINES],
      models: Object.entries(MODEL_PRICES_USD_PER_1M)
        .filter(([id]) => id !== "custom")
        .map(([id, price]) => ({
          id,
          provider: modelProvider(id),
          inputPer1M: price.input,
          outputPer1M: price.output,
        })),
      permissions: {
        resources: [...PERMISSION_RESOURCES],
        special: [...SPECIAL_PERMISSIONS],
        all: [...ALL_PERMISSIONS],
      },
      triggerTypes: [...TRIGGER_TYPES],
    }),
  );

  app.get(
    "/v1/projects/:projectId/agents/status",
    {
      config: { permission: "agents:read" },
      schema: { params: IdParams, response: { 200: z.array(AgentStatusSchema) } },
    },
    async (request) => {
      const p = principal(request);
      const { projectId } = request.params as { projectId: string };
      assertProjectScope(p, projectId);
      const now = new Date();
      const since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      const agents = await db
        .select()
        .from(agentDefs)
        .where(and(eq(agentDefs.orgId, p.orgId), eq(agentDefs.projectId, projectId)));
      if (agents.length === 0) return [];

      const contractIds = [...new Set(agents.map((agent) => agent.contractItemId))];
      const contracts = await db
        .select({
          id: registryItems.id,
          name: registryItems.name,
          description: registryItems.description,
        })
        .from(registryItems)
        .where(and(eq(registryItems.orgId, p.orgId), inArray(registryItems.id, contractIds)));
      const contractById = new Map(contracts.map((row) => [row.id, row]));

      const windowRuns = await db
        .select({
          id: runs.id,
          agentDefId: runs.agentDefId,
          status: runs.status,
          gh: runs.gh,
        })
        .from(runs)
        .where(
          and(
            eq(runs.orgId, p.orgId),
            eq(runs.projectId, projectId),
            isNotNull(runs.agentDefId),
            gte(runs.queuedAt, since),
          ),
        );

      const latestRuns = await db
        .selectDistinctOn([runs.agentDefId], {
          id: runs.id,
          agentDefId: runs.agentDefId,
          status: runs.status,
          queuedAt: runs.queuedAt,
          endedAt: runs.endedAt,
          receipt: runs.receipt,
          gh: runs.gh,
        })
        .from(runs)
        .where(
          and(eq(runs.orgId, p.orgId), eq(runs.projectId, projectId), isNotNull(runs.agentDefId)),
        )
        .orderBy(runs.agentDefId, desc(runs.queuedAt));
      const latestByAgent = new Map(latestRuns.map((row) => [row.agentDefId, row]));

      const liveRuns = await db
        .select({ id: runs.id, agentDefId: runs.agentDefId, status: runs.status })
        .from(runs)
        .where(
          and(
            eq(runs.orgId, p.orgId),
            eq(runs.projectId, projectId),
            isNotNull(runs.agentDefId),
            notInArray(runs.status, [...TERMINAL_RUN_STATUSES]),
          ),
        );
      const liveByAgent = new Map(liveRuns.map((row) => [row.agentDefId, row]));

      const orgIntegrations = await db
        .select()
        .from(integrations)
        .where(eq(integrations.orgId, p.orgId));

      return agents.map((agent) => {
        const contract = contractById.get(agent.contractItemId);
        const schedules = scheduleTriggersOf(agent.triggers);
        const isLearning = agent.name === "learning";
        const schedule: (ScheduleShape & { source: string }) | null = isLearning
          ? { cron: LEARNING_NIGHTLY_CRON, timezone: "UTC", source: "learning-nightly" }
          : schedules.length > 0 && schedules[0]
            ? { ...schedules[0], source: "triggers" }
            : null;
        const nextRunAt =
          agent.enabled && schedule
            ? isLearning
              ? nextOccurrence(schedule, now)
              : (schedules
                  .map((candidate) => nextOccurrence(candidate, now))
                  .filter((date): date is Date => date !== null)
                  .sort((a, b) => a.getTime() - b.getTime())[0] ?? null)
            : null;

        const mine = windowRuns.filter((run) => run.agentDefId === agent.id);
        const counts14d = {
          total: mine.length,
          succeeded: mine.filter((run) => run.status === "succeeded").length,
          failed: mine.filter((run) => run.status === "failed").length,
          canceled: mine.filter((run) => run.status === "canceled").length,
          awaitingHuman: mine.filter((run) => run.status === "awaiting_human").length,
        };
        const prCount14d = mine.filter((run) => runPrUrl(run.gh) !== null).length;

        const latest = latestByAgent.get(agent.id);
        const live = liveByAgent.get(agent.id);

        const eventBindings = orgIntegrations
          .filter((integration) => {
            const cfg =
              integration.config && typeof integration.config === "object"
                ? (integration.config as Record<string, unknown>)
                : {};
            if (cfg.projectId && cfg.projectId !== projectId) return false;
            return cfg.agentDefId === agent.id || cfg.agent === agent.name;
          })
          .map((integration) => ({
            integrationId: integration.id,
            name: integration.name,
            kind: integration.kind,
            enabled: integration.enabled,
            dispatchesRuns:
              !!integration.config &&
              typeof integration.config === "object" &&
              (integration.config as { enqueueRun?: unknown }).enqueueRun === true,
          }));

        return {
          agentId: agent.id,
          name: agent.name,
          enabled: agent.enabled,
          engine: agent.engine,
          model:
            agent.model && typeof agent.model === "object"
              ? (agent.model as Record<string, unknown>)
              : {},
          contractItemId: agent.contractItemId,
          contractName: contract?.name ?? null,
          description: contract?.description ?? null,
          triggers: Array.isArray(agent.triggers)
            ? (agent.triggers as Record<string, unknown>[])
            : [],
          schedule,
          nextRunAt,
          lastRun: latest
            ? {
                id: latest.id,
                status: latest.status,
                queuedAt: latest.queuedAt,
                endedAt: latest.endedAt,
                costCents: runCostCents(latest.receipt),
                prUrl: runPrUrl(latest.gh),
              }
            : null,
          liveRun: live ? { id: live.id, status: live.status } : null,
          counts14d,
          prCount14d,
          eventBindings,
        };
      });
    },
  );
}
